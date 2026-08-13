import { describe, expect, it } from "vitest";
import { EventEmitter, Readable } from "node:stream";
import {
	SshExecutor,
	ConcurrencyLimiter,
	type ExecStreamLike,
	type SshTransportLike
} from "../src/ssh/connection.js";
import { searchSingleServer, parseGrepOutput, MAX_FILES_PER_PATH } from "../src/logs/search.js";
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

function streamOf(stdout: string, exitCode: number, stderr = ""): ExecStreamLike {
	const emitter = new EventEmitter() as unknown as ExecStreamLike;
	emitter.stdout = Readable.from([Buffer.from(stdout, "utf-8")]);
	emitter.stderr = Readable.from(stderr ? [Buffer.from(stderr, "utf-8")] : []);
	emitter.close = () => {};
	emitter.destroy = () => {};
	setImmediate(() => (emitter as unknown as EventEmitter).emit("close", exitCode));
	return emitter;
}

/**
 * Scripted transport: answers commands based on their shape.
 * - `ls -1t` → file listing
 * - `tail ... | grep -n -F ...` → grep matches for app.log only
 */
function scriptedExecutor(opts: {
	files?: string;
	grepOutput?: string;
	grepExit?: number;
	recordCommands?: string[];
}): SshExecutor {
	const factory = async (): Promise<SshTransportLike> => ({
		exec(command: string, callback) {
			opts.recordCommands?.push(command);
			if (command.startsWith("ls -1t ")) {
				const files = opts.files ?? "";
				callback(undefined, streamOf(files, files ? 0 : 1));
				return;
			}
			if (command.includes("| grep -n -F -e")) {
				callback(undefined, streamOf(opts.grepOutput ?? "", opts.grepExit ?? 0));
				return;
			}
			callback(undefined, streamOf("", 127, "unexpected command"));
		}
	});
	return new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(2), factory);
}

describe("parseGrepOutput", () => {
	it("parses grep -n lines", () => {
		const parsed = parseGrepOutput("10:line ten\n25:line twenty-five\n");
		expect(parsed).toEqual([
			{ lineInWindow: 10, matchedLine: "line ten" },
			{ lineInWindow: 25, matchedLine: "line twenty-five" }
		]);
	});

	it("keeps colons inside the content intact", () => {
		const parsed = parseGrepOutput("5:2026-08-13 10:00:00 INFO start");
		expect(parsed[0].matchedLine).toBe("2026-08-13 10:00:00 INFO start");
	});

	it("ignores malformed lines", () => {
		expect(parseGrepOutput("not-a-grep-line\n\n")).toEqual([]);
	});
});

describe("searchSingleServer", () => {
	it("finds matches and reports server / logFile / matchedLine", async () => {
		const executor = scriptedExecutor({
			files: "app.log\n",
			grepOutput: "42:2026-08-13 10:01:02 INFO searchShippingOrderSummary called\n"
		});
		const result = await searchSingleServer(executor, serverConfig, limits, {
			keyword: "searchShippingOrderSummary",
			maxMatches: 100
		});

		expect(result.server).toBe("shipping-prod-01");
		expect(result.errors).toEqual([]);
		expect(result.truncated).toBe(false);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({
			server: "shipping-prod-01",
			environment: "prod",
			logFile: "/data/logs/shipping/app.log",
			lineInWindow: 42,
			matchedLine: "2026-08-13 10:01:02 INFO searchShippingOrderSummary called"
		});
	});

	it("uses tail-scoped grep and never scans full history", async () => {
		const commands: string[] = [];
		const executor = scriptedExecutor({ files: "app.log\n", grepOutput: "", grepExit: 1, recordCommands: commands });
		await searchSingleServer(executor, serverConfig, limits, { keyword: "kw", maxMatches: 10 });

		const grepCommand = commands.find((c) => c.includes("grep -n -F"));
		expect(grepCommand).toBe(
			"tail -n 20000 '/data/logs/shipping/app.log' | grep -n -F -e 'kw'"
		);
	});

	it("returns no matches gracefully when grep finds nothing", async () => {
		const executor = scriptedExecutor({ files: "app.log\n", grepOutput: "", grepExit: 1 });
		const result = await searchSingleServer(executor, serverConfig, limits, {
			keyword: "missingKeyword",
			maxMatches: 100
		});
		expect(result.matches).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("records an error when the log directory is unreadable but keeps searching", async () => {
		const executor = scriptedExecutor({ files: "" });
		// Simulate ls failing hard (exit 2) by overriding via custom factory
		const failingExecutor = new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(1), async () => ({
			exec(_command, callback) {
				callback(undefined, streamOf("", 2, "ls: cannot access '/data/logs/shipping': Permission denied"));
			}
		}));
		void executor;
		const result = await searchSingleServer(failingExecutor, serverConfig, limits, {
			keyword: "kw",
			maxMatches: 10
		});
		expect(result.matches).toEqual([]);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain("Permission denied");
	});

	it("caps matches at maxMatches and flags truncation", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}:hit ${i}`).join("\n");
		const executor = scriptedExecutor({ files: "app.log\n", grepOutput: lines });
		const result = await searchSingleServer(executor, serverConfig, limits, {
			keyword: "hit",
			maxMatches: 3
		});
		expect(result.matches).toHaveLength(3);
		expect(result.truncated).toBe(true);
	});

	it("caps scanned files per path", async () => {
		const files = Array.from({ length: 9 }, (_, i) => `app-${i}.log`).join("\n");
		const commands: string[] = [];
		const executor = scriptedExecutor({ files, grepOutput: "", grepExit: 1, recordCommands: commands });
		await searchSingleServer(executor, serverConfig, limits, { keyword: "kw", maxMatches: 10 });
		const grepCommands = commands.filter((c) => c.includes("grep -n -F"));
		expect(grepCommands.length).toBe(MAX_FILES_PER_PATH);
	});

	it("rejects injection keywords before any command runs", async () => {
		const commands: string[] = [];
		const executor = scriptedExecutor({ files: "app.log\n", recordCommands: commands });
		await expect(
			searchSingleServer(executor, serverConfig, limits, {
				keyword: "foo; rm -rf /",
				maxMatches: 10
			})
		).rejects.toThrow(/Invalid keyword/);
		expect(commands).toEqual([]);
	});
});
