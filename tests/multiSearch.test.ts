import { describe, expect, it } from "vitest";
import { EventEmitter, Readable } from "node:stream";
import {
	SshExecutor,
	ConcurrencyLimiter,
	type ExecStreamLike,
	type SshTransportLike
} from "../src/ssh/connection.js";
import { searchMultipleServers, selectServers } from "../src/logs/multiSearch.js";
import type { AppConfig, ServerConfig } from "../src/server/config.js";

function makeServer(name: string, environment: string): ServerConfig {
	return {
		name,
		environment,
		host: `10.0.0.${name.length}`,
		port: 22,
		username: "log-reader",
		auth: { type: "private_key", privateKeyPath: "/tmp/fake-key" },
		logPaths: ["/data/logs/app"]
	};
}

const config: AppConfig = {
	limits: {
		maxServers: 2,
		maxLines: 3000,
		timeoutSeconds: 5,
		maxConcurrentConnections: 5,
		scanLines: 20000
	},
	servers: [
		makeServer("prod-01", "prod"),
		makeServer("prod-02", "prod"),
		makeServer("staging-01", "staging")
	]
};

function streamOf(stdout: string, exitCode: number): ExecStreamLike {
	const emitter = new EventEmitter() as unknown as ExecStreamLike;
	emitter.stdout = Readable.from([Buffer.from(stdout, "utf-8")]);
	emitter.stderr = Readable.from([]);
	emitter.close = () => {};
	emitter.destroy = () => {};
	setImmediate(() => (emitter as unknown as EventEmitter).emit("close", exitCode));
	return emitter;
}

/** Mock executor that returns one match per server in app.log. */
function mockExecutor(server: ServerConfig): SshExecutor {
	const factory = async (): Promise<SshTransportLike> => ({
		exec(command: string, callback) {
			if (command.startsWith("ls -1t ")) {
				callback(undefined, streamOf("app.log\n", 0));
				return;
			}
			if (command.includes("grep -n -F")) {
				callback(undefined, streamOf(`7:${server.name} matched line\n`, 0));
				return;
			}
			callback(undefined, streamOf("", 1));
		}
	});
	return new SshExecutor(server, config.limits, new ConcurrencyLimiter(5), factory);
}

/** Mock executor that fails the SSH connection. */
function failingExecutor(server: ServerConfig): SshExecutor {
	return new SshExecutor(server, config.limits, new ConcurrencyLimiter(5), async () => {
		throw new Error(`SSH connection to ${server.host}:22 failed: connection refused`);
	});
}

describe("selectServers", () => {
	it("filters by environment", () => {
		const { selected, skipped } = selectServers(config.servers, "prod");
		expect(selected.map((s) => s.name)).toEqual(["prod-01", "prod-02"]);
		expect(skipped).toEqual(["staging-01"]);
	});

	it("filters by explicit server names", () => {
		const { selected, skipped } = selectServers(config.servers, undefined, ["staging-01"]);
		expect(selected.map((s) => s.name)).toEqual(["staging-01"]);
		expect(skipped).toEqual(["prod-01", "prod-02"]);
	});

	it("reports unknown server names", () => {
		const { unknownNames } = selectServers(config.servers, undefined, ["nope-01"]);
		expect(unknownNames).toEqual(["nope-01"]);
	});

	it("combines environment and name filters", () => {
		const { selected } = selectServers(config.servers, "prod", ["prod-02"]);
		expect(selected.map((s) => s.name)).toEqual(["prod-02"]);
	});
});

describe("searchMultipleServers", () => {
	it("searches all servers of an environment and aggregates matches", async () => {
		const result = await searchMultipleServers(
			config,
			{ keyword: "searchShippingOrderSummary", environment: "prod", maxMatchesPerServer: 100 },
			mockExecutor
		);
		expect(result.searchedServers).toEqual(["prod-01", "prod-02"]);
		expect(result.matches).toHaveLength(2);
		expect(result.matches.map((m) => m.server)).toEqual(["prod-01", "prod-02"]);
		expect(result.failures).toEqual([]);
		expect(result.truncated).toBe(false);
	});

	it("enforces limits.maxServers and flags truncation", async () => {
		const result = await searchMultipleServers(
			config,
			{ keyword: "kw", maxMatchesPerServer: 10 },
			mockExecutor
		);
		// 3 servers configured, maxServers = 2
		expect(result.searchedServers).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	it("reports unknown server names as failures without breaking the search", async () => {
		const result = await searchMultipleServers(
			config,
			{ keyword: "kw", serverNames: ["prod-01", "ghost-01"], maxMatchesPerServer: 10 },
			mockExecutor
		);
		expect(result.searchedServers).toEqual(["prod-01"]);
		expect(result.failures).toEqual([
			{ server: "ghost-01", error: "Unknown server name in configuration: ghost-01" }
		]);
		expect(result.matches).toHaveLength(1);
	});

	it("isolates connection failures per server", async () => {
		const result = await searchMultipleServers(
			config,
			{ keyword: "kw", environment: "prod", maxMatchesPerServer: 10 },
			(server) => (server.name === "prod-02" ? failingExecutor(server) : mockExecutor(server))
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].server).toBe("prod-01");
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].server).toBe("prod-02");
		expect(result.failures[0].error).toContain("connection refused");
	});
});
