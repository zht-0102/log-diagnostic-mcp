import { describe, expect, it } from "vitest";
import { extractRequestParameters, extractBalancedJson, tryParseJson } from "../src/parsers/request.js";
import { extractResponse, MAX_RESPONSE_CHARS } from "../src/parsers/response.js";

describe("extractBalancedJson", () => {
	it("extracts a balanced object ignoring nested structures", () => {
		const text = 'prefix {"a":{"b":[1,2]}} suffix';
		const start = text.indexOf("{");
		expect(extractBalancedJson(text, start)).toBe('{"a":{"b":[1,2]}}');
	});

	it("handles braces inside strings", () => {
		const text = '{"msg":"weird } brace","n":1}';
		expect(extractBalancedJson(text, 0)).toBe(text);
	});

	it("handles escaped quotes", () => {
		const text = '{"msg":"say \\"hi\\"","n":1}';
		expect(extractBalancedJson(text, 0)).toBe(text);
	});

	it("returns null when unbalanced", () => {
		expect(extractBalancedJson('{"a": 1', 0)).toBeNull();
	});
});

describe("tryParseJson", () => {
	it("parses standard JSON", () => {
		expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
	});

	it("parses single-quoted JSON variants", () => {
		expect(tryParseJson("{'a':1}")).toEqual({ a: 1 });
	});

	it("returns null for garbage", () => {
		expect(tryParseJson("{a:")).toBeNull();
	});
});

describe("extractRequestParameters", () => {
	it("extracts JSON after Request: marker", () => {
		const lines = [
			"2026-08-13 10:01:01.000 INFO  request received",
			'2026-08-13 10:01:01.001 DEBUG Request: {"orderId":123,"type":"EXPRESS"}'
		];
		const result = extractRequestParameters(lines);
		expect(result.detectedMarker).toBe("Request:");
		expect(result.parameters).toEqual({ orderId: 123, type: "EXPRESS" });
	});

	it("extracts array payloads after args:", () => {
		const lines = ["DEBUG args: [123, \"abc\", true]"];
		const result = extractRequestParameters(lines);
		expect(result.parameters).toEqual([123, "abc", true]);
	});

	it("supports RequestBody marker", () => {
		const lines = ['INFO RequestBody: {"userId":9}'];
		const result = extractRequestParameters(lines);
		expect(result.detectedMarker).toBe("RequestBody:");
		expect(result.parameters).toEqual({ userId: 9 });
	});

	it("returns null fields when nothing detected (never fabricates)", () => {
		const lines = ["INFO nothing to see here", "DEBUG just tracing"];
		const result = extractRequestParameters(lines);
		expect(result.parameters).toBeNull();
		expect(result.rawSource).toBeNull();
		expect(result.detectedMarker).toBeNull();
	});

	it("ignores markers without JSON payload", () => {
		const lines = ["DEBUG Parameters: 123(Long)"];
		const result = extractRequestParameters(lines);
		expect(result.parameters).toBeNull();
	});
});

describe("extractResponse", () => {
	it("extracts structured JSON response", () => {
		const lines = ['INFO Response: {"code":200,"data":{"total":5}}'];
		const result = extractResponse(lines);
		expect(result.detectedMarker).toBe("Response:");
		expect(result.responseTruncated).toBe(false);
		expect(result.body).toEqual({ code: 200, data: { total: 5 } });
	});

	it("supports Result and Return markers", () => {
		expect(extractResponse(["DEBUG Result: {\"ok\":true}"]).body).toEqual({ ok: true });
		expect(extractResponse(["DEBUG Return: {\"ok\":false}"]).body).toEqual({ ok: false });
	});

	it("keeps raw text for non-JSON responses", () => {
		const result = extractResponse(["INFO Response: OK, 5 records"]);
		expect(result.body).toBe("OK, 5 records");
		expect(result.responseTruncated).toBe(false);
	});

	it("truncates huge responses and flags responseTruncated", () => {
		const huge = `{"data":"${"x".repeat(MAX_RESPONSE_CHARS + 1000)}"}`;
		const result = extractResponse([`INFO Response: ${huge}`]);
		expect(result.responseTruncated).toBe(true);
		expect(typeof result.body).toBe("string");
		expect((result.body as string).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
	});

	it("returns null body when no response marker exists", () => {
		const result = extractResponse(["INFO nothing"]);
		expect(result.body).toBeNull();
		expect(result.detectedMarker).toBeNull();
		expect(result.responseTruncated).toBe(false);
	});
});
