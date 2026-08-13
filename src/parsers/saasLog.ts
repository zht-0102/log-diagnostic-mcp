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

export interface SaasPayloadExtraction {
	label: string;
	body: unknown;
	rawSource: string;
}

export interface SaasRawSqlExtraction {
	label: string;
	sql: string;
	logger: string;
	timestamp: string;
}

export interface SaasTenantRoute {
	database: string | null;
	cus: string | null;
	schema: string | null;
	domain: string | null;
	currentSchema: string | null;
	currentUri: string | null;
	currentTraceId: string | null;
	connectionId: string | null;
	warnings: string[];
}

export interface SaasExceptionSummary {
	type: string;
	message: string | null;
	stackTrace: string[];
}

export interface SaasEventSummary {
	payloads: SaasPayloadExtraction[];
	sql: SaasRawSqlExtraction[];
	tenant: SaasTenantRoute;
	exceptions: SaasExceptionSummary[];
	keyMessages: string[];
}

export interface SaasEventDiagnosis {
	confirmedFacts: string[];
	possibleCauses: string[];
	recommendations: string[];
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

function extractBalancedJsonFrom(text: string, startIndex: number): string | null {
	const open = text[startIndex];
	if (open !== "{" && open !== "[") return null;
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = startIndex; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === open) depth += 1;
		else if (ch === close) {
			depth -= 1;
			if (depth === 0) return text.slice(startIndex, i + 1);
		}
	}
	return null;
}

