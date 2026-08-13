import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../src/server/mcpServer.js";

/**
 * Connect a test client to a fresh server instance over an in-memory pair.
 */
async function connectClient(): Promise<Client> {
	const server = createServer();
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

describe("search_logs tool (MVP step 1 skeleton)", () => {
	it("accepts keyword-only input and applies defaults", async () => {
		const client = await connectClient();
		const result = await client.callTool({
			name: "search_logs",
			arguments: { keyword: "searchShippingOrderSummary" }
		});
		const content = result.content as Array<{ type: string; text: string }>;
		expect(content[0].type).toBe("text");
		const payload = JSON.parse(content[0].text);
		expect(payload.status).toBe("NOT IMPLEMENTED");
		expect(payload.receivedArguments.keyword).toBe("searchShippingOrderSummary");
		expect(payload.receivedArguments.contextBefore).toBe(30);
		expect(payload.receivedArguments.contextAfter).toBe(50);
	});

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
