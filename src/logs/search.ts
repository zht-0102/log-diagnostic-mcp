import type { ServerConfig, LimitsConfig } from "../server/config.js";
import type { SshExecutor, ExecResult } from "../ssh/connection.js";
import {
	buildGrepTailCommand,
	buildListLogFilesCommand
} from "../ssh/commands.js";
import { validateKeyword } from "../security/shellGuard.js";

/**
 * 单服务器日志搜索。
 *
 * 策略（绝不扫描全量历史）：
 * 1. 列出每个已配置 logPath 下的 `*.log` 文件（最新的在前，有上限）。
 * 2. 对每个文件，只在最后 `scanLines` 行内 grep 关键词。
 * 3. 收集命中行及其在扫描窗口内的位置。
 */

/** 单次关键词命中。 */
export interface LogMatch {
	/** 配置中的服务器名。 */
	server: string;
	/** 服务器所属环境，如 prod。 */
	environment: string;
	/** 远程服务器上日志文件的绝对路径。 */
	logFile: string;
	/** 在扫描（tail）窗口内的行号，1 开始。 */
	lineInWindow: number;
	/** 命中的日志行（原始内容，未脱敏）。 */
	matchedLine: string;
	/** 从行内解析出的时间戳（ISO 字符串）；未识别时为 null。 */
	timestamp: string | null;
}

export interface SingleServerSearchResult {
	server: string;
	environment: string;
	matches: LogMatch[];
	/** 非致命问题（目录不存在、权限错误等），每条资源一条。 */
	errors: string[];
	/** 该服务器命中数达到上限、可能还有更多命中时为 true。 */
	truncated: boolean;
}

export interface SearchOptions {
	keyword: string;
	/** 单台服务器收集到这么多命中后停止。 */
	maxMatches: number;
}

/** 每个配置路径最多扫描的日志文件数（最新的在前）。 */
export const MAX_FILES_PER_PATH = 5;

/** grep 退出码：0 = 有匹配，1 = 无匹配，>=2 = 出错。 */
function isGrepError(result: ExecResult): boolean {
	return result.exitCode >= 2;
}

/** 解析 `grep -n` 输出中形如 `<行号>:<内容>` 的行。 */
export function parseGrepOutput(stdout: string): Array<{ lineInWindow: number; matchedLine: string }> {
	const results: Array<{ lineInWindow: number; matchedLine: string }> = [];
	for (const line of stdout.split("\n")) {
		if (line.length === 0) continue;
		const match = /^(\d+):(.*)$/.exec(line);
		if (!match) continue;
		results.push({ lineInWindow: Number(match[1]), matchedLine: match[2] });
	}
	return results;
}

/** 列出单个目录下的日志文件；目录不可用时返回 [] 并记录一条错误。 */
async function listLogFiles(
	executor: SshExecutor,
	directory: string,
	errors: string[]
): Promise<string[]> {
	const result = await executor.exec(buildListLogFilesCommand(directory));
	// grep 退出码 1：目录存在但没有 .log 文件 —— 不算错误。
	if (result.exitCode === 1) return [];
	if (isGrepError(result)) {
		errors.push(`Cannot list log files in ${directory}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
		return [];
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, MAX_FILES_PER_PATH);
}

/**
 * 在一台服务器的所有已配置日志路径中搜索关键词。
 * executor 通过参数注入，方便测试替换为 mock 传输层。
 */
export async function searchSingleServer(
	executor: SshExecutor,
	server: ServerConfig,
	limits: LimitsConfig,
	options: SearchOptions
): Promise<SingleServerSearchResult> {
	validateKeyword(options.keyword);

	const matches: LogMatch[] = [];
	const errors: string[] = [];
	let truncated = false;

	for (const logPath of server.logPaths) {
		if (matches.length >= options.maxMatches) {
			truncated = true;
			break;
		}

		const files = await listLogFiles(executor, logPath, errors);
		for (const fileName of files) {
			if (matches.length >= options.maxMatches) {
				truncated = true;
				break;
			}

			const filePath = `${logPath}/${fileName}`;
			const command = buildGrepTailCommand(limits.scanLines, options.keyword, filePath);
			const result = await executor.exec(command);

			if (isGrepError(result)) {
				errors.push(`Search failed in ${filePath}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
				continue;
			}
			if (result.exitCode === 1) continue; // 该文件内无匹配

			for (const hit of parseGrepOutput(result.stdout)) {
				if (matches.length >= options.maxMatches) {
					truncated = true;
					break;
				}
				matches.push({
					server: server.name,
					environment: server.environment,
					logFile: filePath,
					lineInWindow: hit.lineInWindow,
					matchedLine: hit.matchedLine,
					timestamp: null // 由时间范围步骤回填
				});
			}
			if (result.truncated || result.timedOut) {
				errors.push(
					result.timedOut
						? `Search timed out in ${filePath}`
						: `Search output truncated in ${filePath}`
				);
			}
		}
	}

	return { server: server.name, environment: server.environment, matches, errors, truncated };
}
