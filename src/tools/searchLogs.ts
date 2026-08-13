import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type AppConfig, type LimitsConfig, type ServerConfig } from "../server/config.js";
import { ConcurrencyLimiter, SshExecutor } from "../ssh/connection.js";
import { searchMultipleServers } from "../logs/multiSearch.js";
import { enrichMatchesWithContext, type MatchWithContext, type TimeWindow } from "../logs/context.js";
import { resolveTimeWindow } from "../logs/timestamps.js";
import { extractRequestParameters } from "../parsers/request.js";
import { extractResponse } from "../parsers/response.js";
import { extractMyBatisSql, type SqlExtraction } from "../parsers/mybatisSql.js";
import { extractExceptions, type ExceptionExtraction } from "../parsers/exception.js";
import { analyzeBasics } from "../analyzer/basic.js";
import { maskDeep } from "../security/sanitize.js";
import { validateKeyword } from "../security/shellGuard.js";

/**
 * Input schema for the search_logs tool.
 * Only `keyword` is required; everything else has sensible defaults.
 */
export const searchLogsInputSchema = {
	keyword: z
		.string()
		.min(1)
		.max(200)
		.describe("Log keyword to search for, e.g. a method name or business id"),
	environment: z
		.string()
		.max(50)
		.optional()
		.describe("Environment filter, e.g. prod / staging. Defaults to all environments"),
	serverNames: z
		.array(z.string().max(100))
		.max(20)
		.optional()
		.describe("Restrict the search to these configured server names"),
	startTime: z
		.string()
		.optional()
		.describe("ISO 8601 start time, e.g. 2026-08-13T10:00:00+08:00. Defaults to 30 minutes before endTime"),
	endTime: z
		.string()
		.optional()
		.describe("ISO 8601 end time. Defaults to now"),
	contextBefore: z
		.number()
		.int()
		.min(0)
		.max(500)
		.default(30)
		.describe("Number of log lines to return before each match"),
	contextAfter: z
		.number()
		.int()
		.min(0)
		.max(500)
		.default(50)
		.describe("Number of log lines to return after each match")
};

export type SearchLogsInput = z.infer<
	z.ZodObject<{
		[K in keyof typeof searchLogsInputSchema]: (typeof searchLogsInputSchema)[K];
	}>
>;

/** Extraction results annotated with where they were found. */
export interface LocatedRequest {
	server: string;
	environment: string;
	logFile: string;
	detectedMarker: string | null;
	parameters: unknown | null;
	rawSource: string | null;
}

export interface LocatedResponse {
	server: string;
	environment: string;
	logFile: string;
	detectedMarker: string | null;
	body: unknown | null;
	responseTruncated: boolean;
}

export interface LocatedSql extends SqlExtraction {
	server: string;
	logFile: string;
}

export interface LocatedException extends ExceptionExtraction {
	server: string;
	logFile: string;
}

/** Injectable seams so the pipeline can be tested without real SSH. */
export interface SearchLogsDependencies {
	loadConfiguration?: () => AppConfig;
	createExecutor?: (server: ServerConfig, limits: LimitsConfig, limiter: ConcurrencyLimiter) => SshExecutor;
}

/**
 * Run the whole search_logs pipeline:
 * config → multi-server grep → context + time filter → parsers → analysis → masking.
 *
 * Nothing here is ever returned to the client without passing through
 * `maskDeep` (sensitive value masking) at the very end.
 */
