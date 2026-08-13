/**
 * 从日志上下文行中提取响应内容。
 *
 * 面向 Java / Spring Boot 日志中常见的形态：
 *   Response: {...}
 *   Result: {...}
 *   Return: {...}
 *   response body: {...}
 *
 * 超大响应会被截断并以 `responseTruncated: true` 标记 ——
 * 绝不向 AI 返回几百 KB 的内容。
 */

import { extractBalancedJson, tryParseJson } from "./request.js";

export interface ResponseExtraction {
	/** JSON 可解析时为结构化内容，否则为原始文本，都没有时为 null。 */
	body: unknown | null;
	/** 命中的标记行，如 "Response:"。 */
	detectedMarker: string | null;
	/** 载荷被截断至最大长度时为 true。 */
	responseTruncated: boolean;
}

const RESPONSE_MARKERS = ["Response:", "Result:", "Return:", "response body:", "ResponseBody:", "output:"];

/** 返回给 AI 客户端的响应载荷硬性上限。 */
export const MAX_RESPONSE_CHARS = 4000;

/**
 * 扫描上下文行中的响应载荷。
 * 尽量解析 JSON；无法解析时保留原始（已截断）文本。
 */
export function extractResponse(lines: string[]): ResponseExtraction {
	for (const line of lines) {
		for (const marker of RESPONSE_MARKERS) {
			const markerIndex = line.indexOf(marker);
			if (markerIndex === -1) continue;

			const afterMarker = line.slice(markerIndex + marker.length).trim();
			if (afterMarker.length === 0) continue;

			const jsonStart = afterMarker.search(/[{[]/);
			if (jsonStart !== -1 && jsonStart < 20) {
				const jsonText = extractBalancedJson(afterMarker, jsonStart);
				if (jsonText !== null) {
					const truncated = jsonText.length > MAX_RESPONSE_CHARS;
					const bounded = jsonText.slice(0, MAX_RESPONSE_CHARS);
					const parsed = truncated ? null : tryParseJson(bounded);
					return {
						body: parsed ?? bounded,
						detectedMarker: marker,
						responseTruncated: truncated
					};
				}
			}

			// 非 JSON 响应：保留已截断的原始文本。
			const truncated = afterMarker.length > MAX_RESPONSE_CHARS;
			return {
				body: afterMarker.slice(0, MAX_RESPONSE_CHARS),
				detectedMarker: marker,
				responseTruncated: truncated
			};
		}
	}

	return { body: null, detectedMarker: null, responseTruncated: false };
}
