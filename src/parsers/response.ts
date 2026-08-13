/**
 * Response extraction from log context lines.
 *
 * Targets common Java / Spring Boot log shapes:
 *   Response: {...}
 *   Result: {...}
 *   Return: {...}
 *   response body: {...}
 *
 * Very large responses are truncated and flagged with
 * `responseTruncated: true` — never return hundreds of KB to the AI.
 */

import { extractBalancedJson, tryParseJson } from "./request.js";

export interface ResponseExtraction {
	/** Structured body when JSON could be parsed, else raw text, else null. */
	body: unknown | null;
	/** Which marker line produced the match, e.g. "Response:". */
	detectedMarker: string | null;
	/** True when the payload was cut to the max length. */
	responseTruncated: boolean;
}

const RESPONSE_MARKERS = ["Response:", "Result:", "Return:", "response body:", "ResponseBody:", "output:"];

/** Hard cap for response payloads returned to the AI client. */
export const MAX_RESPONSE_CHARS = 4000;

/**
 * Scan context lines for a response payload.
 * JSON is parsed when possible; otherwise the raw (truncated) text is kept.
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

			// Non-JSON response: keep raw text, truncated.
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
