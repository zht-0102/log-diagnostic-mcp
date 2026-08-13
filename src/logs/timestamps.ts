/**
 * 日志时间戳解析。
 *
 * 支持 Java / Spring Boot 日志中最常见的几种时间戳形态：
 * - `2026-08-13 10:01:02` / `2026-08-13 10:01:02.123`
 * - `2026-08-13T10:01:02.123+08:00`（ISO 8601）
 * - `2026-08-13 10:01:02`（斜杠分隔形态）
 *
 * 无法识别时间戳的行返回 null；由调用方决定在时间过滤时
 * 是否保守保留。
 */

const PATTERNS: Array<{ regex: RegExp; toIso: (m: RegExpMatchArray) => string }> = [
	{
		// 带显式偏移/Z 的 ISO 8601，如 2026-08-13T10:01:02.123+08:00
		regex: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?/,
		toIso: (m) => {
			const ms = m[7] ? m[7].slice(1, 4).padEnd(3, "0") : "000";
			const offset = m[8] ? m[8].replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : "Z";
			return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}${offset}`;
		}
	},
	{
		// 常见 Java 日志格式：2026-08-13 10:01:02.123（无时区 —— 按服务器本地时间处理）
		regex: /(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?/,
		toIso: (m) => {
			const ms = m[7] ? m[7].slice(1, 4).padEnd(3, "0") : "000";
			return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}`;
		}
	},
	{
		// 斜杠分隔：2026/08/13 10:01:02
		regex: /(\d{4})\/(\d{2})\/(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/,
		toIso: (m) => `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000`
	}
];

/**
 * 从一行日志中提取时间戳。
 * 返回类 ISO 字符串；未命中任何已知模式时返回 null。
 * 不带时区的时间戳故意保持不带时区：它们之间可以正确比较，
 * 我们也绝不自行猜测时区。
 */
export function parseLineTimestamp(line: string): string | null {
	for (const { regex, toIso } of PATTERNS) {
		const match = line.match(regex);
		if (match) {
			const iso = toIso(match);
			// 拦截不可能存在的日期，如 2026-13-45
			return Number.isNaN(Date.parse(iso)) ? null : iso;
		}
	}
	return null;
}

/**
 * 解析用户提供的查询边界（ISO 8601）。
 * 非法时抛出带说明的错误。
 */
export function parseQueryTime(value: string, field: "startTime" | "endTime"): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid ${field}: "${value}" is not a valid ISO 8601 time`);
	}
	return date;
}

/**
 * 将解析出的行时间戳与查询窗口比较。
 *
 * 规则：
 * - 行没有时间戳 → 保留（保守策略：绝不静默丢弃）。
 * - 行时间戳不带时区 → 按服务器*本地*时间比较；
 *   比较前先把查询时间换算成本地分量。
 * - 行时间戳带时区 → 按绝对时刻比较。
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
		// 按服务器本地时间解释：用假定的偏移量折算回 UTC。
		lineMs = Date.parse(`${lineTimestamp}Z`) - localOffsetMs;
	}
	if (Number.isNaN(lineMs)) return true;
	return lineMs >= startMs && lineMs <= endMs;
}

/** 解析查询时间窗口；默认最近 30 分钟。 */
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
