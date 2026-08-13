import { describe, expect, it } from "vitest";
import { EventEmitter, Readable } from "node:stream";
import {
	SshExecutor,
	ConcurrencyLimiter,
	type ExecStreamLike,
	type SshTransportLike
} from "../src/ssh/connection.js";
import { enrichMatchesWithContext, sliceContext } from "../src/logs/context.js";
import type { LogMatch } from "../src/logs/search.js";
import type { ServerConfig, LimitsConfig } from "../src/server/config.js";

const serverConfig: ServerConfig = {
	name: "shipping-prod-01",
	environment: "prod",
	host: "192.168.1.10",
	port: 22,
	username: "log-reader",
	auth: { type: "private_key", privateKeyPath: "/tmp/fake-key" },
	logPaths: ["/data/logs/shipping"]
};

const limits: LimitsConfig = {
	maxServers: 10,
	maxLines: 3000,
	timeoutSeconds: 5,
	maxConcurrentConnections: 5,
	scanLines: 20000
};

/** 10 行日志窗口；关键词在第 6 行。 */
const WINDOW = [
	"2026-08-13 10:01:00.001 INFO  boot",
	"2026-08-13 10:01:00.500 DEBUG loading config",
	"2026-08-13 10:01:01.000 INFO  request received",
	"2026-08-13 10:01:01.200 DEBUG validating params",
	"2026-08-13 10:01:01.800 DEBUG cache miss",
	"2026-08-13 10:01:02.123 INFO  searchShippingOrderSummary called",
	"2026-08-13 10:01:02.300 DEBUG Preparing: SELECT * FROM shipping_order WHERE id = ?",
	"2026-08-13 10:01:02.310 DEBUG Parameters: 123(Long)",
	"2026-08-13 10:01:02.500 INFO  response sent",
	"2026-08-13 10:01:03.000 INFO  done"
].join("\n");

function streamOf(stdout: string, exitCode: number, stderr = ""): ExecStreamLike {
	const emitter = new EventEmitter() as unknown as ExecStreamLike;
	emitter.stdout = Readable.from([Buffer.from(stdout, "utf-8")]);
	emitter.stderr = Readable.from(stderr ? [Buffer.from(stderr, "utf-8")] : []);
	emitter.close = () => {};
	emitter.destroy = () => {};
	setImmediate(() => (emitter as unknown as EventEmitter).emit("close", exitCode));
	return emitter;
}

function tailExecutor(
	stdout: string,
	exitCode = 0,
	opts: { stderr?: string; recordCommands?: string[] } = {}
): SshExecutor {
	return new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(1), async () => ({
		exec(command: string, callback) {
			opts.recordCommands?.push(command);
			callback(undefined, streamOf(stdout, exitCode, opts.stderr));
		}
	}));
}

const baseMatch: LogMatch = {
	server: "shipping-prod-01",
	environment: "prod",
	logFile: "/data/logs/shipping/app.log",
	lineInWindow: 6,
	matchedLine: "2026-08-13 10:01:02.123 INFO  searchShippingOrderSummary called",
	timestamp: null
};

describe("sliceContext", () => {
	const lines = WINDOW.split("\n");

	it("slices before/after around the match", () => {
		const { contextBefore, contextAfter } = sliceContext(lines, 6, 2, 2);
		expect(contextBefore).toEqual([lines[3], lines[4]]);
		expect(contextAfter).toEqual([lines[6], lines[7]]);
	});

	it("clamps at the window boundaries", () => {
		const top = sliceContext(lines, 1, 30, 50);
		expect(top.contextBefore).toEqual([]);
		expect(top.contextAfter).toHaveLength(9);

		const bottom = sliceContext(lines, 10, 30, 50);
		expect(bottom.contextBefore).toHaveLength(9);
		expect(bottom.contextAfter).toEqual([]);
	});

	it("honors zero context sizes", () => {
		const { contextBefore, contextAfter } = sliceContext(lines, 6, 0, 0);
		expect(contextBefore).toEqual([]);
		expect(contextAfter).toEqual([]);
	});
});

describe("enrichMatchesWithContext", () => {
	it("returns context lines and parsed timestamp for a match", async () => {
		const executor = tailExecutor(WINDOW + "\n");
		const result = await enrichMatchesWithContext(executor, serverConfig, limits, [baseMatch], 2, 3);

		expect(result.errors).toEqual([]);
		expect(result.enriched).toHaveLength(1);
		const enriched = result.enriched[0];
		expect(enriched.timestamp).toBe("2026-08-13T10:01:02.123");
		expect(enriched.contextBefore).toHaveLength(2);
		expect(enriched.contextAfter).toHaveLength(3);
		expect(enriched.contextAfter[0]).toContain("Preparing: SELECT");
		expect(enriched).toMatchObject({
			server: "shipping-prod-01",
			logFile: "/data/logs/shipping/app.log",
			matchedLine: baseMatch.matchedLine
		});
	});

	it("fetches the tail window once per file for multiple matches", async () => {
		const commands: string[] = [];
		const executor = tailExecutor(WINDOW + "\n", 0, { recordCommands: commands });
		const second: LogMatch = { ...baseMatch, lineInWindow: 9, matchedLine: WINDOW.split("\n")[8] };
		await enrichMatchesWithContext(executor, serverConfig, limits, [baseMatch, second], 1, 1);
		expect(commands).toEqual(["tail -n 20000 '/data/logs/shipping/app.log'"]);
	});

	it("drops matches outside the time window", async () => {
		const executor = tailExecutor(WINDOW + "\n");
		const timeWindow = {
			// 匹配行位于本地时间（+08:00）10:01:02 = 02:01:02Z，窗口在其之后。
			startMs: Date.parse("2026-08-13T03:00:00Z"),
			endMs: Date.parse("2026-08-13T04:00:00Z"),
			localOffsetMs: 8 * 60 * 60 * 1000
		};
		const result = await enrichMatchesWithContext(executor, serverConfig, limits, [baseMatch], 1, 1, timeWindow);
		expect(result.enriched).toHaveLength(0);
		expect(result.droppedByTime).toBe(1);
	});

	it("keeps matches inside the time window", async () => {
		const executor = tailExecutor(WINDOW + "\n");
		const timeWindow = {
			startMs: Date.parse("2026-08-13T01:00:00Z"),
			endMs: Date.parse("2026-08-13T03:00:00Z"),
			localOffsetMs: 8 * 60 * 60 * 1000
		};
		const result = await enrichMatchesWithContext(executor, serverConfig, limits, [baseMatch], 1, 1, timeWindow);
		expect(result.enriched).toHaveLength(1);
		expect(result.droppedByTime).toBe(0);
	});

	it("keeps matches without context when the window fetch fails", async () => {
		const executor = tailExecutor("", 2, { stderr: "tail: cannot open file" });
		const result = await enrichMatchesWithContext(executor, serverConfig, limits, [baseMatch], 2, 2);
		expect(result.enriched).toHaveLength(1);
		expect(result.enriched[0].contextBefore).toEqual([]);
		expect(result.enriched[0].contextAfter).toEqual([]);
		expect(result.missingContext).toBe(1);
		expect(result.errors[0]).toContain("tail: cannot open file");
	});
});
