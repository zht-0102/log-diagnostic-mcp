import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchLogsTool, type SearchLogsDependencies } from "../tools/searchLogs.js";

export const SERVER_NAME = "log-diagnostic-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * 创建注册好全部工具的 MCP 服务器实例。
 * 封装为工厂函数，方便测试构造相互隔离的实例。
 */
export function createServer(deps: SearchLogsDependencies = {}): McpServer {
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

	registerSearchLogsTool(server, deps);

	return server;
}
