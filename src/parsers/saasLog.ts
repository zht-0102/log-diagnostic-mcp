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
