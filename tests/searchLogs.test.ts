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
	archiveFiles?: string;
	recordCommands?: string[];
}): SshExecutor {
	const limits = fakeConfig().limits;
	const factory = async (): Promise<SshTransportLike> => ({
		exec(command: string, callback) {
			opts.recordCommands?.push(command);
			if (command.startsWith("ls -1t ")) {
				if (command.includes("/260812")) {
					callback(undefined, streamOf(opts.archiveFiles ?? "", opts.archiveFiles ? 0 : 1));
					return;
				}
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
			if (command.startsWith("gzip -cd ")) {
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
		expect(payload.searchedSources[0]).toMatchObject({
			type: "current",
			logFile: "/data/logs/shipping/app.log",
			commandKind: "tail_grep",
			matched: true
		});

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

	it("returns SaaS event summaries when saas_event mode is requested", async () => {
		const stamp = `${nowStamp()}.123`;
		const saasLines = [
			`${stamp}  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : PosSaletoIvn:{"saledate":"2026-06-15","datatype":"I","eshopflag":"f","terid":"16"}`,
			`${stamp}  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : :SELECT aa.warehouse_id id from set_ter_define aa where aa.id=16`,
			`${stamp}  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : pos回调函数>>{"MSG":"单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31","STATUS":"ERR"}`,
			"java.sql.SQLException: 单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31",
			"\tat com.sw.saas.inv.possale.service.PosSaleInterfaceImpl.PosSaletoIvn(PosSaleInterfaceImpl.java:622)"
		];
		const window = `${saasLines.join("\n")}\n`;
		const grepOutput = `1:${saasLines[0]}\n2:${saasLines[1]}\n3:${saasLines[2]}`;
		const commands: string[] = [];

		const client = await connectClient({
			loadConfiguration: fakeConfig,
			createExecutor: (server) => scriptedExecutor({ window, grepOutput, server, recordCommands: commands })
		});

		const result = await client.callTool({
			name: "search_logs",
			arguments: {
				keyword: "2832996880440973688",
				contextBefore: 0,
				contextAfter: 4,
				mode: "saas_event",
				eventLimit: 5
			}
		});
		const payload = parsePayload(result);

		expect(payload.status).toBe("success");
		expect(payload.saasEvents).toHaveLength(1);
		expect(payload.saasEvents[0].traceId).toBe("2832996880440973688");
		expect(payload.saasEvents[0].payloads[0].label).toBe("PosSaletoIvn");
		expect(payload.saasEvents[0].payloads[1].label).toBe("pos回调函数");
		expect(payload.saasEvents[0].sql[0].sql).toContain("SELECT aa.warehouse_id");
		expect(payload.saasEvents[0].exceptions[0].type).toBe("java.sql.SQLException");
		expect(payload.saasEvents[0].diagnosis.confirmedFacts.join("\n")).toContain("单据日期:2026-06-15");
		expect(payload.diagnosticEvents).toHaveLength(1);
		expect(payload.diagnosticEvents[0].summary).toMatchObject({
			result: "error",
			errorType: "java.sql.SQLException",
			businessFlow: "POS零售出库回调处理"
		});
		expect(payload.diagnosticEvents[0].summary.location).toMatchObject({
			methodName: "PosSaletoIvn",
			fileName: "PosSaleInterfaceImpl.java",
			lineNumber: 622
		});
		expect(payload.diagnosticEvents[0].trace).toMatchObject({
			server: "shipping-prod-01",
			logFile: "/data/logs/shipping/saas.log"
		});
		expect(payload.diagnosticEvents[0].request.label).toBe("PosSaletoIvn");
		expect(payload.diagnosticEvents[0].response.label).toBe("pos回调函数");
		expect(payload.diagnosticEvents[0].context.error.join("\n")).toContain("java.sql.SQLException");
		expect(commands.some((command) => command.startsWith("ls -1t "))).toBe(false);
		expect(commands.filter((command) => command.includes("| grep -n -F -e"))).toEqual([
			"tail -n 20000 '/data/logs/shipping/saas.log' | grep -n -F -e '2832996880440973688'"
		]);
	});

	it("searches SaaS archived gzip logs for an explicit historical time range", async () => {
		const saasLine =
			"2026-08-12 03:51:10.123  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : PosSaletoIvn:{\"saledate\":\"2026-06-15\",\"datatype\":\"I\"}";
		const window = `${saasLine}\n`;
		const commands: string[] = [];

		const client = await connectClient({
			loadConfiguration: fakeConfig,
			createExecutor: (server) =>
				scriptedExecutor({
					window,
					grepOutput: `1:${saasLine}`,
					archiveFiles: "saas.log.260812.10.gz\n",
					server,
					recordCommands: commands
				})
		});

		const result = await client.callTool({
			name: "search_logs",
			arguments: {
				keyword: "2832996880440973688",
				startTime: "2026-08-12T03:40:00+08:00",
				endTime: "2026-08-12T04:20:00+08:00",
				contextBefore: 0,
				contextAfter: 0,
				mode: "saas_event"
			}
		});
		const payload = parsePayload(result);

		expect(payload.status).toBe("success");
		expect(payload.query.archivePolicy).toBe("auto");
		expect(payload.query.archiveDateDirectories).toEqual(["260812"]);
		expect(payload.query.includeCurrentLogs).toBe(false);
		expect(payload.matches[0].logFile).toBe("/data/logs/shipping/260812/saas.log.260812.10.gz");
		expect(payload.searchedSources).toEqual([
			{
				server: "shipping-prod-01",
				environment: "prod",
				type: "archive",
				logFile: "/data/logs/shipping/260812/saas.log.260812.10.gz",
				dateDirectory: "260812",
				commandKind: "gzip_grep",
				matched: true
			}
		]);
		expect(commands).toEqual([
			"ls -1t '/data/logs/shipping/260812' | grep -E '^saas\\.log\\.260812.*\\.gz$'",
			"gzip -cd '/data/logs/shipping/260812/saas.log.260812.10.gz' | grep -n -F -e '2832996880440973688'",
			"gzip -cd '/data/logs/shipping/260812/saas.log.260812.10.gz'"
		]);
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
