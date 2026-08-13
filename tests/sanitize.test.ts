import { describe, expect, it } from "vitest";
import { maskLine, maskLines, maskDeep, MASK } from "../src/security/sanitize.js";

describe("maskLine", () => {
	it("masks password in key=value form", () => {
		expect(maskLine("login?user=abc&password=s3cr3t&next=home")).toBe(
			`login?user=abc&password=${MASK}&next=home`
		);
	});

	it("masks token in JSON form keeping quotes", () => {
		expect(maskLine('{"token":"abc123","name":"x"}')).toBe(`{"token":"${MASK}","name":"x"}`);
	});

	it("masks Authorization Bearer headers", () => {
		expect(maskLine("Authorization: Bearer abc.def.ghi")).toBe(`Authorization: Bearer ${MASK}`);
	});

	it("masks Cookie values", () => {
		const masked = maskLine("Cookie: JSESSIONID=abc123; theme=dark");
		expect(masked).toContain(`****`);
		expect(masked).not.toContain("abc123");
	});

	it("masks accessKey/secretKey pairs", () => {
		const masked = maskLine("accessKey=AKID123456 secretKey=xyz987");
		expect(masked).not.toContain("AKID123456");
		expect(masked).not.toContain("xyz987");
	});

	it("masks floating JWT tokens", () => {
		const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM";
		const masked = maskLine(`auth ok ${jwt} done`);
		expect(masked).not.toContain(jwt);
		expect(masked).toContain(MASK);
	});

	it("leaves non-sensitive content untouched", () => {
		const line = "2026-08-13 10:01:02 INFO  searchShippingOrderSummary called with orderId=123";
		expect(maskLine(line)).toBe(line);
	});
});

describe("maskLines", () => {
	it("masks every line", () => {
		const masked = maskLines(["password=abc", "normal line"]);
		expect(masked[0]).toContain(MASK);
		expect(masked[1]).toBe("normal line");
	});
});

describe("maskDeep", () => {
	it("masks string values under sensitive keys in objects", () => {
		const masked = maskDeep({ password: "abc", nested: { token: "t0k3n" }, ok: 1 });
		expect(masked).toEqual({ password: MASK, nested: { token: MASK }, ok: 1 });
	});

	it("masks strings inside arrays", () => {
		const masked = maskDeep(["plain", "password=hunter2"]);
		expect(masked[1]).toContain(MASK);
	});

	it("preserves non-string primitives", () => {
		expect(maskDeep({ count: 3, flag: true, nothing: null })).toEqual({
			count: 3,
			flag: true,
			nothing: null
		});
	});
});
