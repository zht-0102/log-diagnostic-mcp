#!/usr/bin/env node
/**
 * log-diagnostic-mcp entry point.
 *
 * A read-only MCP server that queries application logs on remote servers
 * over SSH and returns structured, masked diagnostic results.
 *
 * Transport: stdio (compatible with any standard MCP client).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server/mcpServer.js";

async function main(): Promise<void> {
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// MCP stdio reserves stdout for protocol messages; log to stderr only.
	console.error("[log-diagnostic-mcp] server started on stdio transport");
}

main().catch((err) => {
	console.error("[log-diagnostic-mcp] fatal error:", err);
	process.exit(1);
});
