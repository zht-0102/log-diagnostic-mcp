import type { ServerConfig, LimitsConfig } from "../server/config.js";
import type { SshExecutor } from "../ssh/connection.js";
import { buildGzipCatCommand, buildTailCommand } from "../ssh/commands.js";
import { isWithinWindow, parseLineTimestamp } from "./timestamps.js";
import type { LogMatch } from "./search.js";

/**
 * 物理上下文提取。
 *
 * 对每个包含命中的日志文件，只拉取一次扫描（tail）窗口，
 * 然后在本地为每个命中计算前/后切片 —— 这样远程往返次数
 * 最少，且保持严格只读（只执行 `tail`）。
 */

export interface MatchWithContext {
	server: string;
	environment: string;
	logFile: string;
	/** 在扫描（tail）窗口内的行号，1 开始。 */
	lineInWindow: number;
	matchedLine: string;
	/** 从命中行解析出的时间戳，无则 null。 */
	timestamp: string | null;
	contextBefore: string[];
	contextAfter: string[];
}

export interface ContextResult {
	enriched: MatchWithContext[];
	/** 因时间戳落在查询窗口外而被丢弃的命中数。 */
	droppedByTime: number;
	/** 因窗口拉取失败而无上下文、仍被保留的命中数。 */
	missingContext: number;
	errors: string[];
}

export interface TimeWindow {
	startMs: number;
	endMs: number;
	/** 无时区日志时间戳的假定偏移，单位毫秒、UTC 以东（如 +08:00 → 28800000）。 */
	localOffsetMs: number;
}

/** 区间夹取辅助：[fromLine, toLine] 含两端，1 开始。 */
function clampRange(line: number, before: number, after: number, totalLines: number): { from: number; to: number } {
	const from = Math.max(1, line - before);
	const to = Math.min(totalLines, line + after);
	return { from, to };
}

/** 在已拉取的窗口内，切出某个命中周围的上下文行。 */
export function sliceContext(
	windowLines: string[],
	lineInWindow: number,
	before: number,
	after: number
): { contextBefore: string[]; contextAfter: string[] } {
	const { from, to } = clampRange(lineInWindow, before, after, windowLines.length);
	return {
		contextBefore: windowLines.slice(from - 1, lineInWindow - 1),
		contextAfter: windowLines.slice(lineInWindow, to)
	};
}

/**
 * 为命中补充上下文并应用时间窗口过滤。
 * 命中按文件分组；每个文件只拉取一次 `tail`。
 */
export async function enrichMatchesWithContext(
	executor: SshExecutor,
	server: ServerConfig,
	limits: LimitsConfig,
	matches: LogMatch[],
	contextBefore: number,
	contextAfter: number,
	timeWindow?: TimeWindow
): Promise<ContextResult> {
	const enriched: MatchWithContext[] = [];
	const errors: string[] = [];
	let droppedByTime = 0;
	let missingContext = 0;

	const byFile = new Map<string, LogMatch[]>();
	for (const match of matches) {
		const group = byFile.get(match.logFile) ?? [];
		group.push(match);
		byFile.set(match.logFile, group);
	}

	for (const [logFile, fileMatches] of byFile) {
		let windowLines: string[] | null = null;

			const result = await executor.exec(
				logFile.endsWith(".gz") ? buildGzipCatCommand(logFile) : buildTailCommand(limits.scanLines, logFile)
			);
		if (result.exitCode === 0) {
			windowLines = result.stdout.split("\n");
			// 去掉末尾换行产生的空元素。
			if (windowLines.length > 0 && windowLines[windowLines.length - 1] === "") {
				windowLines.pop();
			}
		} else {
			errors.push(`Cannot fetch context from ${logFile}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
		}

		for (const match of fileMatches) {
			const timestamp = parseLineTimestamp(match.matchedLine);

			if (timeWindow && !isWithinWindow(timestamp, timeWindow.startMs, timeWindow.endMs, timeWindow.localOffsetMs)) {
				droppedByTime += 1;
				continue;
			}

			if (windowLines === null) {
				missingContext += 1;
				enriched.push({
					server: server.name,
					environment: server.environment,
					logFile,
					lineInWindow: match.lineInWindow,
					matchedLine: match.matchedLine,
					timestamp,
					contextBefore: [],
					contextAfter: []
				});
				continue;
			}

			const { contextBefore: before, contextAfter: after } = sliceContext(
				windowLines,
				match.lineInWindow,
				contextBefore,
				contextAfter
			);
			enriched.push({
				server: server.name,
				environment: server.environment,
				logFile,
				lineInWindow: match.lineInWindow,
				matchedLine: match.matchedLine,
				timestamp,
				contextBefore: before,
				contextAfter: after
			});
		}
	}

	return { enriched, droppedByTime, missingContext, errors };
}
