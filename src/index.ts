#!/usr/bin/env node
/**
 * log-diagnostic-mcp 入口。
 *
 * 一个只读的 MCP 服务器：通过 SSH 查询远程服务器上的应用日志，
 * 并返回结构化、已脱敏的诊断结果。
 *
 * 传输方式：stdio（兼容任意标准 MCP 客户端）。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server/mcpServer.js";

async function main(): Promise<void> {
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// MCP stdio 协议占用 stdout，日志只能输出到 stderr。
	console.error("[log-diagnostic-mcp] server started on stdio transport");
}

main().catch((err) => {
	console.error("[log-diagnostic-mcp] fatal error:", err);
	process.exit(1);
});
