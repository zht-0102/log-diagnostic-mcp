/**
 * Request parameter extraction from log context lines.
 *
 * Targets common Java / Spring Boot log shapes:
 *   Request: {...}
 *   Parameters: {...}
 *   RequestBody: {...}
 *   args: [...]
 *
 * When JSON is found it is parsed into structured data. When nothing
 * reliable is found, the result is `null` — never fabricated.
 */

export interface RequestExtraction {
	/** Structured parameters when JSON could be parsed. */
	parameters: unknown | null;
	/** Raw text that produced the parameters (truncated). */
	rawSource: string | null;
	/** Which marker line produced the match, e.g. "RequestBody:". */
	detectedMarker: string | null;
}

/** Markers that indicate a request payload on the same line. */
const REQUEST_MARKERS = ["Request:", "Parameters:", "RequestBody:", "args:", "request body:", "input:"];

/** Maximum length of the raw payload we try to parse / return. */
const MAX_PAYLOAD_CHARS = 20000;

/**
 * Try to extract the first balanced JSON value starting at `startIndex`.
 * Returns the JSON text or null when braces/brackets never balance.
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

/** Attempt JSON.parse, tolerating common single-quote / unquoted-key variants. */
export function tryParseJson(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		// fall through to lenient attempts
	}
	// Single-quoted JSON (common in hand-written logs)
	try {
		const normalized = text.replace(/'/g, '"');
		return JSON.parse(normalized);
	} catch {
		// give up
	}
	return null;
}

/**
 * Scan context lines for a request payload.
 * Returns structured parameters when found, otherwise a null result.
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
