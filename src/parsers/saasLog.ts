/**
 * 神农 SaaS 日志行解析。
 *
 * 日志头格式：
 *   yyyy-MM-dd HH:mm:ss.SSS LEVEL system app node traceId srt timecost ip user domain uri --- [thread] logger : message
 */

export interface SaasLogLine {
	timestamp: string;
	level: string;
	system: string;
	app: string;
	node: string;
	traceId: string | null;
	srt: string | null;
	timecost: string | null;
	ip: string | null;
	user: string | null;
	domain: string | null;
	uri: string | null;
	thread: string;
	logger: string;
	message: string;
	raw: string;
}

export interface SaasLogEntry {
	line: SaasLogLine;
	continuations: string[];
}

export interface SaasLogEvent {
	key: string;
	traceId: string | null;
	thread: string;
	startTime: string;
	endTime: string;
	durationMs: number;
	levels: string[];
	loggers: string[];
	entries: SaasLogEntry[];
}

const SAAS_LOG_RE =
	/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\w+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+--- \[([^\]]+)\]\s+(.+?)\s+:\s?(.*)$/;

const PLACEHOLDERS = new Set([
	"notraceid",
	"nosrt",
	"notimecost",
	"0.0.0.0",
	"nouser",
	"nodomain",
	"nouri"
]);

export function normalizePlaceholder(value: string): string | null {
	return PLACEHOLDERS.has(value) ? null : value;
}

export function isSaasStackContinuation(line: string): boolean {
	return /^\s*(at\s+|\.\.\.\s*\d+\s+more|Caused by:)/.test(line);
}

function toTimestamp(value: string): string {
	return value.replace(" ", "T");
}

export function parseSaasLogLine(line: string): SaasLogLine | null {
	const match = SAAS_LOG_RE.exec(line);
	if (!match) return null;

	return {
		timestamp: toTimestamp(match[1]),
		level: match[2],
		system: match[3],
		app: match[4],
		node: match[5],
		traceId: normalizePlaceholder(match[6]),
		srt: normalizePlaceholder(match[7]),
		timecost: normalizePlaceholder(match[8]),
		ip: normalizePlaceholder(match[9]),
		user: normalizePlaceholder(match[10]),
		domain: normalizePlaceholder(match[11]),
		uri: normalizePlaceholder(match[12]),
		thread: match[13],
		logger: match[14].trim(),
		message: match[15],
		raw: line
	};
}

function eventKeyFor(line: SaasLogLine): string {
	return line.traceId ? `trace:${line.traceId}` : `thread:${line.thread}`;
}

function timestampMs(value: string): number {
	return Date.parse(`${value}Z`);
}

function uniqueValues(values: string[]): string[] {
	return Array.from(new Set(values));
}

export function groupSaasEvents(lines: string[]): SaasLogEvent[] {
	const events = new Map<string, SaasLogEvent>();
	let lastEntry: SaasLogEntry | null = null;

	for (const rawLine of lines) {
		const parsed = parseSaasLogLine(rawLine);
		if (!parsed) {
			if (lastEntry && (isSaasStackContinuation(rawLine) || rawLine.trim().length > 0)) {
				lastEntry.continuations.push(rawLine);
			}
			continue;
		}

		const key = eventKeyFor(parsed);
		let event = events.get(key);
		if (!event) {
			event = {
				key,
				traceId: parsed.traceId,
				thread: parsed.thread,
				startTime: parsed.timestamp,
				endTime: parsed.timestamp,
				durationMs: 0,
				levels: [],
				loggers: [],
				entries: []
			};
			events.set(key, event);
		}

		const entry = { line: parsed, continuations: [] };
		event.entries.push(entry);
		event.startTime =
			timestampMs(parsed.timestamp) < timestampMs(event.startTime) ? parsed.timestamp : event.startTime;
		event.endTime =
			timestampMs(parsed.timestamp) > timestampMs(event.endTime) ? parsed.timestamp : event.endTime;
		event.durationMs = Math.max(0, timestampMs(event.endTime) - timestampMs(event.startTime));
		event.levels = uniqueValues([...event.levels, parsed.level]);
		event.loggers = uniqueValues([...event.loggers, parsed.logger]);
		lastEntry = entry;
	}

	return Array.from(events.values());
}