export async function runSearchLogs(
	args: SearchLogsInput,
	deps: SearchLogsDependencies = {}
): Promise<Record<string, unknown>> {
	const config = (deps.loadConfiguration ?? loadConfig)();
	validateKeyword(args.keyword);

	const { startMs, endMs } = resolveTimeWindow(args.startTime, args.endTime);
	const timeWindow: TimeWindow = {
		startMs,
		endMs,
		// Zone-less log timestamps are assumed to be in the local zone of the
		// machine running this server (usually the same zone as the fleet).
		localOffsetMs: -new Date().getTimezoneOffset() * 60_000
	};

	// One shared limiter + one executor per server so search and context
	// enrichment reuse the same objects (and respect the connection cap).
	const limiter = new ConcurrencyLimiter(config.limits.maxConcurrentConnections);
	const executors = new Map<string, SshExecutor>();
	const executorFor = (server: ServerConfig): SshExecutor => {
		let executor = executors.get(server.name);
		if (!executor) {
			executor =
				deps.createExecutor?.(server, config.limits, limiter) ??
				new SshExecutor(server, config.limits, limiter);
			executors.set(server.name, executor);
		}
		return executor;
	};

	const multi = await searchMultipleServers(
		config,
		{
			keyword: args.keyword,
			environment: args.environment,
			serverNames: args.serverNames,
			maxMatchesPerServer: config.limits.maxLines
		},
		executorFor
	);

	// Enrich matches with context, grouped by server, and apply the time window.
	const enriched: MatchWithContext[] = [];
	const contextErrors: string[] = [];
	let droppedByTime = 0;
	let missingContext = 0;
	for (const result of multi.results) {
		if (result.matches.length === 0) continue;
		const server = config.servers.find((s) => s.name === result.server);
		if (!server) continue;
		const ctx = await enrichMatchesWithContext(
			executorFor(server),
			server,
			config.limits,
			result.matches,
			args.contextBefore,
			args.contextAfter,
			timeWindow
		);
		enriched.push(...ctx.enriched);
		droppedByTime += ctx.droppedByTime;
		missingContext += ctx.missingContext;
		contextErrors.push(...ctx.errors);
	}

	// Global match cap so a very noisy keyword cannot flood the AI client.
	const matchesTruncated = enriched.length > config.limits.maxLines;
	const kept = enriched.slice(0, config.limits.maxLines);

	// Run all parsers over each match's local block (before + match + after).
	const requestParameters: LocatedRequest[] = [];
	const responses: LocatedResponse[] = [];
	const sql: LocatedSql[] = [];
	const exceptions: LocatedException[] = [];
	const seen = {
		request: new Set<string>(),
		response: new Set<string>(),
		sql: new Set<string>(),
		exception: new Set<string>()
	};

	for (const match of kept) {
		const block = [...match.contextBefore, match.matchedLine, ...match.contextAfter];

		const req = extractRequestParameters(block);
		if (req.detectedMarker !== null) {
			const key = req.rawSource ?? JSON.stringify(req.parameters);
			if (!seen.request.has(key)) {
				seen.request.add(key);
				requestParameters.push({
					server: match.server,
					environment: match.environment,
					logFile: match.logFile,
					detectedMarker: req.detectedMarker,
					parameters: req.parameters,
					rawSource: req.rawSource
				});
			}
		}

		const res = extractResponse(block);
		if (res.detectedMarker !== null) {
			const key = JSON.stringify(res.body).slice(0, 500);
			if (!seen.response.has(key)) {
				seen.response.add(key);
				responses.push({
					server: match.server,
					environment: match.environment,
					logFile: match.logFile,
					detectedMarker: res.detectedMarker,
					body: res.body,
					responseTruncated: res.responseTruncated
				});
			}
		}

		for (const extraction of extractMyBatisSql(block)) {
			const key = `${extraction.preparingSql}::${extraction.rawParameters}`;
			if (!seen.sql.has(key)) {
				seen.sql.add(key);
				sql.push({ server: match.server, logFile: match.logFile, ...extraction });
			}
		}

		for (const extraction of extractExceptions(block)) {
			const key = `${extraction.type}::${extraction.message}`;
			if (!seen.exception.has(key)) {
				seen.exception.add(key);
				exceptions.push({ server: match.server, logFile: match.logFile, ...extraction });
			}
		}
	}

	const searchErrors: string[] = [
		...multi.failures.map((f) => `${f.server}: ${f.error}`),
		...multi.results.flatMap((r) => r.errors),
		...contextErrors
	];

	const analysis = analyzeBasics({
		keyword: args.keyword,
		matchCount: kept.length,
		exceptions,
		sql,
		requestDetected: requestParameters.length > 0,
		responseDetected: responses.length > 0,
		searchErrors
	});

	const payload = {
		status: "success",
		query: {
			keyword: args.keyword,
			environment: args.environment ?? null,
			serverNames: args.serverNames ?? null,
			startTime: new Date(startMs).toISOString(),
			endTime: new Date(endMs).toISOString(),
			contextBefore: args.contextBefore,
			contextAfter: args.contextAfter,
			searchedServers: multi.searchedServers,
			skippedServers: multi.skippedServers,
			serverLimitTruncated: multi.truncated
		},
		matches: kept.map((match) => ({
			server: match.server,
			environment: match.environment,
			logFile: match.logFile,
			// Line number inside the scanned tail window (1-based), not the
			// absolute file line — the scan never reads the whole file.
			lineNumber: match.lineInWindow,
			timestamp: match.timestamp,
			matchedLine: match.matchedLine,
			contextBefore: match.contextBefore,
			contextAfter: match.contextAfter
		})),
		matchesTruncated,
		// null = not detected. Never fabricated.
		requestParameters: requestParameters.length > 0 ? requestParameters : null,
		response: responses.length > 0 ? responses : null,
		sql: sql.length > 0 ? sql : null,
		exceptions: exceptions.length > 0 ? exceptions : null,
		analysis,
		notes: {
			droppedByTime,
			missingContext,
			searchErrors
		}
	};

	// Single exit point: every string/structure is masked before serialization.
	return maskDeep(payload);
}

/**
 * Register the single MVP tool: search_logs.
 *
 * Security note: this server exposes NO arbitrary shell execution tool.
 * Remote commands are built only from fixed, read-only templates with
 * strictly validated and quoted arguments (see ssh/ and security/ modules).
 */
export function registerSearchLogsTool(server: McpServer, deps: SearchLogsDependencies = {}): void {
	server.registerTool(
		"search_logs",
		{
			title: "Search Server Logs",
			description:
				"Search application logs on configured remote servers by keyword over SSH (read-only). " +
				"Returns matched log lines with surrounding context, extracted request parameters, " +
				"response body, MyBatis SQL, exceptions and a basic cause analysis. " +
				"If no time range is given, the last 30 minutes are searched.",
			inputSchema: searchLogsInputSchema
		},
		async (args) => {
			try {
				const payload = await runSearchLogs(args, deps);
				return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [
						{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }
					]
				};
			}
		}
	);
}
