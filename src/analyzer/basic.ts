/**
 * 基础错误分析。
 *
 * 严格基于证据，分三部分：
 * - confirmedFacts：由提取到的日志直接证实的事实
 * - possibleCauses：推断，始终标注为可能性
 * - recommendations：接下来可具体执行的排查项
 *
 * 猜测绝不会被表述为事实。某部分没有证据时，
 * 会如实说明，而不是编造内容。
 */

import type { ExceptionExtraction } from "../parsers/exception.js";
import type { SqlExtraction } from "../parsers/mybatisSql.js";

export interface AnalysisInput {
	keyword: string;
	matchCount: number;
	exceptions: ExceptionExtraction[];
	sql: SqlExtraction[];
	requestDetected: boolean;
	responseDetected: boolean;
	/** 搜索过程中收集到的服务端错误。 */
	searchErrors: string[];
}

export interface AnalysisResult {
	confirmedFacts: string[];
	possibleCauses: string[];
	recommendations: string[];
}

/** 已知异常家族 → （可能原因、建议）。 */
const EXCEPTION_KNOWLEDGE: Array<{
	match: (ex: ExceptionExtraction) => boolean;
	cause: string;
	recommendations: string[];
}> = [
	{
		match: (ex) =>
			/DuplicateKeyException|SQLIntegrityConstraintViolationException/.test(ex.type) ||
			/Duplicate entry/i.test(ex.rootCause?.message ?? ex.message ?? ""),
		cause: "Duplicate data violates a database unique constraint (e.g. repeated insert of the same business key)",
		recommendations: [
			"Check whether the request was submitted more than once (retry / double-click / MQ redelivery)",
			"Verify which unique key is conflicted (shown in the exception message)",
			"Check whether the business flow has idempotency control before insert"
		]
	},
	{
		match: (ex) => /NullPointerException/.test(ex.type),
		cause: "Code dereferenced a null value; the missing value often comes from input parameters, a cache miss or an upstream query returning nothing",
		recommendations: [
			"Inspect the request parameters extracted from the log to see which field may be null",
			"Look at the first stack frame in business code to locate the dereference",
			"Check whether an upstream query/lookup unexpectedly returned empty"
		]
	},
	{
		match: (ex) => /TimeoutException|SocketTimeoutException|ConnectTimeoutException/.test(ex.type + (ex.rootCause?.type ?? "")),
		cause: "A downstream call (HTTP / RPC / database) did not respond within its timeout",
		recommendations: [
			"Check the health and latency of the downstream service/database at that time",
			"Review configured timeout values",
			"Look for connection pool exhaustion or GC pauses around the same timestamp"
		]
	},
	{
		match: (ex) =>
			/SQLException|DataAccessException|JDBCConnectionException/.test(ex.type + (ex.rootCause?.type ?? "")) &&
			/connection|refused|reset|unavailable/i.test((ex.rootCause?.message ?? ex.message ?? "") ?? ""),
		cause: "Database connection problem (refused / reset / pool exhausted)",
		recommendations: [
			"Check database availability and network between app server and DB",
			"Check connection pool usage and max size",
			"Check whether the DB was restarting or failing over at that time"
		]
	},
	{
		match: (ex) => /OutOfMemoryError/.test(ex.type + (ex.rootCause?.type ?? "")),
		cause: "JVM ran out of memory; often caused by large result sets, leaks or undersized heap",
		recommendations: [
			"Check heap settings and recent GC logs",
			"Look for unusually large queries/exports near that time",
			"Check whether the process was restarted afterwards"
		]
	}
];

/** 仅基于提取到的证据生成三段式分析。 */
export function analyzeBasics(input: AnalysisInput): AnalysisResult {
	const confirmedFacts: string[] = [];
	const possibleCauses: string[] = [];
	const recommendations: string[] = [];

	// --- 来自搜索本身的事实 ---
	if (input.matchCount === 0) {
		confirmedFacts.push(`No log lines matched keyword "${input.keyword}" in the searched window.`);
		recommendations.push("Widen the time range or try a shorter/different keyword (e.g. part of a business id).");
	} else {
		confirmedFacts.push(`Matched ${input.matchCount} log line(s) for keyword "${input.keyword}".`);
	}

	if (input.searchErrors.length > 0) {
		confirmedFacts.push(`Some servers/paths could not be fully searched: ${input.searchErrors.join("; ")}`);
	}

	// --- 来自请求/响应提取的事实 ---
	if (input.requestDetected) {
		confirmedFacts.push("Request parameters were detected near the matched lines.");
	}
	if (input.responseDetected) {
		confirmedFacts.push("A response payload was detected near the matched lines.");
	}

	// --- 来自 SQL 的事实与原因 ---
	for (const sql of input.sql) {
		if (sql.preparingSql) {
			confirmedFacts.push(`Executed SQL (MyBatis): ${sql.preparingSql}`);
		}
		if (!sql.sqlReconstructionSuccess && sql.reconstructionNote) {
			confirmedFacts.push(`SQL parameter reconstruction failed: ${sql.reconstructionNote}`);
		}
	}

	// --- 来自异常的事实、原因与建议 ---
	if (input.exceptions.length === 0) {
		if (input.matchCount > 0) {
			confirmedFacts.push("No exception or ERROR block was found in the returned context.");
			recommendations.push(
				"If an error is still suspected, increase contextAfter or search the same keyword with a wider time range."
			);
		}
	} else {
		for (const ex of input.exceptions) {
			const message = ex.message ? `: ${ex.message}` : "";
			confirmedFacts.push(`Exception occurred: ${ex.type}${message}`);
			if (ex.rootCause) {
				const causeMessage = ex.rootCause.message ? `: ${ex.rootCause.message}` : "";
				confirmedFacts.push(`Root cause in chain: ${ex.rootCause.type}${causeMessage}`);
			}

			const known = EXCEPTION_KNOWLEDGE.find((k) => k.match(ex));
			if (known) {
				possibleCauses.push(`Possibly: ${known.cause}`);
				recommendations.push(...known.recommendations);
			} else {
				recommendations.push(
					`Read the merged stack trace of ${ex.type} to find the first business-code frame, and correlate with the request parameters above.`
				);
			}
		}
	}

	// --- 通用兑底，保证各部分绝不会被静默留空 ---
	if (possibleCauses.length === 0 && input.exceptions.length > 0) {
		possibleCauses.push("Possibly: an application bug or invalid input; no known pattern matched, see the stack trace.");
	}
	if (recommendations.length === 0) {
		recommendations.push("No specific recommendation: the matched logs show no obvious error.");
	}

	return { confirmedFacts, possibleCauses, recommendations };
}
