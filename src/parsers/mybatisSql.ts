/**
 * MyBatis SQL log parsing and reconstruction.
 *
 * Handles the common MyBatis stdout log pair:
 *   ... DEBUG ... ==>  Preparing: SELECT * FROM shipping_order WHERE id = ?
 *   ... DEBUG ... ==>  Parameters: 123(Long), 'abc'(String)
 *
 * Supported parameter types (MVP): String, Integer, Long, Boolean,
 * BigDecimal, Double, Float, Short, Byte, Date, Timestamp, null.
 *
 * When reconstruction cannot be done reliably, the result is flagged with
 * `sqlReconstructionSuccess: false` — never fabricated.
 */

export interface SqlExtraction {
	/** The SQL template with `?` placeholders, as logged. */
	preparingSql: string | null;
	/** Raw parameter string, e.g. `123(Long), 'abc'(String)`. */
	rawParameters: string | null;
	/** SQL with parameters substituted, or null when reconstruction failed. */
	reconstructedSql: string | null;
	sqlReconstructionSuccess: boolean;
	/** Human-readable note when reconstruction failed. */
	reconstructionNote: string | null;
}

const PREPARING_MARKER = "Preparing:";
const PARAMETERS_MARKER = "Parameters:";

/**
 * Parse a MyBatis `Parameters:` value into typed entries.
 * Format: `value(Type)` separated by ", ". null parameters appear as `null`.
 * Returns null when the string doesn't look like a MyBatis parameter list.
 */
export function parseMyBatisParameters(
	raw: string
): Array<{ value: string; type: string }> | null {
	const trimmed = raw.trim();
	if (trimmed === "") return [];

	const entries: Array<{ value: string; type: string }> = [];
	// Split on ", " but keep track of parentheses depth so values containing
	// commas inside quotes still parse (best effort).
	const parts = splitParameterList(trimmed);
	for (const part of parts) {
		const trimmedPart = part.trim();
		// MyBatis logs null parameters as a bare `null` without a type.
		if (trimmedPart === "null") {
			entries.push({ value: "null", type: "null" });
			continue;
		}
		const match = /^(.*)\(([\w[\]]+)\)$/.exec(trimmedPart);
		if (!match) {
			// Not a typed entry — treat whole thing as unparseable.
			return null;
		}
		entries.push({ value: match[1], type: match[2] });
	}
	return entries;
}

/** Split `a(T), b(T)` on top-level ", " separators. */
function splitParameterList(raw: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let inQuote = false;
	let current = "";

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "'" && raw[i - 1] !== "\\") inQuote = !inQuote;
		if (!inQuote) {
			if (ch === "(") depth += 1;
			else if (ch === ")") depth -= 1;
		}
		if (!inQuote && depth === 0 && ch === "," && raw[i + 1] === " ") {
			parts.push(current);
			current = "";
			i += 1; // skip the space
			continue;
		}
		current += ch;
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

/** Escape a string for embedding in SQL literal form. */
function escapeSqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** Render one typed parameter as its SQL literal. Returns null for unknown types. */
export function renderSqlLiteral(value: string, type: string): string | null {
	if (value === "null") return "NULL";

	switch (type) {
		case "String":
		case "Date":
		case "Timestamp":
		case "LocalDate":
		case "LocalDateTime": {
			// MyBatis logs string-ish parameters already wrapped in single quotes,
			// escaping inner quotes by doubling them. Strip, then re-escape.
			let inner = value;
			if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'")) {
				inner = inner.slice(1, -1).replace(/''/g, "'");
			}
			return escapeSqlString(inner);
		}
		case "Integer":
		case "Long":
		case "Short":
		case "Byte":
		case "Boolean": {
			if (type === "Boolean") {
				return value === "true" ? "TRUE" : value === "false" ? "FALSE" : null;
			}
			return /^-?\d+$/.test(value) ? value : null;
		}
		case "BigDecimal":
		case "Double":
		case "Float":
			return /^-?\d+(\.\d+)?$/.test(value) ? value : null;
		default:
			// Unknown type — refuse to guess.
			return null;
	}
}

/**
 * Substitute `?` placeholders with rendered literals.
 * Returns null when the placeholder count mismatches or a type is unsupported.
 */
export function reconstructSql(
	preparingSql: string,
	entries: Array<{ value: string; type: string }>
): { sql: string | null; note: string | null } {
	const placeholderCount = (preparingSql.match(/\?/g) ?? []).length;
	if (placeholderCount !== entries.length) {
		return {
			sql: null,
			note: `Placeholder count (${placeholderCount}) does not match parameter count (${entries.length})`
		};
	}

	let index = 0;
	let failed: string | null = null;
	const sql = preparingSql.replace(/\?/g, () => {
		const entry = entries[index];
		index += 1;
		const literal = renderSqlLiteral(entry.value, entry.type);
		if (literal === null) {
			failed = `Unsupported or invalid parameter: ${entry.value}(${entry.type})`;
			return "?";
		}
		return literal;
	});

	if (failed !== null) {
		return { sql: null, note: failed };
	}
	return { sql, note: null };
}

/**
 * Scan context lines for a Preparing/Parameters pair and reconstruct SQL.
 * Multiple pairs are supported; each becomes one SqlExtraction entry.
 */
export function extractMyBatisSql(lines: string[]): SqlExtraction[] {
	const results: SqlExtraction[] = [];
	let pendingPreparing: string | null = null;

	for (const line of lines) {
		const preparingIndex = line.indexOf(PREPARING_MARKER);
		if (preparingIndex !== -1) {
			pendingPreparing = line.slice(preparingIndex + PREPARING_MARKER.length).trim();
			continue;
		}

		const parametersIndex = line.indexOf(PARAMETERS_MARKER);
		if (parametersIndex !== -1 && pendingPreparing !== null) {
			const rawParameters = line.slice(parametersIndex + PARAMETERS_MARKER.length).trim();
			const entries = parseMyBatisParameters(rawParameters);

			if (entries === null) {
				results.push({
					preparingSql: pendingPreparing,
					rawParameters,
					reconstructedSql: null,
					sqlReconstructionSuccess: false,
					reconstructionNote: "Parameters line is not in MyBatis typed format"
				});
			} else {
				const { sql, note } = reconstructSql(pendingPreparing, entries);
				results.push({
					preparingSql: pendingPreparing,
					rawParameters,
					reconstructedSql: sql,
					sqlReconstructionSuccess: sql !== null,
					reconstructionNote: note
				});
			}
			pendingPreparing = null;
		}
	}

	// A Preparing without a following Parameters line: report but don't reconstruct.
	if (pendingPreparing !== null) {
		results.push({
			preparingSql: pendingPreparing,
			rawParameters: null,
			reconstructedSql: null,
			sqlReconstructionSuccess: false,
			reconstructionNote: "No Parameters line found after Preparing"
		});
	}

	return results;
}
