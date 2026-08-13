/**
 * 敏感数据脱敏。
 *
 * 在所有内容离开服务器前应用基础的规则式掩码：
 * password / token / Authorization / Cookie / accessKey / secretKey
 * 及若干常见变体。值统一替换为 `****`。
 */

/**
 * 键值对形态的正则：`key=value`、`key: value`、`"key":"value"`。
 * 值一直延伸到空白、逗号、引号或右花括号为止。
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

/** 任意文本中的 `Authorization: Bearer xxxx` 请求头。 */
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

/** 文本中浮动的长 JWT 形态令牌（三段以点分隔的 base64 段）。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;

export const MASK = "****";

/** 对单行文本中的敏感值做掩码。 */
export function maskLine(line: string): string {
	// 先处理 Bearer 令牌，这样 "Authorization: Bearer xxx" 能保留 Bearer 字面量。
	let masked = line.replace(BEARER_RE, `$1${MASK}`);
	masked = masked.replace(JWT_RE, MASK);
	// "key":"value" → 保留引号："key":"****"
	masked = masked.replace(QUOTED_KV_RE, `$1$2${MASK}$2`);
	// key=value 与 key: value 形态 —— 跳过字面量 "Bearer"（上面已专门处理），
	// 避免把 "Authorization: Bearer ****" 变成 "Authorization: ****"。
	masked = masked.replace(EQUALS_KV_RE, (_m, prefix: string, value: string) =>
		/^bearer$/i.test(value) ? _m : `${prefix}${MASK}`
	);
	masked = masked.replace(COLON_KV_RE, (_m, prefix: string, value: string) =>
		/^bearer$/i.test(value) ? _m : `${prefix}${MASK}`
	);
	return masked;
}

/** 对一组行（上下文、堆栈等）逐行掩码。 */
export function maskLines(lines: string[]): string[] {
	return lines.map(maskLine);
}

/**
 * 对任意 JSON 安全结构做深度掩码。
 * 用于结构化的提取结果（请求参数、响应体等）在序列化进
 * 工具返回值之前的最后一道处理。
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
			// 即使值的形态不常见，也按键名匹配掩码。
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
