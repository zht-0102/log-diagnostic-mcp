import { describe, expect, it } from "vitest";
import { analyzeBasics, type AnalysisInput } from "../src/analyzer/basic.js";
import type { ExceptionExtraction } from "../src/parsers/exception.js";

function baseInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
	return {
		keyword: "searchShippingOrderSummary",
		matchCount: 5,
		exceptions: [],
		sql: [],
		requestDetected: false,
		responseDetected: false,
		searchErrors: [],
		...overrides
	};
}

const dupKeyException: ExceptionExtraction = {
	type: "org.springframework.dao.DuplicateKeyException",
	message: "could not execute statement",
	rootCause: {
		type: "java.sql.SQLIntegrityConstraintViolationException",
		message: "Duplicate entry 'SO-1001' for key 'uk_order_no'"
	},
	stackTrace: ["at x.Y.z(Y.java:1)"],
	lineIndex: 3
};

describe("analyzeBasics", () => {
	it("keeps confirmed facts strictly evidence-based", () => {
		const result = analyzeBasics(baseInput({ exceptions: [dupKeyException] }));
		expect(result.confirmedFacts.join("\n")).toContain("Matched 5 log line(s)");
		expect(result.confirmedFacts.join("\n")).toContain("DuplicateKeyException");
		expect(result.confirmedFacts.join("\n")).toContain("SQLIntegrityConstraintViolationException");
		// Facts must never contain speculative language like "Possibly"
		expect(result.confirmedFacts.join("\n")).not.toContain("Possibly");
	});

	it("labels duplicate-key causes as possibilities with matching recommendations", () => {
		const result = analyzeBasics(baseInput({ exceptions: [dupKeyException] }));
		expect(result.possibleCauses.join("\n")).toMatch(/Possibly.*unique constraint/i);
		const recs = result.recommendations.join("\n");
		expect(recs).toMatch(/submitted more than once/i);
		expect(recs).toMatch(/unique key/i);
		expect(recs).toMatch(/idempotency/i);
	});

	it("handles NullPointerException with parameter-oriented advice", () => {
		const npe: ExceptionExtraction = {
			type: "java.lang.NullPointerException",
			message: "order is null",
			rootCause: null,
			stackTrace: [],
			lineIndex: 0
		};
		const result = analyzeBasics(baseInput({ exceptions: [npe] }));
		expect(result.possibleCauses.join("\n")).toMatch(/null/i);
		expect(result.recommendations.join("\n")).toMatch(/request parameters/i);
	});

	it("reports no-match situation with a widened-search recommendation", () => {
		const result = analyzeBasics(baseInput({ matchCount: 0 }));
		expect(result.confirmedFacts.join("\n")).toContain("No log lines matched");
		expect(result.recommendations.join("\n")).toMatch(/time range|keyword/i);
	});

	it("notes when no exception is found in context", () => {
		const result = analyzeBasics(baseInput());
		expect(result.confirmedFacts.join("\n")).toContain("No exception or ERROR block");
	});

	it("includes executed SQL as facts and unknown exceptions with generic advice", () => {
		const unknown: ExceptionExtraction = {
			type: "com.example.WeirdException",
			message: "hmm",
			rootCause: null,
			stackTrace: [],
			lineIndex: 0
		};
		const result = analyzeBasics(
			baseInput({
				exceptions: [unknown],
				sql: [
					{
						preparingSql: "SELECT * FROM shipping_order WHERE id = ?",
						rawParameters: "123(Long)",
						reconstructedSql: "SELECT * FROM shipping_order WHERE id = 123",
						sqlReconstructionSuccess: true,
						reconstructionNote: null
					}
				],
				requestDetected: true
			})
		);
		const facts = result.confirmedFacts.join("\n");
		expect(facts).toContain("SELECT * FROM shipping_order WHERE id = ?");
		expect(facts).toContain("Request parameters were detected");
		expect(result.recommendations.join("\n")).toMatch(/stack trace/);
	});

	it("always produces non-empty sections", () => {
		const result = analyzeBasics(baseInput());
		expect(result.confirmedFacts.length).toBeGreaterThan(0);
		expect(result.recommendations.length).toBeGreaterThan(0);
	});
});
