import type { ServerConfig, LimitsConfig } from "../server/config.js";
import type { SshExecutor, ExecResult } from "../ssh/connection.js";
import {
	buildGrepTailCommand,
	buildListLogFilesCommand
} from "../ssh/commands.js";
import { validateKeyword } from "../security/shellGuard.js";

/**
 * Single-server log search.
 *
 * Strategy (never scans full history):
 * 1. List `*.log` files in each configured logPath (newest first, capped).
 * 2. For each file, grep the keyword only inside the last `scanLines` lines.
 * 3. Collect matches with their position inside the scanned window.
 */

/** A single keyword hit. */
export interface LogMatch {
	/** Configured server name. */
	server: string;
	/** Environment of the server, e.g. prod. */
	environment: string;
	/** Absolute path of the log file on the remote server. */
	logFile: string;
	/** 1-based line index inside the scanned tail window. */
	lineInWindow: number;
	/** The matched log line (raw, before masking). */
	matchedLine: string;
	/** Timestamp parsed from the line, ISO string, or null when not detected. */
	timestamp: string | null;
}

export interface SingleServerSearchResult {
	server: string;
	environment: string;
	matches: LogMatch[];
	/** Non-fatal problems (missing dirs, permission errors...), one per resource. */
	errors: string[];
	/** True when this server hit the match cap and more matches may exist. */
	truncated: boolean;
}

export interface SearchOptions {
	keyword: string;
	/** Stop collecting after this many matches on this server. */
	maxMatches: number;
}

/** Only this many log files per configured path are scanned (newest first). */
export const MAX_FILES_PER_PATH = 5;

/** grep exit codes: 0 = matches, 1 = no matches, >=2 = error. */
function isGrepError(result: ExecResult): boolean {
	return result.exitCode >= 2;
}

/** Parse `grep -n` output lines of the form `<lineNumber>:<content>`. */
export function parseGrepOutput(stdout: string): Array<{ lineInWindow: number; matchedLine: string }> {
	const results: Array<{ lineInWindow: number; matchedLine: string }> = [];
	for (const line of stdout.split("\n")) {
		if (line.length === 0) continue;
		const match = /^(\d+):(.*)$/.exec(line);
		if (!match) continue;
		results.push({ lineInWindow: Number(match[1]), matchedLine: match[2] });
	}
	return results;
}

/** List log files in one directory; returns [] with an error note when unavailable. */
async function listLogFiles(
	executor: SshExecutor,
	directory: string,
	errors: string[]
): Promise<string[]> {
	const result = await executor.exec(buildListLogFilesCommand(directory));
	// grep exit 1: directory exists but contains no .log files — not an error.
	if (result.exitCode === 1) return [];
	if (isGrepError(result)) {
		errors.push(`Cannot list log files in ${directory}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
		return [];
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, MAX_FILES_PER_PATH);
}

/**
 * Search one server for a keyword across all its configured log paths.
 * The executor is injected so tests can substitute a mock transport.
 */
export async function searchSingleServer(
	executor: SshExecutor,
	server: ServerConfig,
	limits: LimitsConfig,
	options: SearchOptions
): Promise<SingleServerSearchResult> {
	validateKeyword(options.keyword);

	const matches: LogMatch[] = [];
	const errors: string[] = [];
	let truncated = false;

	for (const logPath of server.logPaths) {
		if (matches.length >= options.maxMatches) {
			truncated = true;
			break;
		}

		const files = await listLogFiles(executor, logPath, errors);
		for (const fileName of files) {
			if (matches.length >= options.maxMatches) {
				truncated = true;
				break;
			}

			const filePath = `${logPath}/${fileName}`;
			const command = buildGrepTailCommand(limits.scanLines, options.keyword, filePath);
			const result = await executor.exec(command);

			if (isGrepError(result)) {
				errors.push(`Search failed in ${filePath}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
				continue;
			}
			if (result.exitCode === 1) continue; // no matches in this file

			for (const hit of parseGrepOutput(result.stdout)) {
				if (matches.length >= options.maxMatches) {
					truncated = true;
					break;
				}
				matches.push({
					server: server.name,
					environment: server.environment,
					logFile: filePath,
					lineInWindow: hit.lineInWindow,
					matchedLine: hit.matchedLine,
					timestamp: null // filled by the time-range step
				});
			}
			if (result.truncated || result.timedOut) {
				errors.push(
					result.timedOut
						? `Search timed out in ${filePath}`
						: `Search output truncated in ${filePath}`
				);
			}
		}
	}

	return { server: server.name, environment: server.environment, matches, errors, truncated };
}
