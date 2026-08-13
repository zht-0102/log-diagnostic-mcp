import { shellQuote, validateKeyword, validateLogPath } from "../security/shellGuard.js";

/**
 * 本服务器在远程执行的命令，仅此几种，这里是它们的构造器。
 * 每个构造器都：
 * - 用严格白名单校验输入，
 * - 对每个动态参数做 POSIX 单引号转义，
 * - 只生成严格只读的管道（tail / grep / cat / awk / ls / wc）。
 */

/** `tail -n <N> <file>` —— 读取单个日志文件的最后 N 行。 */
export function buildTailCommand(scanLines: number, filePath: string): string {
	validateLogPath(filePath);
	if (!Number.isInteger(scanLines) || scanLines < 1) {
		throw new Error(`Invalid scanLines: ${scanLines}`);
	}
	return `tail -n ${scanLines} ${shellQuote(filePath)}`;
}

/**
 * `tail -n <N> <file> | grep -n -F -e <keyword>` ——
 * 限定在最后 N 行内的关键词搜索。`-F` 保证关键词按字面量匹配
 * （不作正则解释），`-n` 输出行号前缀。
 */
export function buildGrepTailCommand(scanLines: number, keyword: string, filePath: string): string {
	validateLogPath(filePath);
	validateKeyword(keyword);
	if (!Number.isInteger(scanLines) || scanLines < 1) {
		throw new Error(`Invalid scanLines: ${scanLines}`);
	}
	return `tail -n ${scanLines} ${shellQuote(filePath)} | grep -n -F -e ${shellQuote(keyword)}`;
}

/** `gzip -cd <file.gz> | grep -n -F -e <keyword>` —— 只读解压压缩日志并按字面量搜索。 */
export function buildGzipGrepCommand(keyword: string, filePath: string): string {
	validateLogPath(filePath);
	validateKeyword(keyword);
	return `gzip -cd ${shellQuote(filePath)} | grep -n -F -e ${shellQuote(keyword)}`;
}

/** `gzip -cd <file.gz> | tail -n <N>` —— 只读解压压缩日志并取最后 N 行上下文窗口。 */
export function buildGzipTailCommand(scanLines: number, filePath: string): string {
	validateLogPath(filePath);
	if (!Number.isInteger(scanLines) || scanLines < 1) {
		throw new Error(`Invalid scanLines: ${scanLines}`);
	}
	return `gzip -cd ${shellQuote(filePath)} | tail -n ${scanLines}`;
}

/**
 * `cat <file> | awk 'NR>=start && NR<=end'` ——
 * 读取文件的物理行区间 [fromLine, toLine]（含两端）。
 * 用于获取命中行周围的上下文。
 */
export function buildLineRangeCommand(filePath: string, fromLine: number, toLine: number): string {
	validateLogPath(filePath);
	if (!Number.isInteger(fromLine) || fromLine < 1 || !Number.isInteger(toLine) || toLine < fromLine) {
		throw new Error(`Invalid line range: ${fromLine}-${toLine}`);
	}
	return `cat ${shellQuote(filePath)} | awk 'NR>=${fromLine} && NR<=${toLine}'`;
}

/**
 * `wc -l < <file>` —— 统计文件行数（只读，输出一个数字）。
 */
export function buildLineCountCommand(filePath: string): string {
	validateLogPath(filePath);
	return `wc -l < ${shellQuote(filePath)}`;
}

/**
 * `ls -1t <dir> | grep -E '\.log(\.[0-9]+)?$'` ——
 * 列出配置目录直属的纯文本滚动日志文件，最新的在前
 * （不做 glob 展开，不递归）。
 */
export function buildListLogFilesCommand(directory: string): string {
	validateLogPath(directory);
	return `ls -1t ${shellQuote(directory)} | grep -E '\\.log(\\.[0-9]+)?$'`;
}
