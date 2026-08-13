import { shellQuote, validateKeyword, validateLogPath } from "../security/shellGuard.js";

/**
 * Builders for the ONLY remote commands this server ever runs.
 * Every builder:
 * - validates its inputs against strict whitelists,
 * - quotes every dynamic argument with POSIX single quotes,
 * - produces strictly read-only pipelines (tail / grep / cat / awk / ls / wc).
 */

/** `tail -n <N> <file>` — read the last N lines of one log file. */
export function buildTailCommand(scanLines: number, filePath: string): string {
	validateLogPath(filePath);
	if (!Number.isInteger(scanLines) || scanLines < 1) {
		throw new Error(`Invalid scanLines: ${scanLines}`);
	}
	return `tail -n ${scanLines} ${shellQuote(filePath)}`;
}

/**
 * `tail -n <N> <file> | grep -n -F -e <keyword>` —
 * keyword search restricted to the last N lines. `-F` keeps the keyword
 * literal (no regex interpretation), `-n` prefixes physical-ish line numbers.
 */
export function buildGrepTailCommand(scanLines: number, keyword: string, filePath: string): string {
	validateLogPath(filePath);
	validateKeyword(keyword);
	if (!Number.isInteger(scanLines) || scanLines < 1) {
		throw new Error(`Invalid scanLines: ${scanLines}`);
	}
	return `tail -n ${scanLines} ${shellQuote(filePath)} | grep -n -F -e ${shellQuote(keyword)}`;
}

/**
 * `cat <file> | awk 'NR>=start && NR<=end'` —
 * read a physical line range [fromLine, toLine] (inclusive) from a file.
 * Used to fetch surrounding context around a match.
 */
export function buildLineRangeCommand(filePath: string, fromLine: number, toLine: number): string {
	validateLogPath(filePath);
	if (!Number.isInteger(fromLine) || fromLine < 1 || !Number.isInteger(toLine) || toLine < fromLine) {
		throw new Error(`Invalid line range: ${fromLine}-${toLine}`);
	}
	return `cat ${shellQuote(filePath)} | awk 'NR>=${fromLine} && NR<=${toLine}'`;
}

/**
 * `wc -l < <file>` — count lines in a file (reads only, prints a number).
 */
export function buildLineCountCommand(filePath: string): string {
	validateLogPath(filePath);
	return `wc -l < ${shellQuote(filePath)}`;
}

/**
 * `ls -1t <dir> | grep -E '\.log(\.[0-9]+)?$'` —
 * list plain-text rotated log files directly inside a configured directory,
 * newest first (no glob expansion, no recursion).
 */
export function buildListLogFilesCommand(directory: string): string {
	validateLogPath(directory);
	return `ls -1t ${shellQuote(directory)} | grep -E '\\.log(\\.[0-9]+)?$'`;
}
