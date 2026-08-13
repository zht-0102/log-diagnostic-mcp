import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * MCP startup smoke test.
 *
 * Spawns the real server binary (`tsx src/index.ts`) as a subprocess and
 * speaks raw JSON-RPC over stdio: initialize → notifications/initialized →
 * tools/list. Proves the packaged entry point starts and registers the tool.
 */

const require = createRequire(import.meta.url);
const tsxEntry = path.dirname(require.resolve("tsx/package.json")) + "/dist/cli.mjs";
const projectRoot = path.resolve(import.meta.dirname, "..");

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	result?: unknown;
	error?: { code: number; message: string };
}

function request(id: number, method: string, params: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function runStartupCheck(timeoutMs = 30_000): Promise<{
	initialized: boolean;
	tools: string[];
	stderr: string;
}> {
	const child = spawn(process.execPath, [tsxEntry, "src/index.ts"], {
		cwd: projectRoot,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env }
	});

	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf-8");
	});

	const responses = new Map<number, JsonRpcMessage>();
	let buffer = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf-8");
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			try {
				const message = JSON.parse(line) as JsonRpcMessage;
				if (typeof message.id === "number") responses.set(message.id, message);
			} catch {
				// Non-JSON noise on stdout: ignore.
			}
		}
	});

	const waitFor = async (id: number): Promise<JsonRpcMessage> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const message = responses.get(id);
			if (message) return message;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`Timed out waiting for response id=${id}. stderr:\n${stderr}`);
	};

	try {
		child.stdin.write(
			request(1, "initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "startup-test", version: "0.0.1" }
			}) + "\n"
		);
		const initResponse = await waitFor(1);
		const initialized = Boolean(initResponse.result);

		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
		child.stdin.write(request(2, "tools/list", {}) + "\n");
		const toolsResponse = await waitFor(2);
		const tools = ((toolsResponse.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map(
			(t) => t.name
		);

		return { initialized, tools, stderr };
	} finally {
		child.kill();
	}
}

describe("MCP stdio startup", () => {
	it(
		"starts over stdio, answers initialize and lists search_logs",
		async () => {
			const { initialized, tools } = await runStartupCheck();
			expect(initialized).toBe(true);
			expect(tools).toEqual(["search_logs"]);
		},
		40_000
	);
});
