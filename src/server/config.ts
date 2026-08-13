import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import dotenv from "dotenv";

/**
 * Configuration loading for log-diagnostic-mcp.
 *
 * - YAML file at `config/servers.yaml` (override with env LOG_MCP_CONFIG)
 * - `.env` is loaded via dotenv so secrets stay out of the YAML / git
 * - `${VAR}` placeholders in string values are expanded from the environment
 */

const authSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("private_key"),
		privateKeyPath: z.string().min(1, "auth.privateKeyPath is required for private_key auth")
	}),
	z.object({
		type: z.literal("password"),
		password: z.string().min(1, "auth.password is required for password auth")
	})
]);

const serverSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[\w.\-]+$/, "server name may only contain letters, digits, _ . -"),
	environment: z.string().min(1).max(50),
	host: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().min(1).max(100),
	auth: authSchema,
	logPaths: z
		.array(z.string().min(1).max(500))
		.min(1, "at least one logPath is required")
		.max(20, "at most 20 logPaths per server")
});

const limitsSchema = z.object({
	maxServers: z.number().int().min(1).max(100).default(10),
	maxLines: z.number().int().min(1).max(100000).default(3000),
	timeoutSeconds: z.number().int().min(1).max(300).default(30),
	maxConcurrentConnections: z.number().int().min(1).max(50).default(5),
	scanLines: z.number().int().min(100).max(1000000).default(20000)
});

const configSchema = z.object({
	limits: limitsSchema.default({}),
	servers: z.array(serverSchema).min(1, "at least one server must be configured")
});

export type ServerAuth = z.infer<typeof authSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type LimitsConfig = z.infer<typeof limitsSchema>;
export interface AppConfig {
	limits: LimitsConfig;
	servers: ServerConfig[];
}

/**
 * Expand `${VAR}` placeholders in a string from the environment.
 * Throws when a referenced variable is not defined, so missing
 * secrets fail fast at startup instead of producing broken SSH configs.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, varName: string) => {
		const resolved = env[varName];
		if (resolved === undefined || resolved === "") {
			throw new Error(
				`Configuration references environment variable "${varName}" but it is not set. ` +
					`Define it in .env or the process environment.`
			);
		}
		return resolved;
	});
}

/** Recursively expand `${VAR}` placeholders in all string values. */
function expandEnvDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
	if (typeof value === "string") {
		return expandEnv(value, env) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => expandEnvDeep(item, env)) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = expandEnvDeep(item, env);
		}
		return result as unknown as T;
	}
	return value;
}

/**
 * Resolve the configuration file path.
 * Priority: explicit argument > LOG_MCP_CONFIG env > config/servers.yaml (cwd).
 */
export function resolveConfigPath(explicitPath?: string): string {
	if (explicitPath) {
		return resolve(explicitPath);
	}
	if (process.env.LOG_MCP_CONFIG) {
		return resolve(process.env.LOG_MCP_CONFIG);
	}
	return resolve(process.cwd(), "config", "servers.yaml");
}

/**
 * Load, expand and validate the application configuration.
 * Throws descriptive errors for missing files, unresolved env vars or invalid shapes.
 */
export function loadConfig(explicitPath?: string): AppConfig {
	// Load .env if present (no error when absent).
	dotenv.config();

	const configPath = resolveConfigPath(explicitPath);

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		throw new Error(
			`Cannot read config file at ${configPath}. ` +
				`Copy config/servers.example.yaml to config/servers.yaml and edit it. ` +
				`(${(err as Error).message})`
		);
	}

	let parsed: unknown;
	try {
		parsed = parse(raw);
	} catch (err) {
		throw new Error(`Invalid YAML in ${configPath}: ${(err as Error).message}`);
	}

	const expanded = expandEnvDeep(parsed);
	const validation = configSchema.safeParse(expanded);
	if (!validation.success) {
		const issues = validation.error.issues
			.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid configuration in ${configPath}:\n${issues}`);
	}

	const config = validation.data;

	// Duplicate server names would make serverNames filtering ambiguous.
	const seen = new Set<string>();
	for (const server of config.servers) {
		if (seen.has(server.name)) {
			throw new Error(`Duplicate server name in configuration: "${server.name}"`);
		}
		seen.add(server.name);
	}

	return config;
}
