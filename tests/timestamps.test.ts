import { describe, expect, it } from "vitest";
import {
	parseLineTimestamp,
	parseQueryTime,
	isWithinWindow,
	resolveTimeWindow
} from "../src/logs/timestamps.js";

describe("parseLineTimestamp", () => {
	it("parses common Java log timestamps", () => {
		expect(parseLineTimestamp("2026-08-13 10:01:02.123 INFO start")).toBe("2026-08-13T10:01:02.123");
		expect(parseLineTimestamp("2026-08-13 10:01:02 INFO start")).toBe("2026-08-13T10:01:02.000");
	});

	it("parses ISO 8601 with offsets", () => {
		expect(parseLineTimestamp("2026-08-13T10:01:02.123+08:00 INFO x")).toBe("2026-08-13T10:01:02.123+08:00");
		expect(parseLineTimestamp("2026-08-13T02:01:02Z INFO x")).toBe("2026-08-13T02:01:02.000Z");
	});

	it("parses slash-separated dates", () => {
		expect(parseLineTimestamp("2026/08/13 10:01:02 some log")).toBe("2026-08-13T10:01:02.000");
	});

	it("returns null for lines without timestamps", () => {
		expect(parseLineTimestamp("\tat com.example.Foo.bar(Foo.java:12)")).toBeNull();
		expect(parseLineTimestamp("Caused by: java.lang.Exception")).toBeNull();
	});

	it("rejects impossible dates", () => {
		expect(parseLineTimestamp("2026-13-45 99:99:99")).toBeNull();
	});
});

describe("parseQueryTime / resolveTimeWindow", () => {
	it("parses valid ISO boundaries", () => {
		const date = parseQueryTime("2026-08-13T10:00:00+08:00", "startTime");
		expect(date.getTime()).toBe(Date.parse("2026-08-13T10:00:00+08:00"));
	});

	it("throws on invalid boundaries", () => {
		expect(() => parseQueryTime("not-a-time", "startTime")).toThrow(/Invalid startTime/);
		expect(() => parseQueryTime("yesterday", "endTime")).toThrow(/Invalid endTime/);
	});

	it("defaults startTime to 30 minutes before endTime", () => {
		const { startMs, endMs } = resolveTimeWindow(undefined, "2026-08-13T10:30:00Z");
		expect(endMs - startMs).toBe(30 * 60 * 1000);
	});

	it("rejects start after end", () => {
		expect(() =>
			resolveTimeWindow("2026-08-13T11:00:00Z", "2026-08-13T10:00:00Z")
		).toThrow(/must not be after/);
	});
});

describe("isWithinWindow", () => {
	const startMs = Date.parse("2026-08-13T02:00:00Z");
	const endMs = Date.parse("2026-08-13T02:30:00Z");
	const OFFSET_8H = 8 * 60 * 60 * 1000;

	it("keeps lines without timestamps (conservative)", () => {
		expect(isWithinWindow(null, startMs, endMs, OFFSET_8H)).toBe(true);
	});

	it("compares zoned timestamps as absolute instants", () => {
		// 10:15+08:00 == 02:15Z → inside
		expect(isWithinWindow("2026-08-13T10:15:00.000+08:00", startMs, endMs, OFFSET_8H)).toBe(true);
		// 11:15+08:00 == 03:15Z → outside
		expect(isWithinWindow("2026-08-13T11:15:00.000+08:00", startMs, endMs, OFFSET_8H)).toBe(false);
	});

	it("compares zone-less timestamps using the assumed local offset", () => {
		// 10:15 local (+08:00) == 02:15Z → inside
		expect(isWithinWindow("2026-08-13T10:15:00.000", startMs, endMs, OFFSET_8H)).toBe(true);
		// 09:15 local (+08:00) == 01:15Z → outside
		expect(isWithinWindow("2026-08-13T09:15:00.000", startMs, endMs, OFFSET_8H)).toBe(false);
	});
});
