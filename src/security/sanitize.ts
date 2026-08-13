/**
 * Sensitive data masking.
 *
 * Basic rule-based masking applied to everything before it leaves the
 * server: password / token / Authorization / Cookie / accessKey / secretKey
 * and a few common relatives. Values become `****`.
 */

/**
 * Key-value style patterns: `key=value`, `key: value`, `"key":"value"`.
 * The value runs until whitespace, comma, quote or closing brace.
 */
const SENSITIVE_KEYS =
	"password|passwd|pwd|token|access_?token|refresh_?token|authorization|cookie|" +
	"accesskey(?:id)?|secretkey|api_?key|client_?secret|session";

const QUOTED_KV_RE = new RegExp(
	`(["']?(?:${SENSITIVE_KEYS})["']?\\s*:\\s*)(["'])([^"'\\n]*?)\\2`,
	"gi"
);
const EQUALS_KV_RE = new RegExp(`((?:${SENSITIVE_KEYS})\\s*=\\s*)([^\\s&,"'\\]}]+)`, "gi");
const COLON_KV_RE = new RegExp(`((?:${SENSITIVE_KEYS})\\s*:\\s*)([^\\s,;"'\\]}]+)`, "gi");

/** `Authorization: Bearer xxxx` headers inside arbitrary text. */
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

/** Long JWT-ish tokens floating in text (three dot-separated base64 segments). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;

export const MASK = "****";

/** Mask sensitive values inside a single line of text. */
export function maskLine(line: string): string {
	// Bearer tokens first, so "Authorization: Bearer xxx" keeps the literal word Bearer.
	let masked = line.replace(BEARER_RE, `$1${MASK}`);
	masked = masked.replace(JWT_RE, MASK);
	// "key":"value" → keep the quotes: "key":"****"
	masked = masked.replace(QUOTED_KV_RE, `$1$2${MASK}$2`);
	// key=value and key: value — skip the literal word "Bearer" (already handled
	// above) so we don't turn "Authorization: Bearer ****" into "Authorization: ****".
	masked = masked.replace(EQUALS_KV_RE, (_m, prefix: string, value: string) =>
		/^bearer$/i.test(value) ? _m : `${prefix}${MASK}`
	);
	masked = masked.replace(COLON_KV_RE, (_m, prefix: string, value: string) =>
		/^bearer$/i.test(value) ? _m : `${prefix}${MASK}`
	);
	return masked;
}

/** Mask every line in a list (context lines, stack traces...). */
export function maskLines(lines: string[]): string[] {
	return lines.map(maskLine);
}

/**
 * Deep-mask any string inside an arbitrary JSON-safe structure.
 * Used on structured extracts (request parameters, response bodies)
 * right before they are serialized into the tool result.
 */
export function maskDeep<T>(value: T): T {
	if (typeof value === "string") {
		return maskLine(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => maskDeep(item)) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			// Mask by key name even when the value shape is unusual.
			if (new RegExp(`^(?:${SENSITIVE_KEYS})$`, "i").test(key) && typeof item === "string") {
				result[key] = MASK;
			} else {
				result[key] = maskDeep(item);
			}
		}
		return result as unknown as T;
	}
	return value;
}
