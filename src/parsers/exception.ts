/**
 * Java 异常 / 堆栈信息提取。
 *
 * 将多行 Java 堆栈合并为单条记录，而不是只返回第一行。
 * 提取内容：
 * - 异常类型（全限定类名）
 * - 异常消息
 * - 根因（最深一层的 `Caused by:` 条目）
 * - 合并后的堆栈行（有上限）
 */

export interface ExceptionCause {
	type: string;
	message: string | null;
}

export interface ExceptionExtraction {
	/** 异常全限定类名，如 java.sql.SQLException。 */
	type: string;
	message: string | null;
	/** 最深一层的 `Caused by:` 条目；不存在时为 null。 */
	rootCause: ExceptionCause | null;
	/** 合并后的堆栈行（栈帧 + caused-by），有上限。 */
	stackTrace: string[];
	/** 异常行在输入行中的下标。 */
	lineIndex: number;
}

/** 单个异常合并的栈帧上限，避免巨大堆栈不受控。 */
export const MAX_STACK_LINES = 60;

/**
 * Java 异常全限定类名：以 Exception/Error/Throwable 结尾的点分段，
 * 如 java.sql.SQLException、
 * org.springframework.dao.DuplicateKeyException。
 */
const EXCEPTION_CLASS_RE =
	/\b((?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable))\b(?::?([^\n]*))?/;

/** 属于堆栈的续行。 */
const STACK_FRAME_RE = /^\s*(at\s|\.\.\.\s*\d+\s+more)/;
const CAUSED_BY_RE = /^\s*Caused by:\s*/;

/** 常见日志级别标记，用于接受不带限定类名的提及。 */
const ERROR_LEVEL_RE = /\b(ERROR|FATAL|SEVERE)\b/;

function parseCauseLine(line: string): ExceptionCause | null {
	const stripped = line.replace(CAUSED_BY_RE, "");
	const match = EXCEPTION_CLASS_RE.exec(stripped);
	if (!match) {
		// Caused by 后是无法归类的内容 —— 将原始文本作为 type 保留。
		return { type: stripped.trim(), message: null };
	}
	const message = match[2]?.trim() || null;
	return { type: match[1], message };
}

function isStackTraceLine(line: string): boolean {
	return STACK_FRAME_RE.test(line) || CAUSED_BY_RE.test(line);
}

/**
 * 扫描各行中的异常并合并其堆栈。
 * 候选起始行要么包含全限定异常类名，
 * 要么是紧跟栈帧的 ERROR/FATAL 级别行。
 */
export function extractExceptions(lines: string[]): ExceptionExtraction[] {
	const results: ExceptionExtraction[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const classMatch = EXCEPTION_CLASS_RE.exec(line);

		const followedByStack = i + 1 < lines.length && isStackTraceLine(lines[i + 1]);
		const isStart =
			classMatch !== null || (ERROR_LEVEL_RE.test(line) && followedByStack);
		if (!isStart) continue;

		// 合并紧随其后的堆栈。
		const stackTrace: string[] = [];
		const causes: ExceptionCause[] = [];
		let j = i + 1;
		while (j < lines.length && isStackTraceLine(lines[j])) {
			if (stackTrace.length < MAX_STACK_LINES) {
				stackTrace.push(lines[j].trimEnd());
			}
			if (CAUSED_BY_RE.test(lines[j])) {
				const cause = parseCauseLine(lines[j]);
				if (cause) causes.push(cause);
			}
			j += 1;
		}

		let type: string;
		let message: string | null;
		if (classMatch) {
			type = classMatch[1];
			message = classMatch[2]?.trim() || null;
		} else {
			// 不带类名的 ERROR 行：保留级别之后的文本。
			type = "ERROR";
			message = line.replace(/^.*\b(ERROR|FATAL|SEVERE)\b\s*/, "").trim() || null;
		}

		results.push({
			type,
			message,
			rootCause: causes.length > 0 ? causes[causes.length - 1] : null,
			stackTrace,
			lineIndex: i
		});

		// 跳过已合并的堆栈，避免栈帧被重复检测。
		i = j - 1;
	}

	return results;
}
