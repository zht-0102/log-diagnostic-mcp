import { describe, expect, it } from "vitest";
import { buildGzipGrepCommand, buildGzipTailCommand } from "../src/ssh/commands.js";

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
});
