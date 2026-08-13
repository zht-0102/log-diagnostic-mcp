/**
 * Shell safety utilities.
 *
 * Defense in depth against command injection:
 * 1. User-supplied values (keyword, paths...) pass a strict whitelist.
 * 2. Every argument is single-quote escaped when building remote commands.
 * 3. Commands are assembled only from fixed, read-only templates.
 */

/**
 * Whitelist for log search keywords and similar user input.
 * Allows unicode letters/digits plus a small set of safe symbols.
 */
const KEYWORD_PATTERN = /^[\p{L}\p{N}_.:@#\- /[\](){}=+,.*"'\\]{1,200}$/u;

/** Validate a user-supplied keyword. Throws when it fails the whitelist. */
export function validateKeyword(keyword: string): string {
	if (!KEYWORD_PATTERN.test(keyword)) {
		throw new Error(
			"Invalid keyword: only letters, digits and the symbols _ . : @ # - / [ ] ( ) { } = + , . * \" ' \\ are allowed (max 200 chars)"
		);
	}
	return keyword;
}

/**
 * Validate a remote log path from configuration.
 * Absolute POSIX path; no shell metacharacters that could break out of quoting
 * even if quoting were ever bypassed. Newlines are always rejected.
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
 * POSIX shell single-quote escaping.
 * Wraps the value in single quotes and escapes embedded single quotes
 * as the sequence '\''. The result is always a single shell word.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Commands that must never appear in anything this server executes. */
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

/** Guard used before running any command template; throws on violation. */
export function assertNotForbidden(command: string): void {
	const firstWord = command.trim().split(/\s+/)[0] ?? "";
	if ((FORBIDDEN_COMMANDS as readonly string[]).includes(firstWord)) {
		throw new Error(`Refusing to execute forbidden command: ${firstWord}`);
	}
}
