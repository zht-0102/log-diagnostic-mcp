import { describe, expect, it } from "vitest";
import { EventEmitter, Readable } from "node:stream";
import {
	SshExecutor,
	ConcurrencyLimiter,
	execStream,
	type ExecStreamLike,
	type SshTransportLike
} from "../src/ssh/connection.js";
import type { ServerConfig, LimitsConfig } from "../src/server/config.js";

const serverConfig: ServerConfig = {
	name: "test-server",
	environment: "test",
	host: "127.0.0.1",
	port: 22,
	username: "log-reader",
	auth: { type: "private_key", privateKeyPath: "/tmp/fake-key" },
	logPaths: ["/data/logs/app"]
};

const limits: LimitsConfig = {
	maxServers: 10,
	maxLines: 3000,
	timeoutSeconds: 5,
	maxConcurrentConnections: 5,
	scanLines: 20000
};

/** Build a fake ExecStreamLike that emits the given stdout then closes. */
function fakeStream(stdout: string, exitCode = 0, stderr = ""): ExecStreamLike {
	const emitter = new EventEmitter() as unknown as ExecStreamLike;
	const out = Readable.from([Buffer.from(stdout, "utf-8")]);
	const err = Readable.from(stderr ? [Buffer.from(stderr, "utf-8")] : []);
	emitter.stdout = out;
	emitter.stderr = err;
	emitter.close = () => {};
	emitter.destroy = () => {
		out.destroy();
		err.destroy();
		emitter.on("close", () => {});
		setImmediate(() => (emitter as unknown as EventEmitter).emit("close", exitCode));
	};
	setImmediate(() => (emitter as unknown as EventEmitter).emit("close", exitCode));
	return emitter;
}

/** Transport factory that records commands and returns canned output. */
function recordingFactory(stdout: string, exitCode = 0) {
	const commands: string[] = [];
	const factory = async (): Promise<SshTransportLike> => ({
		exec(command: string, callback: (err: Error | undefined, stream: ExecStreamLike) => void) {
			commands.push(command);
			callback(undefined, fakeStream(stdout, exitCode));
		}
	});
	return { commands, factory };
}

describe("SshExecutor.exec", () => {
	it("returns stdout and exit code from the remote command", async () => {
		const { factory, commands } = recordingFactory("line1\nline2\n", 0);
		const executor = new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(2), factory);

		const result = await executor.exec("grep -n -F -e 'kw' /data/logs/app.log");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("line1\nline2\n");
		expect(result.truncated).toBe(false);
		expect(result.timedOut).toBe(false);
		expect(commands).toEqual(["grep -n -F -e 'kw' /data/logs/app.log"]);
	});

	it("treats grep exit code 1 (no match) as a normal result", async () => {
		const { factory } = recordingFactory("", 1);
		const executor = new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(1), factory);
		const result = await executor.exec("grep -n -F -e 'none' /data/logs/app.log");
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
	});

	it("refuses forbidden commands before touching the transport", async () => {
		const { factory, commands } = recordingFactory("x");
		const executor = new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(1), factory);
		await expect(executor.exec("rm -rf /")).rejects.toThrow(/forbidden command/i);
		expect(commands).toHaveLength(0);
	});

	it("caps output size and flags truncation", async () => {
		const big = "x".repeat(10000);
		const { factory } = recordingFactory(big);
		const executor = new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(1), factory);
		const result = await executor.exec("tail -n 100 /data/logs/app.log", { maxOutputBytes: 1000 });
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1000);
	});

	it("flags timedOut when the command exceeds its timeout", async () => {
		const factory = async (): Promise<SshTransportLike> => ({
			exec(_command, callback) {
				// A stream that never emits data and never closes.
				const emitter = new EventEmitter() as unknown as ExecStreamLike;
				emitter.stdout = new Readable({ read() {} });
				emitter.stderr = new Readable({ read() {} });
				emitter.close = () => {};
				emitter.destroy = () => {
					setImmediate(() => (emitter as unknown as EventEmitter).emit("close", 124));
				};
				callback(undefined, emitter);
			}
		});
		const executor = new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(1), factory);
		const result = await executor.exec("tail -f /data/logs/app.log", { timeoutMs: 50 });
		expect(result.timedOut).toBe(true);
	});

	it("surfaces transport errors as SshExecError", async () => {
		const factory = async (): Promise<SshTransportLike> => ({
			exec(_command, callback) {
				callback(new Error("connection reset"), undefined as never);
			}
		});
		const executor = new SshExecutor(serverConfig, limits, new ConcurrencyLimiter(1), factory);
		await expect(executor.exec("tail -n 1 /data/logs/app.log")).rejects.toThrow(/Remote exec failed/);
	});
});

describe("execStream output caps", () => {
	it("truncates stderr to a bounded size", async () => {
		const emitter = new EventEmitter() as unknown as ExecStreamLike;
		emitter.stdout = Readable.from([Buffer.from("ok")]);
		emitter.stderr = Readable.from([Buffer.from("e".repeat(200000))]);
		emitter.close = () => {};
		emitter.destroy = () => {};
		setImmediate(() => (emitter as unknown as EventEmitter).emit("close", 0));
		const result = await execStream(emitter, { timeoutMs: 5000 });
		expect(result.stderr.length).toBeLessThanOrEqual(65536);
	});
});

describe("ConcurrencyLimiter", () => {
	it("never runs more than max tasks in parallel", async () => {
		const limiter = new ConcurrencyLimiter(2);
		let running = 0;
		let peak = 0;
		const tasks = Array.from({ length: 10 }, () =>
			limiter.run(async () => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((r) => setTimeout(r, 10));
				running -= 1;
			})
		);
		await Promise.all(tasks);
		expect(peak).toBeLessThanOrEqual(2);
	});
});
