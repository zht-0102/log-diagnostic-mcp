import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchLogsTool } from "../tools/searchLogs.js";

export const SERVER_NAME = "log-diagnostic-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Create the MCP server instance with all tools registered.
 * Kept as a factory so tests can construct isolated instances.
 */
export function createServer(): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			instructions:
				"Read-only log query and basic diagnosis server. Use the search_logs tool to " +
				"search application logs on configured remote servers by keyword, and get back " +
				"matched lines with context, request/response extracts, MyBatis SQL, exceptions " +
				"and a basic cause analysis. This server never executes state-changing commands."
		}
	);

	registerSearchLogsTool(server);

	return server;
}
