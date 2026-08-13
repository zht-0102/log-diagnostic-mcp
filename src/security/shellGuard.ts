/**
 * Shell 安全工具。
 *
 * 针对命令注入的纵深防御：
 * 1. 用户提供的值（keyword、路径等）必须通过严格白名单校验。
 * 2. 拼装远程命令时，每个参数都做单引号转义。
 * 3. 命令只能由固定的只读模板拼装而成。
 */

/**
 * 日志搜索关键词等用户输入的白名单。
 * 允许 Unicode 字母/数字以及一小组安全符号。
 */
const KEYWORD_PATTERN = /^[\p{L}\p{N}_.:@#\- /[\](){}=+,.*"'\\]{1,200}$/u;

/** 校验用户提供的关键词，未通过白名单时抛错。 */
export function validateKeyword(keyword: string): string {
	if (!KEYWORD_PATTERN.test(keyword)) {
		throw new Error(
			"Invalid keyword: only letters, digits and the symbols _ . : @ # - / [ ] ( ) { } = + , . * \" ' \\ are allowed (max 200 chars)"
		);
	}
	return keyword;
}

/**
 * 校验配置中的远程日志路径。
 * 必须是 POSIX 绝对路径；即使引号转义被绕过，也不允许出现
 * 可能逃逸的 shell 元字符。换行符一律拒绝。
 */
const LOG_PATH_PATTERN = /^\/[\w./\-]+$/;

export function validateLogPath(path: string): string {
	if (path.includes("\n") || path.includes("\r")) {
		throw new Error(`Invalid log path (control characters): ${JSON.stringify(path)}`);
	}
	if (!LOG_PATH_PATTERN.test(path)) {
		throw new Error(
			`Invalid log path: must be an absolute path using only letters, digits, _ . / - : ${path}`
		);
	}
	return path;
}

/**
 * POSIX shell 单引号转义。
 * 用单引号包裹整个值，并把内部的单引号转义为 '\'' 序列。
 * 结果始终是一个完整的 shell 词元。
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 本服务器执行的任何命令中都绝不允许出现的命令黑名单。 */
const FORBIDDEN_COMMANDS = [
	"rm",
	"mv",
	"cp",
	"kill",
	"reboot",
	"shutdown",
	"halt",
	"poweroff",
	"dd",
	"mkfs",
	"chmod",
	"chown",
	"systemctl",
	"service",
	"docker",
	"kubectl",
	"helm",
	"iptables",
	"wget",
	"curl",
	"nc",
	"ssh",
	"scp",
	"tee"
] as const;

/** 执行任何命令模板前的拦截守卫；命中黑名单时抛错。 */
export function assertNotForbidden(command: string): void {
	const firstWord = command.trim().split(/\s+/)[0] ?? "";
	if ((FORBIDDEN_COMMANDS as readonly string[]).includes(firstWord)) {
		throw new Error(`Refusing to execute forbidden command: ${firstWord}`);
	}
}
