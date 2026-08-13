/**
 * 从日志上下文行中提取请求参数。
 *
 * 面向 Java / Spring Boot 日志中常见的形态：
 *   Request: {...}
 *   Parameters: {...}
 *   RequestBody: {...}
 *   args: [...]
 *
 * 找到 JSON 时会解析为结构化数据。找不到可靠内容时
 * 结果返回 `null` —— 绝不凭空捏造。
 */

export interface RequestExtraction {
	/** JSON 解析成功时的结构化参数。 */
	parameters: unknown | null;
	/** 产生该参数的原始文本（已截断）。 */
	rawSource: string | null;
	/** 命中的标记行，如 "RequestBody:"。 */
	detectedMarker: string | null;
}

/** 表示同一行内存在请求载荷的标记。 */
const REQUEST_MARKERS = ["Request:", "Parameters:", "RequestBody:", "args:", "request body:", "input:"];

/** 尝试解析 / 返回的原始载荷最大长度。 */
const MAX_PAYLOAD_CHARS = 20000;

/**
 * 从 `startIndex` 开始尝试提取第一个括号平衡的 JSON 值。
 * 返回 JSON 文本；花括号/方括号始终无法平衡时返回 null。
 */
export function extractBalancedJson(text: string, startIndex: number): string | null {
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
			if (depth === 0) {
				return text.slice(startIndex, i + 1);
			}
		}
	}
	return null;
}

/** 尝试 JSON.parse，并宽容处理常见的单引号 / 无引号键变体。 */
export function tryParseJson(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		// 继续尝试宽松解析
	}
	// 单引号 JSON（手写日志中常见）
	try {
		const normalized = text.replace(/'/g, '"');
		return JSON.parse(normalized);
	} catch {
		// 放弃
	}
	return null;
}

/**
 * 扫描上下文行中的请求载荷。
 * 找到时返回结构化参数，否则返回全 null 结果。
 */
export function extractRequestParameters(lines: string[]): RequestExtraction {
	for (const line of lines) {
		for (const marker of REQUEST_MARKERS) {
			const markerIndex = line.indexOf(marker);
			if (markerIndex === -1) continue;

			const afterMarker = line.slice(markerIndex + marker.length);
			const jsonStart = afterMarker.search(/[{[]/);
			if (jsonStart === -1) continue;

			const jsonText = extractBalancedJson(afterMarker, jsonStart);
			if (jsonText === null) continue;

			const bounded = jsonText.slice(0, MAX_PAYLOAD_CHARS);
			const parsed = tryParseJson(bounded);
			return {
				parameters: parsed,
				rawSource: bounded.length >= MAX_PAYLOAD_CHARS ? `${bounded}…` : bounded,
				detectedMarker: marker
			};
		}
	}

	return { parameters: null, rawSource: null, detectedMarker: null };
}
