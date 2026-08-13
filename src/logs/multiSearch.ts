import type { AppConfig, ServerConfig } from "../server/config.js";
import { ConcurrencyLimiter, SshExecutor } from "../ssh/connection.js";
import { searchSingleServer, type LogMatch, type SingleServerSearchResult } from "./search.js";

/**
 * 多服务器搜索编排。
 *
 * - 按环境和/或显式服务器名过滤已配置的服务器。
 * - 强制执行 limits.maxServers（单次查询上限）。
 * - 并发执行搜索，受 limits.maxConcurrentConnections 约束
 *   （共享的 ConcurrencyLimiter 限制实际的 SSH 连接数）。
 */

export interface MultiServerQuery {
	keyword: string;
	environment?: string;
	serverNames?: string[];
	/** 本次查询的单服务器命中上限。 */
	maxMatchesPerServer: number;
	/** 指定时只搜索该日志文件名。 */
	logFileName?: string;
	archiveDateDirectories?: string[];
	includeCurrentLogs?: boolean;
}

export interface MultiServerResult {
	/** 实际被搜索的服务器。 */
	searchedServers: string[];
	/** 因环境/名称过滤被跳过的服务器。 */
	skippedServers: string[];
	/** 命中过滤条件的服务器超过 limits.maxServers 时为 true。 */
	truncated: boolean;
	results: SingleServerSearchResult[];
	/** 完全失败的服务器（连接错误等）。 */
	failures: Array<{ server: string; error: string }>;
	matches: LogMatch[];
}

/** 对已配置的服务器列表应用环境 / serverNames 过滤。 */
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
 * 在多台服务器上并发搜索关键词。
 * 执行器构造可注入，便于测试。
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
					maxMatches: query.maxMatchesPerServer,
					logFileName: query.logFileName,
					archiveDateDirectories: query.archiveDateDirectories,
					includeCurrentLogs: query.includeCurrentLogs
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

/** 按 limits 对象缓存 limiter，使所有执行器共享同一个并发上限。 */
const limiterCache = new WeakMap<AppConfig["limits"], ConcurrencyLimiter>();

function sharedLimiter(config: AppConfig): ConcurrencyLimiter {
	let limiter = limiterCache.get(config.limits);
	if (!limiter) {
		limiter = new ConcurrencyLimiter(config.limits.maxConcurrentConnections);
		limiterCache.set(config.limits, limiter);
	}
	return limiter;
}
