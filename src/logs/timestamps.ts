/**
 * Log timestamp parsing.
 *
 * Supports the timestamp shapes most common in Java / Spring Boot logs:
 * - `2026-08-13 10:01:02` / `2026-08-13 10:01:02.123`
 * - `2026-08-13T10:01:02.123+08:00` (ISO 8601)
 * - `2026/08/13 10:01:02`
 *
 * Lines without a recognizable timestamp return null; callers decide
 * whether to keep them conservatively during time filtering.
 */

const PATTERNS: Array<{ regex: RegExp; toIso: (m: RegExpMatchArray) => string }> = [
	{
		// ISO 8601 with explicit offset/Z, e.g. 2026-08-13T10:01:02.123+08:00
		regex: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?/,
		toIso: (m) => {
			const ms = m[7] ? m[7].slice(1, 4).padEnd(3, "0") : "000";
			const offset = m[8] ? m[8].replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : "Z";
			return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}${offset}`;
		}
	},
	{
		// Common Java log format: 2026-08-13 10:01:02.123 (no timezone — treated as local server time)
		regex: /(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?/,
		toIso: (m) => {
			const ms = m[7] ? m[7].slice(1, 4).padEnd(3, "0") : "000";
			return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}`;
		}
	},
	{
		// Slash-separated: 2026/08/13 10:01:02
		regex: /(\d{4})\/(\d{2})\/(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/,
		toIso: (m) => `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000`
	}
];

/**
 * Extract a timestamp from a log line.
 * Returns an ISO-ish string, or null when no known pattern is found.
 * Zone-less timestamps are kept zone-less on purpose: they compare
 * correctly against each other, and we never invent a timezone.
 */
export function parseLineTimestamp(line: string): string | null {
	for (const { regex, toIso } of PATTERNS) {
		const match = line.match(regex);
		if (match) {
			const iso = toIso(match);
			// Guard against impossible dates like 2026-13-45
			return Number.isNaN(Date.parse(iso)) ? null : iso;
		}
	}
	return null;
}

/**
 * Parse a user-supplied query boundary (ISO 8601).
 * Throws with a clear message when invalid.
 */
export function parseQueryTime(value: string, field: "startTime" | "endTime"): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid ${field}: "${value}" is not a valid ISO 8601 time`);
	}
	return date;
}

/**
 * Compare a parsed line timestamp against the query window.
 *
 * Rules:
 * - Line has no timestamp → keep (conservative: never silently drop).
 * - Line timestamp has no zone → compared as *local* time of the server;
 *   query times are converted to local components before comparison.
 * - Line timestamp has a zone → compared as absolute instants.
 */
export function isWithinWindow(
	lineTimestamp: string | null,
	startMs: number,
	endMs: number,
	localOffsetMs: number
): boolean {
	if (lineTimestamp === null) return true;

	const hasZone = /Z$|[+-]\d{2}:\d{2}$/.test(lineTimestamp);
	let lineMs: number;
	if (hasZone) {
		lineMs = Date.parse(lineTimestamp);
	} else {
		// Interpret as local server time: shift into UTC by the assumed offset.
		lineMs = Date.parse(`${lineTimestamp}Z`) - localOffsetMs;
	}
	if (Number.isNaN(lineMs)) return true;
	return lineMs >= startMs && lineMs <= endMs;
}

/** Resolve the query window; defaults to the last 30 minutes. */
export function resolveTimeWindow(
	startTime: string | undefined,
	endTime: string | undefined
): { startMs: number; endMs: number } {
	const end = endTime ? parseQueryTime(endTime, "endTime") : new Date();
	const start = startTime
		? parseQueryTime(startTime, "startTime")
		: new Date(end.getTime() - 30 * 60 * 1000);
	if (start.getTime() > end.getTime()) {
		throw new Error("startTime must not be after endTime");
	}
	return { startMs: start.getTime(), endMs: end.getTime() };
}
