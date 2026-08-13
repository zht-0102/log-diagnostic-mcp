/**
 * Java exception / stack trace extraction.
 *
 * Merges multi-line Java stack traces into single records instead of
 * returning only the first line. Extracts:
 * - Exception type (fully qualified class name)
 * - Message
 * - Root cause (the deepest `Caused by:` entry)
 * - The merged stack trace lines (capped)
 */

export interface ExceptionCause {
	type: string;
	message: string | null;
}

export interface ExceptionExtraction {
	/** Fully qualified exception class, e.g. java.sql.SQLException. */
	type: string;
	message: string | null;
	/** Deepest `Caused by:` entry, or null when absent. */
	rootCause: ExceptionCause | null;
	/** Merged stack trace lines (frames + caused-by), capped. */
	stackTrace: string[];
	/** Index of the exception line within the input lines. */
	lineIndex: number;
}

/** Cap merged stack frames per exception so huge traces stay bounded. */
export const MAX_STACK_LINES = 60;

/**
 * A qualified Java exception class name: dotted segments ending in
 * Exception/Error/Throwable, e.g. java.sql.SQLException,
 * org.springframework.dao.DuplicateKeyException.
 */
const EXCEPTION_CLASS_RE =
	/\b((?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable))\b(?::?([^\n]*))?/;

/** Continuation lines that belong to a stack trace. */
const STACK_FRAME_RE = /^\s*(at\s|\.\.\.\s*\d+\s+more)/;
const CAUSED_BY_RE = /^\s*Caused by:\s*/;

/** Common log-level markers used to accept unqualified mentions. */
const ERROR_LEVEL_RE = /\b(ERROR|FATAL|SEVERE)\b/;

function parseCauseLine(line: string): ExceptionCause | null {
	const stripped = line.replace(CAUSED_BY_RE, "");
	const match = EXCEPTION_CLASS_RE.exec(stripped);
	if (!match) {
		// Caused by something we can't classify — keep raw text as type.
		return { type: stripped.trim(), message: null };
	}
	const message = match[2]?.trim() || null;
	return { type: match[1], message };
}

function isStackTraceLine(line: string): boolean {
	return STACK_FRAME_RE.test(line) || CAUSED_BY_RE.test(line);
}

/**
 * Scan lines for exceptions and merge their stack traces.
 * A candidate start line either contains a qualified exception class name,
 * or is an ERROR/FATAL level line directly followed by stack frames.
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

		// Merge the stack trace that follows.
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
			// ERROR line without a class name: keep the text after the level.
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

		// Skip past the merged stack so frames aren't re-detected.
		i = j - 1;
	}

	return results;
}
