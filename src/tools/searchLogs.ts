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
import {
	analyzeSaasEvent,
	buildSaasDiagnosticEvent,
	groupSaasEvents,
	summarizeSaasEvent
} from "../parsers/saasLog.js";
import { analyzeBasics } from "../analyzer/basic.js";
import { maskDeep } from "../security/sanitize.js";
import { validateKeyword } from "../security/shellGuard.js";

/**
 * search_logs 工具的输入 schema。
 * 只有 `keyword` 是必填项；其余都有合理默认值。
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
		.describe("Number of log lines to return after each match"),
	mode: z
		.enum(["lines", "saas_event"])
		.default("lines")
		.describe("Return plain matched lines or aggregate ShenNong SaaS log events"),
	logFileName: z
		.string()
		.regex(/^[\w.\-]+$/)
		.max(100)
		.optional()
		.describe("Restrict search to one log file name under each configured logPath. Defaults to saas.log in saas_event mode"),
	eventLimit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(10)
		.describe("Maximum SaaS events returned when mode is saas_event"),
	includeRawLines: z
		.boolean()
		.default(false)
		.describe("Include raw event lines when mode is saas_event")
};

export type SearchLogsInput = z.infer<
	z.ZodObject<{
		[K in keyof typeof searchLogsInputSchema]: (typeof searchLogsInputSchema)[K];
	}>
>;

/** 标注了发现位置的提取结果。 */
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

/** 可注入的替换点，使管道可以在不依赖真实 SSH 的情况下测试。 */
export interface SearchLogsDependencies {
	loadConfiguration?: () => AppConfig;
	createExecutor?: (server: ServerConfig, limits: LimitsConfig, limiter: ConcurrencyLimiter) => SshExecutor;
}

/**
 * 执行完整的 search_logs 管道：
 * 配置 → 多服务器 grep → 上下文 + 时间过滤 → 解析器 → 分析 → 脱敏。
 *
 * 这里返回的任何内容在最终出口前都必须经过
 * `maskDeep`（敏感值脱敏），绝无例外。
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
		// 不带时区的日志时间戳假定处于运行本服务的机器的本地时区
		// （通常与目标机器集群同区）。
		localOffsetMs: -new Date().getTimezoneOffset() * 60_000
	};

	// 共享一个限流器 + 每台服务器一个 executor，使搜索与上下文
	// 补全复用同一批对象（并遵守连接数上限）。
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
			maxMatchesPerServer: config.limits.maxLines,
			logFileName: args.logFileName ?? (args.mode === "saas_event" ? "saas.log" : undefined)
		},
		executorFor
	);

	// 按服务器分组为匹配项补全上下文，并应用时间窗口。
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

	// 全局匹配数上限，避免噪音关键词淹没 AI 客户端。
	const matchesTruncated = enriched.length > config.limits.maxLines;
	const kept = enriched.slice(0, config.limits.maxLines);

	// 对每个匹配的局部块（前文 + 匹配行 + 后文）跑全部解析器。
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

	const saasEvents =
		args.mode === "saas_event"
			? buildSaasEventPayload(kept, args.eventLimit, args.includeRawLines)
			: null;
	const diagnosticEvents =
		args.mode === "saas_event"
			? buildSaasDiagnosticPayload(kept, args.eventLimit)
			: null;

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
			mode: args.mode,
			logFileName: args.logFileName ?? (args.mode === "saas_event" ? "saas.log" : null),
			eventLimit: args.eventLimit,
			includeRawLines: args.includeRawLines,
			searchedServers: multi.searchedServers,
			skippedServers: multi.skippedServers,
			serverLimitTruncated: multi.truncated
		},
		matches: kept.map((match) => ({
			server: match.server,
			environment: match.environment,
			logFile: match.logFile,
			// 扫描尾部窗口内的行号（从 1 开始），不是文件的
			// 绝对行号 —— 扫描从不读取整个文件。
			lineNumber: match.lineInWindow,
			timestamp: match.timestamp,
			matchedLine: match.matchedLine,
			contextBefore: match.contextBefore,
			contextAfter: match.contextAfter
		})),
		matchesTruncated,
		// null = 未检测到。绝不捏造。
		requestParameters: requestParameters.length > 0 ? requestParameters : null,
		response: responses.length > 0 ? responses : null,
		sql: sql.length > 0 ? sql : null,
		exceptions: exceptions.length > 0 ? exceptions : null,
		saasEvents,
		diagnosticEvents,
		analysis,
		notes: {
			droppedByTime,
			missingContext,
			searchErrors
		}
	};

	// 唯一出口：所有字符串/结构在序列化前统一脱敏。
	return maskDeep(payload);
}

function findSourceForEvent(
	matches: MatchWithContext[],
	firstRawLine: string
): { server: string; environment: string; logFile: string } | null {
	for (const match of matches) {
		const block = [...match.contextBefore, match.matchedLine, ...match.contextAfter];
		if (block.includes(firstRawLine)) {
			return { server: match.server, environment: match.environment, logFile: match.logFile };
		}
	}
	return null;
}

function buildSaasDiagnosticPayload(
	matches: MatchWithContext[],
	eventLimit: number
): Array<Record<string, unknown>> {
	return groupSaasEvents(collectUniqueBlockLines(matches))
		.slice(0, eventLimit)
		.map((event) => {
			const summary = summarizeSaasEvent(event);
			const diagnosis = analyzeSaasEvent(event, summary);
			const diagnostic = buildSaasDiagnosticEvent(event, summary, diagnosis);
			const source = findSourceForEvent(matches, event.entries[0]?.line.raw ?? "");
			return {
				...diagnostic,
				trace: {
					...diagnostic.trace,
					server: source?.server ?? null,
					environment: source?.environment ?? null,
					logFile: source?.logFile ?? null
				}
			};
		});
}

function collectUniqueBlockLines(matches: MatchWithContext[]): string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		for (const line of [...match.contextBefore, match.matchedLine, ...match.contextAfter]) {
			if (seen.has(line)) continue;
			seen.add(line);
			lines.push(line);
		}
	}
	return lines;
}

function buildSaasEventPayload(
	matches: MatchWithContext[],
	eventLimit: number,
	includeRawLines: boolean
): Array<Record<string, unknown>> {
	return groupSaasEvents(collectUniqueBlockLines(matches))
		.slice(0, eventLimit)
		.map((event) => {
			const summary = summarizeSaasEvent(event);
			const diagnosis = analyzeSaasEvent(event, summary);
			return {
				key: event.key,
				traceId: event.traceId,
				thread: event.thread,
				startTime: event.startTime,
				endTime: event.endTime,
				durationMs: event.durationMs,
				levels: event.levels,
				loggers: event.loggers,
				entryCount: event.entries.length,
				payloads: summary.payloads,
				sql: summary.sql,
				tenant: summary.tenant,
				exceptions: summary.exceptions,
				keyMessages: summary.keyMessages,
				diagnosis,
				rawLines: includeRawLines ? event.entries.map((entry) => entry.line.raw) : undefined
			};
		});
}

/**
 * 注册唯一的 MVP 工具：search_logs。
 *
 * 安全说明：本服务不暴露任何任意 shell 执行工具。
 * 远程命令只由固定的只读模板构建，参数经过严格
 * 校验并加引号（见 ssh/ 与 security/ 模块）。
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
