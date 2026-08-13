import { describe, expect, it } from "vitest";
import {
	buildGzipCatCommand,
	buildGzipGrepCommand,
	buildGzipTailCommand,
	buildListArchiveLogFilesCommand
} from "../src/ssh/commands.js";

describe("gzip log commands", () => {
	it("builds a read-only gzip grep command for archived logs", () => {
		expect(buildGzipGrepCommand("2832996880440973688", "/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz")).toBe(
			"gzip -cd '/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz' | grep -n -F -e '2832996880440973688'"
		);
	});

	it("builds a read-only gzip tail command for archived log context", () => {
		expect(buildGzipTailCommand(20000, "/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz")).toBe(
			"gzip -cd '/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz' | tail -n 20000"
		);
	});

	it("builds a read-only gzip cat command for exact line-number context", () => {
		expect(buildGzipCatCommand("/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz")).toBe(
			"gzip -cd '/home/logdir/log/saas-set01/260812/saas.log.260812.10.gz'"
		);
	});

	it("builds a read-only archive file listing command", () => {
		expect(buildListArchiveLogFilesCommand("/home/logdir/log/saas-set01", "saas.log", "260812")).toBe(
			"ls -1t '/home/logdir/log/saas-set01/260812' | grep -E '^saas\\.log\\.260812.*\\.gz$'"
		);
	});
});
