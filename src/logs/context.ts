import type { ServerConfig, LimitsConfig } from "../server/config.js";
import type { SshExecutor } from "../ssh/connection.js";
import { buildTailCommand } from "../ssh/commands.js";
import { isWithinWindow, parseLineTimestamp } from "./timestamps.js";
import type { LogMatch } from "./search.js";

/**
 * Physical context extraction.
 *
 * For every log file containing matches, the scanned tail window is
 * fetched ONCE, then before/after slices are computed locally for each
 * match — this keeps remote round-trips minimal and stays strictly
 * read-only (only `tail` is executed).
 */

export interface MatchWithContext {
	server: string;
	environment: string;
	logFile: string;
	/** 1-based line index inside the scanned tail window. */
	lineInWindow: number;
	matchedLine: string;
	/** Timestamp parsed from the matched line, or null. */
	timestamp: string | null;
	contextBefore: string[];
	contextAfter: string[];
}

export interface ContextResult {
	enriched: MatchWithContext[];
	/** Matches dropped because their timestamp fell outside the query window. */
	droppedByTime: number;
	/** Matches kept without context because the window fetch failed. */
	missingContext: number;
	errors: string[];
}

export interface TimeWindow {
	startMs: number;
	endMs: number;
	/** Assumed offset of zone-less log timestamps, ms east of UTC (e.g. +08:00 → 28800000). */
	localOffsetMs: number;
}

/** Clamp helper: [fromLine, toLine] inclusive, 1-based. */
function clampRange(line: number, before: number, after: number, totalLines: number): { from: number; to: number } {
	const from = Math.max(1, line - before);
	const to = Math.min(totalLines, line + after);
	return { from, to };
}

/** Slice context lines around a match inside the fetched window. */
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
 * Enrich matches with surrounding context and apply time-window filtering.
 * Matches are grouped by file; one `tail` fetch per file.
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

		const result = await executor.exec(buildTailCommand(limits.scanLines, logFile));
		if (result.exitCode === 0) {
			windowLines = result.stdout.split("\n");
			// Drop the trailing empty element produced by the final newline.
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
