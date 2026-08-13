import { describe, expect, it, beforeEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, expandEnv } from "../src/server/config.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("expandEnv", () => {
	it("expands ${VAR} placeholders", () => {
		const env = { SSH_KEY: "/home/x/.ssh/id_ed25519" };
		expect(expandEnv("${SSH_KEY}", env)).toBe("/home/x/.ssh/id_ed25519");
	});

	it("expands multiple placeholders", () => {
		const env = { A: "aa", B: "bb" };
		expect(expandEnv("prefix-${A}-mid-${B}-suffix", env)).toBe("prefix-aa-mid-bb-suffix");
	});

	it("throws when variable is missing", () => {
		expect(() => expandEnv("${NOT_SET_VAR}", {})).toThrow(/NOT_SET_VAR/);
	});

	it("leaves text without placeholders unchanged", () => {
		expect(expandEnv("/data/logs/app", {})).toBe("/data/logs/app");
	});
});

describe("loadConfig", () => {
	beforeEach(() => {
		process.env.TEST_SSH_KEY_PATH = "/tmp/test-key";
	});

	it("loads a valid config and applies defaults", () => {
		const config = loadConfig(resolve(FIXTURES, "servers.valid.yaml"));

		expect(config.servers).toHaveLength(2);
		expect(config.servers[0].name).toBe("app-prod-01");
		expect(config.servers[0].auth.type).toBe("private_key");

		// port default
		expect(config.servers[0].port).toBe(22);
		// explicit port
		expect(config.servers[1].port).toBe(2222);

		// limits: provided values kept, others defaulted
		expect(config.limits.maxServers).toBe(3);
		expect(config.limits.timeoutSeconds).toBe(15);
		expect(config.limits.maxLines).toBe(3000);
		expect(config.limits.maxConcurrentConnections).toBe(5);
		expect(config.limits.scanLines).toBe(20000);
	});

	it("expands environment variables in privateKeyPath", () => {
		const config = loadConfig(resolve(FIXTURES, "servers.valid.yaml"));
		expect(config.servers[0].auth.type).toBe("private_key");
		if (config.servers[0].auth.type === "private_key") {
			expect(config.servers[0].auth.privateKeyPath).toBe("/tmp/test-key");
		}
	});

	it("rejects invalid config (bad port, missing auth field, empty logPaths)", () => {
		expect(() => loadConfig(resolve(FIXTURES, "servers.invalid.yaml"))).toThrow(/Invalid configuration/);
	});

	it("rejects duplicate server names", () => {
		expect(() => loadConfig(resolve(FIXTURES, "servers.duplicate.yaml"))).toThrow(/Duplicate server name/);
	});

	it("throws descriptive error for missing config file", () => {
		expect(() => loadConfig(resolve(FIXTURES, "does-not-exist.yaml"))).toThrow(/Cannot read config file/);
	});
});
