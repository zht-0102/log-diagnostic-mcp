import { readFileSync } from "node:fs";
import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import type { ServerConfig, LimitsConfig } from "../server/config.js";
import { assertNotForbidden } from "../security/shellGuard.js";

/**
 * 只读的 SSH 执行层。
 *
 * - 只暴露 `exec`：没有交互式 shell，没有 SFTP 写入，没有 pty。
 * - 每条命令执行前都经过 assertNotForbidden() 拦截。
 * - 单命令超时与输出大小上限防止失控的读取。
 * - 共享的并发限制器约束并行的 SSH 连接数。
 */

export interface ExecResult {
	/** 进程退出码（grep 无匹配时返回 1，不算错误）。 */
	exitCode: number;
	stdout: string;
	/** 保留用于诊断；与 stdout 一样会被截断。 */
	stderr: string;
	/** 输出在 maxOutputBytes 处被截断时为 true。 */
	truncated: boolean;
	/** 命令超时、通道被销毁时为 true。 */
	timedOut: boolean;
}

export interface ExecOptions {
	timeoutMs: number;
	/** 单条命令捕获输出的硬上限。 */
	maxOutputBytes?: number;
}

/** execStream 使用的最小流契约（ssh2 的 ClientChannel 满足该契约）。 */
export interface ExecStreamLike {
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	on(event: "close", listener: (code: number) => void): unknown;
	close(): void;
	destroy(): void;
}

/** 最小传输层契约（ssh2 的 Client 满足该契约；测试中可 mock）。 */
export interface SshTransportLike {
	exec(command: string, callback: (err: Error | undefined, stream: ExecStreamLike) => void): void;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 每条命令 8 MB

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

/** 在类传输层流上执行命令，带超时与输出大小限制。 */
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
				/* 已关闭 */
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

		// 连接层的流错误直接 reject，避免无限挂起。
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

/** 基于 Promise 的简单 FIFO 并发限制器。 */
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
 * 绑定到单台已配置服务器的 SSH 执行器。
 * 连接按 exec 懒创建、用完即关 —— MVP 阶段以简单和安全优先，
 * 不做长生命周期连接池；同时存在的连接数由 ConcurrencyLimiter 约束。
 */
export class SshExecutor {
	constructor(
		private readonly server: ServerConfig,
		private readonly limits: LimitsConfig,
		private readonly limiter: ConcurrencyLimiter,
		private readonly transportFactory: (server: ServerConfig) => Promise<SshTransportLike> = connectSsh
	) {}

	/** 在远程服务器上执行一条只读命令。 */
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

/** 为已配置的服务器建立 ssh2 连接（私钥或密码认证）。 */
export function connectSsh(server: ServerConfig): Promise<SshTransportLike> {
	return new Promise((resolvePromise, rejectPromise) => {
		const client = new Client();

		const connectOptions: Record<string, unknown> = {
			host: server.host,
			port: server.port,
			username: server.username,
			readyTimeout: 15000,
			// 绝不回退到更弱的认证方式；只用显式配置的认证。
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
