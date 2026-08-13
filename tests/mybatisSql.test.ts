import { describe, expect, it } from "vitest";
import {
	extractMyBatisSql,
	parseMyBatisParameters,
	renderSqlLiteral,
	reconstructSql
} from "../src/parsers/mybatisSql.js";

describe("parseMyBatisParameters", () => {
	it("parses typed entries", () => {
		expect(parseMyBatisParameters("123(Long), 'abc'(String)")).toEqual([
			{ value: "123", type: "Long" },
			{ value: "'abc'", type: "String" }
		]);
	});

	it("parses bare null as null entry", () => {
		expect(parseMyBatisParameters("null")).toEqual([{ value: "null", type: "null" }]);
		expect(parseMyBatisParameters("1(Integer), null")).toEqual([
			{ value: "1", type: "Integer" },
			{ value: "null", type: "null" }
		]);
	});

	it("handles values containing commas inside quotes", () => {
		const parsed = parseMyBatisParameters("'a, b'(String), 2(Integer)");
		expect(parsed).toEqual([
			{ value: "'a, b'", type: "String" },
			{ value: "2", type: "Integer" }
		]);
	});

	it("returns null for non-typed garbage", () => {
		expect(parseMyBatisParameters("some free text")).toBeNull();
	});
});

describe("renderSqlLiteral", () => {
	it("renders numeric types", () => {
		expect(renderSqlLiteral("123", "Long")).toBe("123");
		expect(renderSqlLiteral("-5", "Integer")).toBe("-5");
		expect(renderSqlLiteral("3.14", "BigDecimal")).toBe("3.14");
	});

	it("rejects non-numeric content for numeric types", () => {
		expect(renderSqlLiteral("12; DROP TABLE x", "Long")).toBeNull();
	});

	it("renders booleans", () => {
		expect(renderSqlLiteral("true", "Boolean")).toBe("TRUE");
		expect(renderSqlLiteral("false", "Boolean")).toBe("FALSE");
	});

	it("renders null", () => {
		expect(renderSqlLiteral("null", "String")).toBe("NULL");
	});

	it("refuses unknown types", () => {
		expect(renderSqlLiteral("blob-data", "Blob")).toBeNull();
	});
});

describe("reconstructSql", () => {
	it("substitutes placeholders in order", () => {
		const { sql } = reconstructSql("SELECT * FROM t WHERE a = ? AND b = ?", [
			{ value: "1", type: "Integer" },
			{ value: "'x'", type: "String" }
		]);
		expect(sql).toBe("SELECT * FROM t WHERE a = 1 AND b = 'x'");
	});

	it("fails when counts mismatch", () => {
		const { sql, note } = reconstructSql("SELECT * FROM t WHERE a = ?", []);
		expect(sql).toBeNull();
		expect(note).toContain("does not match");
	});
});

describe("extractMyBatisSql", () => {
	it("extracts and reconstructs a Preparing/Parameters pair", () => {
		const lines = [
			"2026-08-13 10:01:02.300 DEBUG ==>  Preparing: SELECT * FROM shipping_order WHERE id = ?",
			"2026-08-13 10:01:02.310 DEBUG ==>  Parameters: 123(Long)"
		];
		const results = extractMyBatisSql(lines);
		expect(results).toHaveLength(1);
		expect(results[0].preparingSql).toBe("SELECT * FROM shipping_order WHERE id = ?");
		expect(results[0].rawParameters).toBe("123(Long)");
		expect(results[0].reconstructedSql).toBe("SELECT * FROM shipping_order WHERE id = 123");
		expect(results[0].sqlReconstructionSuccess).toBe(true);
	});

	it("reconstructs mixed-type parameter lists", () => {
		const lines = [
			"DEBUG Preparing: INSERT INTO t(name, price, active, note) VALUES (?, ?, ?, ?)",
			"DEBUG Parameters: 'O-1001'(String), 99.5(BigDecimal), true(Boolean), null"
		];
		const results = extractMyBatisSql(lines);
		expect(results[0].sqlReconstructionSuccess).toBe(true);
		expect(results[0].reconstructedSql).toBe(
			"INSERT INTO t(name, price, active, note) VALUES ('O-1001', 99.5, TRUE, NULL)"
		);
	});

	it("flags failure without fabricating when types are unsupported", () => {
		const lines = [
			"DEBUG Preparing: UPDATE t SET data = ? WHERE id = ?",
			"DEBUG Parameters: [B@1a2b3c(byte[]), 1(Long)"
		];
		const results = extractMyBatisSql(lines);
		expect(results[0].sqlReconstructionSuccess).toBe(false);
		expect(results[0].reconstructedSql).toBeNull();
		expect(results[0].reconstructionNote).toContain("Unsupported");
	});

	it("reports Preparing without Parameters as non-reconstructable", () => {
		const lines = ["DEBUG Preparing: SELECT 1"];
		const results = extractMyBatisSql(lines);
		expect(results).toHaveLength(1);
		expect(results[0].sqlReconstructionSuccess).toBe(false);
		expect(results[0].reconstructionNote).toContain("No Parameters line");
	});

	it("returns empty array when no SQL logs exist", () => {
		expect(extractMyBatisSql(["INFO no sql here"])).toEqual([]);
	});

	it("extracts multiple SQL pairs", () => {
		const lines = [
			"DEBUG Preparing: SELECT 1 FROM dual",
			"DEBUG Parameters: ",
			"DEBUG Preparing: SELECT 2 FROM dual WHERE x = ?",
			"DEBUG Parameters: 2(Integer)"
		];
		const results = extractMyBatisSql(lines);
		expect(results).toHaveLength(2);
		expect(results[0].reconstructedSql).toBe("SELECT 1 FROM dual");
		expect(results[1].reconstructedSql).toBe("SELECT 2 FROM dual WHERE x = 2");
	});
});
