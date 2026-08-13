import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Input schema for the search_logs tool.
 * Only `keyword` is required; everything else has sensible defaults.
 */
export const searchLogsInputSchema = {
	keyword: z
		.string()
		.min(1)
		.max(200)
		.describe("Log keyword to search for, e.g. a method name or business id"),
	environment: z
		.string()
		.max(50)
		.optional()
		.describe("Environment filter, e.g. prod / staging. Defaults to all environments"),
	serverNames: z
		.array(z.string().max(100))
		.max(20)
		.optional()
		.describe("Restrict the search to these configured server names"),
	startTime: z
		.string()
		.optional()
		.describe("ISO 8601 start time, e.g. 2026-08-13T10:00:00+08:00. Defaults to 30 minutes before endTime"),
	endTime: z
		.string()
		.optional()
		.describe("ISO 8601 end time. Defaults to now"),
	contextBefore: z
		.number()
		.int()
		.min(0)
		.max(500)
		.default(30)
		.describe("Number of log lines to return before each match"),
	contextAfter: z
		.number()
		.int()
		.min(0)
		.max(500)
		.default(50)
		.describe("Number of log lines to return after each match")
};

export type SearchLogsInput = z.infer<
	z.ZodObject<{
		[K in keyof typeof searchLogsInputSchema]: (typeof searchLogsInputSchema)[K];
	}>
>;

/**
 * Register the single MVP tool: search_logs.
 *
 * Security note: this server exposes NO arbitrary shell execution tool.
 * Remote commands are built only from fixed, read-only templates with
 * strictly validated and quoted arguments (see ssh/ and security/ modules).
 */
export function registerSearchLogsTool(server: McpServer): void {
	server.registerTool(
		"search_logs",
		{
			title: "Search Server Logs",
			description:
				"Search application logs on configured remote servers by keyword over SSH (read-only). " +
				"Returns matched log lines with surrounding context, extracted request parameters, " +
				"response body, MyBatis SQL, exceptions and a basic cause analysis. " +
				"If no time range is given, the last 30 minutes are searched.",
			inputSchema: searchLogsInputSchema
		},
		async (args) => {
			// MVP step 1: skeleton only. Real implementation lands in later steps.
			const payload = {
				status: "NOT IMPLEMENTED",
				message: "search_logs is a skeleton in the current MVP step",
				receivedArguments: args
			};
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
			};
		}
	);
}
