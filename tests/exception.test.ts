import { describe, expect, it } from "vitest";
import { extractExceptions, MAX_STACK_LINES } from "../src/parsers/exception.js";

describe("extractExceptions", () => {
	it("extracts a simple exception with message", () => {
		const lines = [
			"2026-08-13 10:01:03.000 ERROR o.e.s.ShippingService - lookup failed",
			"java.lang.NullPointerException: order is null",
			"\tat com.example.shipping.ShippingService.lookup(ShippingService.java:42)",
			"\tat com.example.shipping.Controller.handle(Controller.java:10)"
		];
		const results = extractExceptions(lines);
		expect(results.length).toBeGreaterThanOrEqual(1);

		const npe = results.find((r) => r.type === "java.lang.NullPointerException");
		expect(npe).toBeDefined();
		expect(npe!.message).toBe("order is null");
		expect(npe!.stackTrace.length).toBe(2);
		expect(npe!.stackTrace[0]).toContain("ShippingService.lookup");
	});

	it("merges Caused by chain and reports the deepest root cause", () => {
		const lines = [
			"org.springframework.dao.DuplicateKeyException: could not execute statement",
			"\tat org.hibernate.internal.ExceptionConverterImpl.convert(ExceptionConverterImpl.java:1)",
			"Caused by: java.sql.SQLIntegrityConstraintViolationException: Duplicate entry 'SO-1001' for key 'uk_order_no'",
			"\tat com.mysql.cj.jdbc.exceptions.SQLExceptionsMapping.translate(SQLExceptionsMapping.java:2)",
			"\t... 12 more"
		];
		const results = extractExceptions(lines);
		expect(results).toHaveLength(1);
		const ex = results[0];
		expect(ex.type).toBe("org.springframework.dao.DuplicateKeyException");
		expect(ex.rootCause).not.toBeNull();
		expect(ex.rootCause!.type).toBe("java.sql.SQLIntegrityConstraintViolationException");
		expect(ex.rootCause!.message).toContain("Duplicate entry");
		// 栈帧、caused-by 与 "... N more" 全部被合并。
		expect(ex.stackTrace.length).toBe(4);
	});

	it("handles multiple nested Caused by (reports the deepest)", () => {
		const lines = [
			"com.example.TopException: top",
			"\tat a.B.c(B.java:1)",
			"Caused by: com.example.MidException: mid",
			"\tat d.E.f(E.java:2)",
			"Caused by: java.io.IOException: disk full",
			"\tat g.H.i(H.java:3)"
		];
		const results = extractExceptions(lines);
		expect(results).toHaveLength(1);
		expect(results[0].rootCause!.type).toBe("java.io.IOException");
		expect(results[0].rootCause!.message).toBe("disk full");
	});

	it("detects an ERROR line followed by frames even without a class name", () => {
		const lines = [
			"2026-08-13 10:01:04.000 ERROR some generic failure happened",
			"\tat com.example.Foo.bar(Foo.java:5)"
		];
		const results = extractExceptions(lines);
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe("ERROR");
		expect(results[0].message).toContain("generic failure");
		expect(results[0].stackTrace.length).toBe(1);
	});

	it("does not flag ordinary INFO lines as exceptions", () => {
		const lines = ["2026-08-13 10:01:05.000 INFO  all good, nothing to report"];
		expect(extractExceptions(lines)).toEqual([]);
	});

	it("detects common exception types by name", () => {
		const types = [
			"java.sql.SQLException: connection refused",
			"java.util.concurrent.TimeoutException: timed out",
			"org.springframework.dao.DuplicateKeyException: dup"
		];
		for (const line of types) {
			const results = extractExceptions([line]);
			expect(results.length, `expected detection of: ${line}`).toBe(1);
		}
	});

	it("caps merged stack trace length", () => {
		const frames = Array.from({ length: MAX_STACK_LINES + 50 }, (_, i) => `\tat com.x.Y.z(Y.java:${i})`);
		const results = extractExceptions(["java.lang.RuntimeException: boom", ...frames]);
		expect(results[0].stackTrace.length).toBe(MAX_STACK_LINES);
	});

	it("does not double-count frames as separate exceptions", () => {
		const lines = [
			"java.lang.IllegalStateException: bad state",
			"\tat com.example.A.a(A.java:1)",
			"\tat com.example.B.b(B.java:2)"
		];
		expect(extractExceptions(lines)).toHaveLength(1);
	});
});
