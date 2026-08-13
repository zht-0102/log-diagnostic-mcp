import type { AppConfig, ServerConfig } from "../server/config.js";
import { ConcurrencyLimiter, SshExecutor } from "../ssh/connection.js";
import { searchSingleServer, type LogMatch, type SingleServerSearchResult } from "./search.js";

/**
 * Multi-server search orchestration.
 *
 * - Filters configured servers by environment and/or explicit names.
 * - Enforces limits.maxServers per query.
 * - Runs searches concurrently, bounded by limits.maxConcurrentConnections
 *   (the shared ConcurrencyLimiter bounds actual SSH connections).
 */

export interface MultiServerQuery {
	keyword: string;
	environment?: string;
	serverNames?: string[];
	/** Per-server match cap for this query. */
	maxMatchesPerServer: number;
}

export interface MultiServerResult {
	/** Servers that were actually searched. */
	searchedServers: string[];
	/** Servers skipped because of environment/name filters. */
	skippedServers: string[];
	/** True when more servers matched the filters than limits.maxServers. */
	truncated: boolean;
	results: SingleServerSearchResult[];
	/** Servers that failed completely (connection errors etc). */
	failures: Array<{ server: string; error: string }>;
	matches: LogMatch[];
}

/** Apply environment / serverNames filters to the configured server list. */
export function selectServers(
	servers: ServerConfig[],
	environment?: string,
	serverNames?: string[]
): { selected: ServerConfig[]; skipped: string[]; unknownNames: string[] } {
	let selected = servers;
	if (environment) {
		selected = selected.filter((s) => s.environment === environment);
	}
	if (serverNames && serverNames.length > 0) {
		const wanted = new Set(serverNames);
		const available = new Set(selected.map((s) => s.name));
		const unknownNames = serverNames.filter((name) => !available.has(name));
		selected = selected.filter((s) => wanted.has(s.name));
		return { selected, skipped: servers.filter((s) => !wanted.has(s.name)).map((s) => s.name), unknownNames };
	}
	return { selected, skipped: servers.filter((s) => !selected.includes(s)).map((s) => s.name), unknownNames: [] };
}

/**
 * Search multiple servers concurrently for a keyword.
 * Executor construction is injectable for testing.
 */
export async function searchMultipleServers(
	config: AppConfig,
	query: MultiServerQuery,
	executorFactory: (server: ServerConfig) => SshExecutor = (server) =>
		new SshExecutor(server, config.limits, sharedLimiter(config))
): Promise<MultiServerResult> {
	const { selected, skipped, unknownNames } = selectServers(
		config.servers,
		query.environment,
		query.serverNames
	);

	const failures: Array<{ server: string; error: string }> = [];
	for (const name of unknownNames) {
		failures.push({ server: name, error: `Unknown server name in configuration: ${name}` });
	}

	const truncated = selected.length > config.limits.maxServers;
	const toSearch = selected.slice(0, config.limits.maxServers);

	const settled = await Promise.allSettled(
		toSearch.map((server) =>
			searchSingleServer(executorFactory(server), server, config.limits, {
				keyword: query.keyword,
				maxMatches: query.maxMatchesPerServer
			})
		)
	);

	const results: SingleServerSearchResult[] = [];
	settled.forEach((outcome, index) => {
		const server = toSearch[index];
		if (outcome.status === "fulfilled") {
			results.push(outcome.value);
		} else {
			failures.push({
				server: server.name,
				error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
			});
		}
	});

	const matches = results.flatMap((r) => r.matches);

	return {
		searchedServers: toSearch.map((s) => s.name),
		skippedServers: skipped,
		truncated,
		results,
		failures,
		matches
	};
}

/** Cache one limiter per limits object so all executors share the cap. */
const limiterCache = new WeakMap<AppConfig["limits"], ConcurrencyLimiter>();

function sharedLimiter(config: AppConfig): ConcurrencyLimiter {
	let limiter = limiterCache.get(config.limits);
	if (!limiter) {
		limiter = new ConcurrencyLimiter(config.limits.maxConcurrentConnections);
		limiterCache.set(config.limits, limiter);
	}
	return limiter;
}
