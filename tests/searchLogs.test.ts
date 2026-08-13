import { describe, expect, it } from "vitest";
import { EventEmitter, Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../src/server/mcpServer.js";
import {
	SshExecutor,
	ConcurrencyLimiter,
	type ExecStreamLike,
	type SshTransportLike
} from "../src/ssh/connection.js";
import type { AppConfig, ServerConfig } from "../src/server/config.js";

/**
 * 通过内存内 transport 对，将测试客户端连接到新建的服务实例。
 */
async function connectClient(deps: Parameters<typeof createServer>[0] = {}): Promise<Client> {
	const server = createServer(deps);
	const client = new Client({ name: "test-client", version: "0.0.1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

describe("MCP server basics", () => {
	it("exposes server name and instructions on connect", async () => {
		const client = await connectClient();
		expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
		expect(client.getInstructions()).toContain("search_logs");
	});

	it("registers exactly one tool: search_logs", async () => {
		const client = await connectClient();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["search_logs"]);
	});
});

describe("search_logs input validation", () => {
	it("rejects empty keyword", async () => {
		const client = await connectClient();
		const result = await client.callTool({
			name: "search_logs",
			arguments: { keyword: "" }
		});
		expect(result.isError).toBe(true);
	});

	it("rejects keyword longer than 200 chars", async () => {
		const client = await connectClient();
		const result = await client.callTool({
			name: "search_logs",
			arguments: { keyword: "x".repeat(201) }
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 使用脚本化（mock）SSH 层的全管道测试。
// ---------------------------------------------------------------------------

const serverConfig: ServerConfig = {
	name: "shipping-prod-01",
	environment: "prod",
	host: "192.168.1.10",
	port: 22,
	username: "log-reader",
	auth: { type: "private_key", privateKeyPath: "/tmp/fake-key" },
	logPaths: ["/data/logs/shipping"]
};

function fakeConfig(): AppConfig {
	return {
		limits: {
			maxServers: 10,
			maxLines: 3000,
			timeoutSeconds: 5,
			maxConcurrentConnections: 5,
			scanLines: 20000
		},
		servers: [serverConfig]
	};
}

/** 按下方日志行的格式生成 "当前时刻" 的时间戳。 */
function nowStamp(offsetMinutes = 0): string {
	const d = new Date(Date.now() - offsetMinutes * 60_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
		d.getMinutes()
	)}:${pad(d.getSeconds())}`;
}

function streamOf(stdout: string, exitCode: number, stderr = ""): ExecStreamLike {
	const emitter = new EventEmitter() as unknown as ExecStreamLike;
	emitter.stdout = Readable.from([Buffer.from(stdout, "utf-8")]);
	emitter.stderr = Readable.from(stderr ? [Buffer.from(stderr, "utf-8")] : []);
	emitter.close = () => {};
	emitter.destroy = () => {};
	setImmediate(() => (emitter as unknown as EventEmitter).emit("close", exitCode));
	return emitter;
}

/** 构造 tail 窗口：匹配行位于 `matchLine`，`extra` 行紧随其后。 */
function buildWindow(matchLine: number, extra: string[]): string {
	const lines: string[] = [];
	for (let i = 1; i <= matchLine + extra.length; i++) {
		if (i === matchLine - 3) lines.push(`${nowStamp()} INFO  Request: {"orderId":"SO-1001","password":"hunter2"}`);
		else if (i === matchLine) lines.push(`${nowStamp()} ERROR searchShippingOrderSummary failed`);
		else if (i > matchLine) lines.push(extra[i - matchLine - 1]);
		else lines.push(`${nowStamp()} INFO  filler line ${i}`);
	}
	return lines.join("\n") + "\n";
}

function scriptedExecutor(opts: {
	window: string;
	grepOutput: string;
	server: ServerConfig;
	recordCommands?: string[];
}): SshExecutor {
	const limits = fakeConfig().limits;
	const factory = async (): Promise<SshTransportLike> => ({
		exec(command: string, callback) {
			opts.recordCommands?.push(command);
			if (command.startsWith("ls -1t ")) {
				callback(undefined, streamOf("app.log\n", 0));
				return;
			}
			if (command.includes("| grep -n -F -e")) {
				callback(undefined, streamOf(opts.grepOutput, opts.grepOutput ? 0 : 1));
				return;
			}
			if (command.startsWith("tail -n ")) {
				callback(undefined, streamOf(opts.window, 0));
				return;
			}
			callback(undefined, streamOf("", 127, "unexpected command"));
		}
	});
	return new SshExecutor(opts.server, limits, new ConcurrencyLimiter(2), factory);
}

function parsePayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
	const content = result.content as Array<{ type: string; text: string }>;
	return JSON.parse(content[0].text);
}

describe("search_logs full pipeline (mock SSH)", () => {
	it("returns matches, request, SQL, exception and analysis end to end", async () => {
		const stackTail = [
			"java.lang.NullPointerException: order is null",
			"\tat com.example.ShippingService.query(ShippingService.java:42)",
			"==>  Preparing: SELECT * FROM shipping_order WHERE order_no = ?",
			"==>  Parameters: SO-1001(String)",
			`Authorization: Bearer abc.def.ghi`
		];
		const window = buildWindow(8, stackTail);
		const grepOutput = `8:${nowStamp()} ERROR searchShippingOrderSummary failed`;
		const commands: string[] = [];

		const client = await connectClient({
			loadConfiguration: fakeConfig,
			createExecutor: (server) =>
				scriptedExecutor({ window, grepOutput, server, recordCommands: commands })
		});

		const result = await client.callTool({
			name: "search_logs",
			arguments: { keyword: "searchShippingOrderSummary", contextBefore: 3, contextAfter: 5 }
		});
		expect(result.isError).toBeFalsy();
		const payload = parsePayload(result);

		expect(payload.status).toBe("success");
		expect(payload.query.keyword).toBe("searchShippingOrderSummary");
		expect(payload.query.searchedServers).toEqual(["shipping-prod-01"]);
		expect(payload.query.contextBefore).toBe(3);
		expect(payload.query.contextAfter).toBe(5);

		// 匹配项
		expect(payload.matches).toHaveLength(1);
		expect(payload.matches[0].server).toBe("shipping-prod-01");
		expect(payload.matches[0].logFile).toBe("/data/logs/shipping/app.log");
		expect(payload.matches[0].lineNumber).toBe(8);
		expect(payload.matches[0].timestamp).not.toBeNull();
		expect(payload.matches[0].contextBefore.length).toBeGreaterThan(0);
		expect(payload.matches[0].contextAfter.length).toBeGreaterThan(0);

		// 请求提取
		expect(payload.requestParameters).not.toBeNull();
		expect(payload.requestParameters[0].parameters.orderId).toBe("SO-1001");
		// 敏感值在出口处被脱敏
		expect(JSON.stringify(payload)).not.toContain("hunter2");

		// fixture 中不存在响应 → null，绝不捏造
		expect(payload.response).toBeNull();

		// MyBatis SQL 还原成功
		expect(payload.sql).not.toBeNull();
		expect(payload.sql[0].sqlReconstructionSuccess).toBe(true);
		expect(payload.sql[0].reconstructedSql).toBe(
			"SELECT * FROM shipping_order WHERE order_no = 'SO-1001'"
		);

		// 异常被提取（上下文中的堆栈也在提取结果中）
		expect(payload.exceptions).not.toBeNull();
		expect(JSON.stringify(payload.exceptions)).toContain("java.lang.NullPointerException");

		// Bearer 令牌在所有位置被脱敏
		expect(JSON.stringify(payload)).not.toContain("abc.def.ghi");
		expect(JSON.stringify(payload)).toContain("Bearer ****");

		// 三段式分析存在
		expect(payload.analysis.confirmedFacts.length).toBeGreaterThan(0);
		expect(payload.analysis.possibleCauses.length).toBeGreaterThan(0);
		expect(payload.analysis.recommendations.length).toBeGreaterThan(0);
		expect(payload.analysis.confirmedFacts.join("\n")).toContain("NullPointerException");
	});

	it("returns null extractions and a no-match analysis when nothing hits", async () => {
		const window = `${nowStamp()} INFO  filler\n`;
		const client = await connectClient({
			loadConfiguration: fakeConfig,
			createExecutor: (server) => scriptedExecutor({ window, grepOutput: "", server })
		});

		const result = await client.callTool({
			name: "search_logs",
			arguments: { keyword: "noSuchKeyword" }
		});
		const payload = parsePayload(result);
		expect(payload.status).toBe("success");
		expect(payload.matches).toEqual([]);
		expect(payload.requestParameters).toBeNull();
		expect(payload.response).toBeNull();
		expect(payload.sql).toBeNull();
		expect(payload.exceptions).toBeNull();
		expect(payload.analysis.confirmedFacts.join("\n")).toContain("No log lines matched");
	});

	it("reports an error payload when the config cannot be loaded", async () => {
		const client = await connectClient({
			loadConfiguration: () => {
				throw new Error("Cannot read config file at config/servers.yaml");
			}
		});
		const result = await client.callTool({
			name: "search_logs",
			arguments: { keyword: "anything" }
		});
		expect(result.isError).toBe(true);
		const payload = parsePayload(result);
		expect(payload.status).toBe("error");
		expect(payload.error).toContain("Cannot read config file");
	});

	it("rejects shell-injection keywords before any remote command", async () => {
		const commands: string[] = [];
		const window = "";
		const client = await connectClient({
			loadConfiguration: fakeConfig,
			createExecutor: (server) =>
				scriptedExecutor({ window, grepOutput: "", server, recordCommands: commands })
		});
		const result = await client.callTool({
			name: "search_logs",
			arguments: { keyword: "x; rm -rf /" }
		});
		expect(result.isError).toBe(true);
		expect(commands).toEqual([]);
	});
});
