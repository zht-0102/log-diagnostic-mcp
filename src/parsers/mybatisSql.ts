/**
 * MyBatis SQL 日志解析与还原。
 *
 * 处理常见的 MyBatis stdout 日志对：
 *   ... DEBUG ... ==>  Preparing: SELECT * FROM shipping_order WHERE id = ?
 *   ... DEBUG ... ==>  Parameters: 123(Long), 'abc'(String)
 *
 * 支持的参数类型（MVP）：String、Integer、Long、Boolean、
 * BigDecimal、Double、Float、Short、Byte、Date、Timestamp、null。
 *
 * 无法可靠还原时，结果会以 `sqlReconstructionSuccess: false` 标记 ——
 * 绝不凭空捏造。
 */

export interface SqlExtraction {
	/** 带 `?` 占位符的 SQL 模板，即日志中记录的原文。 */
	preparingSql: string | null;
	/** 原始参数字符串，如 `123(Long), 'abc'(String)`。 */
	rawParameters: string | null;
	/** 代入参数后的 SQL；还原失败时为 null。 */
	reconstructedSql: string | null;
	sqlReconstructionSuccess: boolean;
	/** 还原失败时的人类可读说明。 */
	reconstructionNote: string | null;
}

const PREPARING_MARKER = "Preparing:";
const PARAMETERS_MARKER = "Parameters:";

/**
 * 将 MyBatis `Parameters:` 的值解析为带类型的条目。
 * 格式：以 ", " 分隔的 `value(Type)`；null 参数直接显示为 `null`。
 * 字符串不像 MyBatis 参数列表时返回 null。
 */
export function parseMyBatisParameters(
	raw: string
): Array<{ value: string; type: string }> | null {
	const trimmed = raw.trim();
	if (trimmed === "") return [];

	const entries: Array<{ value: string; type: string }> = [];
	// 按 ", " 切分，同时跟踪括号深度，使引号内含逗号的值
	// 也能尽量正确解析（尽力而为）。
	const parts = splitParameterList(trimmed);
	for (const part of parts) {
		const trimmedPart = part.trim();
		// MyBatis 将 null 参数记录为不带类型的裸 `null`。
		if (trimmedPart === "null") {
			entries.push({ value: "null", type: "null" });
			continue;
		}
		const match = /^(.*)\(([\w[\]]+)\)$/.exec(trimmedPart);
		if (!match) {
			// 不是带类型的条目 —— 整体视为无法解析。
			return null;
		}
		entries.push({ value: match[1], type: match[2] });
	}
	return entries;
}

/** 按顶层的 ", " 分隔符切分 `a(T), b(T)`。 */
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
			i += 1; // 跳过空格
			continue;
		}
		current += ch;
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

/** 将字符串转义为可嵌入 SQL 字面量的形式。 */
function escapeSqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** 将单个带类型参数渲染为 SQL 字面量；未知类型返回 null。 */
export function renderSqlLiteral(value: string, type: string): string | null {
	if (value === "null") return "NULL";

	switch (type) {
		case "String":
		case "Date":
		case "Timestamp":
		case "LocalDate":
		case "LocalDateTime": {
			// MyBatis 记录的字符串类参数已经包在单引号中，
			// 内部引号以双写转义。先去掉外层引号，再重新转义。
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
			// 未知类型 —— 拒绝猜测。
			return null;
	}
}

/**
 * 将 `?` 占位符替换为渲染后的字面量。
 * 占位符数量不匹配或类型不支持时返回 null。
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
 * 扫描上下文行中的 Preparing/Parameters 配对并还原 SQL。
 * 支持多个配对；每个配对生成一条 SqlExtraction。
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

	// 只有 Preparing 而没有后续 Parameters 行：上报但不还原。
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
