import { readFileSync } from "node:fs";
import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import type { ServerConfig, LimitsConfig } from "../server/config.js";
import { assertNotForbidden } from "../security/shellGuard.js";

/**
 * Read-only SSH execution layer.
 *
 * - Only `exec` is exposed: no shell, no SFTP write, no pty.
 * - Every command passes assertNotForbidden() before execution.
 * - Per-command timeout and output size caps prevent runaway reads.
 * - A shared concurrency limiter bounds parallel SSH connections.
 */

export interface ExecResult {
	/** Process exit code (grep returns 1 for "no matches"; not an error). */
	exitCode: number;
	stdout: string;
	/** Kept for diagnostics; truncated like stdout. */
	stderr: string;
	/** True when the output was cut at maxOutputBytes. */
	truncated: boolean;
	/** True when the command hit its timeout and the channel was destroyed. */
	timedOut: boolean;
}

export interface ExecOptions {
	timeoutMs: number;
	/** Hard cap on captured output per command. */
	maxOutputBytes?: number;
}

/** Minimal stream contract used by execStream (satisfied by ssh2 ClientChannel). */
export interface ExecStreamLike {
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	on(event: "close", listener: (code: number) => void): unknown;
	close(): void;
	destroy(): void;
}

/** Minimal transport contract (satisfied by ssh2 Client; mockable in tests). */
export interface SshTransportLike {
	exec(command: string, callback: (err: Error | undefined, stream: ExecStreamLike) => void): void;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MB per command

export class SshExecError extends Error {
	constructor(
		message: string,
		readonly serverName: string,
		readonly cause?: Error
	) {
		super(message);
		this.name = "SshExecError";
	}
}

/** Execute a command against a transport-like stream with timeout + size caps. */
export function execStream(stream: ExecStreamLike, options: ExecOptions): Promise<ExecResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				stream.destroy();
			} catch {
				/* already closed */
			}
		}, options.timeoutMs);

		const settle = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(result);
		};

		stream.stdout.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
			stdoutBytes += Buffer.byteLength(text, "utf-8");
			if (stdoutBytes > maxBytes) {
				truncated = true;
				const overflow = stdoutBytes - maxBytes;
				stdout += text.slice(0, Math.max(0, text.length - overflow));
				return;
			}
			stdout += text;
		});

		stream.stderr.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
			if (stderr.length < 65536) {
				stderr += text.slice(0, 65536 - stderr.length);
			}
		});

		stream.on("close", (code: number) => {
			settle({ exitCode: code, stdout, stderr, truncated, timedOut });
		});

		// Reject connection-level stream errors instead of hanging.
		(stream as unknown as { on?: (e: string, l: (err: Error) => void) => void }).on?.(
			"error",
			(err: Error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					rejectPromise(err);
				}
			}
		);
	});
}

/** Simple FIFO promise-based concurrency limiter. */
export class ConcurrencyLimiter {
	private running = 0;
	private readonly queue: Array<() => void> = [];

	constructor(readonly max: number) {
		if (max < 1) throw new Error("ConcurrencyLimiter max must be >= 1");
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.running >= this.max) {
			await new Promise<void>((resolveWait) => this.queue.push(resolveWait));
		}
		this.running += 1;
		try {
			return await task();
		} finally {
			this.running -= 1;
			const next = this.queue.shift();
			if (next) next();
		}
	}
}

/**
 * SSH executor bound to one configured server.
 * Connections are created lazily per exec and closed afterwards —
 * the MVP favors simplicity and safety over long-lived pooling; the
 * ConcurrencyLimiter bounds how many connections exist at once.
 */
export class SshExecutor {
	constructor(
		private readonly server: ServerConfig,
		private readonly limits: LimitsConfig,
		private readonly limiter: ConcurrencyLimiter,
		private readonly transportFactory: (server: ServerConfig) => Promise<SshTransportLike> = connectSsh
	) {}

	/** Run a read-only command on the remote server. */
	async exec(command: string, options?: Partial<ExecOptions>): Promise<ExecResult> {
		assertNotForbidden(command);
		return this.limiter.run(async () => {
			const transport = await this.transportFactory(this.server);
			try {
				return await this.execOnTransport(transport, command, options);
			} finally {
				await closeTransport(transport);
			}
		});
	}

	private execOnTransport(
		transport: SshTransportLike,
		command: string,
		options?: Partial<ExecOptions>
	): Promise<ExecResult> {
		const timeoutMs = (options?.timeoutMs ?? this.limits.timeoutSeconds * 1000) as number;
		return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
			transport.exec(command, (err, stream) => {
				if (err || !stream) {
					rejectPromise(
						new SshExecError(`Remote exec failed: ${err?.message ?? "no stream"}`, this.server.name, err)
					);
					return;
				}
				execStream(stream, { timeoutMs, maxOutputBytes: options?.maxOutputBytes })
					.then(resolvePromise)
					.catch((streamErr: Error) =>
						rejectPromise(new SshExecError(`Remote exec error: ${streamErr.message}`, this.server.name, streamErr))
					);
			});
		});
	}
}

/** Establish an ssh2 connection for a configured server (private key or password). */
export function connectSsh(server: ServerConfig): Promise<SshTransportLike> {
	return new Promise((resolvePromise, rejectPromise) => {
		const client = new Client();

		const connectOptions: Record<string, unknown> = {
			host: server.host,
			port: server.port,
			username: server.username,
			readyTimeout: 15000,
			// Never fall back to weaker auth; explicit config only.
			tryKeyboard: false
		};
		if (server.auth.type === "private_key") {
			let key: string;
			try {
				key = readFileSync(server.auth.privateKeyPath, "utf-8");
			} catch (err) {
				rejectPromise(
					new SshExecError(
						`Cannot read SSH private key at ${server.auth.privateKeyPath}: ${(err as Error).message}`,
						server.name,
						err as Error
					)
				);
				return;
			}
			connectOptions.privateKey = key;
		} else {
			connectOptions.password = server.auth.password;
		}

		client.once("ready", () => resolvePromise(client as unknown as SshTransportLike));
		client.once("error", (err) =>
			rejectPromise(new SshExecError(`SSH connection to ${server.host}:${server.port} failed: ${err.message}`, server.name, err))
		);
		client.connect(connectOptions);
	});
}

async function closeTransport(transport: SshTransportLike): Promise<void> {
	const maybeEnd = transport as unknown as { end?: () => void };
	if (typeof maybeEnd.end === "function") {
		maybeEnd.end();
	}
}
