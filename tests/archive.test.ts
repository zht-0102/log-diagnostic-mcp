import { describe, expect, it } from "vitest";
import {
	archiveDateDirectoriesBetween,
	archiveGlobPattern,
	resolveArchiveLogFile
} from "../src/logs/archive.js";

describe("archiveDateDirectoriesBetween", () => {
	it("maps a local same-day time range to one yyMMdd directory", () => {
		const dirs = archiveDateDirectoriesBetween(
			Date.parse("2026-08-12T03:40:00+08:00"),
			Date.parse("2026-08-12T04:20:00+08:00"),
			8 * 60 * 60 * 1000
		);
		expect(dirs).toEqual(["260812"]);
	});

	it("includes every local day for cross-day ranges", () => {
		const dirs = archiveDateDirectoriesBetween(
			Date.parse("2026-08-12T23:50:00+08:00"),
			Date.parse("2026-08-13T00:10:00+08:00"),
			8 * 60 * 60 * 1000
		);
		expect(dirs).toEqual(["260812", "260813"]);
	});
});

describe("archiveGlobPattern", () => {
	it("matches the SaaS archive naming convention from the server", () => {
		expect(archiveGlobPattern("saas.log", "260812")).toBe("saas.log.260812*.gz");
	});
});

describe("resolveArchiveLogFile", () => {
	it("resolves a validated archive file path under the date directory", () => {
		expect(resolveArchiveLogFile(
			"/home/logdir/log/saas-set01",
			"saas.log",
			"260812",
			"saas.log.260812.10.gz"
		)).toEqual({
			type: "archive",
			dateDirectory: "260812",
			fileName: "saas.log.260812.10.gz",
			filePath: "/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz"
		});
	});
});