function tryParseJsonPayload(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function payloadLabel(message: string, jsonStart: number): string {
	const before = message.slice(0, jsonStart).trim();
	const marker = before.match(/([^:：>]+)(?::|：|>>)\s*$/);
	return (marker?.[1] ?? before).trim();
}

function extractPayload(message: string): SaasPayloadExtraction | null {
	const jsonStart = message.search(/[{[]/);
	if (jsonStart === -1) return null;
	const rawSource = extractBalancedJsonFrom(message, jsonStart);
	if (!rawSource) return null;
	return {
		label: payloadLabel(message, jsonStart),
		body: tryParseJsonPayload(rawSource),
		rawSource
	};
}

function extractRawSql(entry: SaasLogEntry): SaasRawSqlExtraction | null {
	const message = entry.line.message;
	const sqlStart = message.search(/\b(select|insert|update|delete)\b/i);
	if (sqlStart === -1) return null;
	const label = message.slice(0, sqlStart).replace(/[-:：\s]+$/g, "").trim();
	return {
		label,
		sql: message.slice(sqlStart).trim(),
		logger: entry.line.logger,
		timestamp: entry.line.timestamp
	};
}

function emptyTenantRoute(): SaasTenantRoute {
	return {
		database: null,
		cus: null,
		schema: null,
		domain: null,
		currentSchema: null,
		currentUri: null,
		currentTraceId: null,
		connectionId: null,
		warnings: []
	};
}

function updateTenantRoute(tenant: SaasTenantRoute, message: string): void {
	const database = /tenant database:\s*([^,]+),\s*domain:([^,]+),\s*cus:([^,\s]+)/i.exec(message);
	if (database) {
		tenant.database = database[1] === "null" ? null : database[1];
		tenant.domain = database[2] === "null" ? null : database[2];
		tenant.cus = database[3] === "null" ? null : database[3];
	}

	const schema = /tenant:(\S+),\s*schema:(\S+)/i.exec(message);
	if (schema) {
		tenant.cus = schema[1] === "null" ? tenant.cus : schema[1];
		tenant.schema = schema[2] === "null" ? null : schema[2];
	}

	const current = /current con info:([^,]*),([^,]*),([^,]*),?([^,\s]*)?/i.exec(message);
	if (current) {
		tenant.currentSchema = current[1] && current[1] !== "null" ? current[1] : null;
		tenant.currentUri = current[2] && current[2] !== "null" ? current[2] : null;
		tenant.currentTraceId = current[3] && current[3] !== "null" ? current[3] : null;
		tenant.connectionId = current[4] && current[4] !== "null" ? current[4] : null;
	}

	if (/can not find tenant/i.test(message)) {
		tenant.warnings.push(message);
	}
}

function extractException(entry: SaasLogEntry): SaasExceptionSummary | null {
	const first = entry.continuations.find((line) => /\b[\w.$]+(?:Exception|Error|Throwable)\b/.test(line));
	if (!first) return null;
	const match = /\b((?:[\w$]+\.)+[\w$]+(?:Exception|Error|Throwable))\b(?::\s*(.*))?/.exec(first);
	if (!match) return null;
	return {
		type: match[1],
		message: match[2]?.trim() || null,
		stackTrace: entry.continuations
	};
}

export function summarizeSaasEvent(event: SaasLogEvent): SaasEventSummary {
	const payloads: SaasPayloadExtraction[] = [];
	const sql: SaasRawSqlExtraction[] = [];
	const exceptions: SaasExceptionSummary[] = [];
	const keyMessages: string[] = [];
	const tenant = emptyTenantRoute();

	for (const entry of event.entries) {
		const payload = extractPayload(entry.line.message);
		if (payload) payloads.push(payload);

		const rawSql = extractRawSql(entry);
		if (rawSql) sql.push(rawSql);

		updateTenantRoute(tenant, entry.line.message);

		const exception = extractException(entry);
		if (exception) exceptions.push(exception);

		if (/失败|异常|不合法|WARN|ERROR|can not find tenant/i.test(entry.line.message + entry.line.level)) {
			keyMessages.push(entry.line.message);
		}
	}

	return { payloads, sql, tenant, exceptions, keyMessages };
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function findInvalidDocumentDate(summary: SaasEventSummary): string | null {
	const sources = [
		...summary.keyMessages,
		...summary.payloads.map((payload) => payload.rawSource),
		...summary.exceptions.map((exception) => exception.message ?? "")
	];
	for (const source of sources) {
		const match = /单据日期[:：](\d{4}-\d{2}-\d{2})不合法!输入日期应该在(\d{4}-\d{2}-\d{2})到(\d{4}-\d{2}-\d{2})/.exec(source);
		if (match) {
			return `单据日期:${match[1]} 不在允许区间 ${match[2]} 到 ${match[3]}`;
		}
	}
	return null;
}

export function analyzeSaasEvent(
	event: SaasLogEvent,
	summary: SaasEventSummary
): SaasEventDiagnosis {
	const confirmedFacts: string[] = [];
	const possibleCauses: string[] = [];
	const recommendations: string[] = [];

	const invalidDocumentDate = findInvalidDocumentDate(summary);
	if (invalidDocumentDate) {
		pushUnique(confirmedFacts, invalidDocumentDate);
		pushUnique(possibleCauses, "业务日期不在当前允许的核算期或库存账期范围内。");
		pushUnique(recommendations, "检查租户对应库房/库存模块的核算期设置，以及单据业务日期是否应调整。");
	}

	if (summary.keyMessages.some((message) => /任务回调处理失败，将任务数据写回原redis/.test(message))) {
		pushUnique(confirmedFacts, "任务回调处理失败，日志显示任务数据已写回原redis等待后续处理。");
		pushUnique(possibleCauses, "回调业务处理失败后触发任务重试或补偿流程。");
		pushUnique(recommendations, "结合同一traceId的异常和回调返回JSON，确认失败是否会持续重试并造成重复处理。");
	}

	if (summary.tenant.warnings.length > 0) {
		pushUnique(confirmedFacts, "未找到租户数据库或schema，日志存在租户路由WARN。");
		pushUnique(possibleCauses, "租户路由上下文缺失，domain/cus/tenant 未正确传入或无法映射到数据库/schema。");
		pushUnique(recommendations, "检查请求或任务上下文中的 domain/cus/tenant，并核对租户配置表与数据源路由配置。");
	}

	if (summary.exceptions.length > 0) {
		for (const exception of summary.exceptions) {
			const message = exception.message ? `: ${exception.message}` : "";
			pushUnique(confirmedFacts, `异常：${exception.type}${message}`);
		}
	}

	if (confirmedFacts.length === 0) {
		pushUnique(confirmedFacts, `事件包含 ${event.entries.length} 条结构化日志，未命中内置SaaS业务诊断规则。`);
		pushUnique(recommendations, "查看 keyMessages、payloads、sql 和 tenant 字段继续人工判断。");
	}

	if (possibleCauses.length === 0) {
		pushUnique(possibleCauses, "未发现明确业务模式，需结合事件摘要继续确认。");
	}

	return { confirmedFacts, possibleCauses, recommendations };
}
