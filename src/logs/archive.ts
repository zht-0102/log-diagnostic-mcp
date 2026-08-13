import { validateLogPath } from "../security/shellGuard.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_DAYS = 31;

export interface ArchiveLogFile {
	type: "archive";
	dateDirectory: string;
	fileName: string;
	filePath: string;
}

function localDateToken(ms: number, localOffsetMs: number): string {
	const local = new Date(ms + localOffsetMs);
	const year = String(local.getUTCFullYear()).slice(-2);
	const month = String(local.getUTCMonth() + 1).padStart(2, "0");
	const day = String(local.getUTCDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

function startOfLocalDayMs(ms: number, localOffsetMs: number): number {
	const local = new Date(ms + localOffsetMs);
	return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - localOffsetMs;
}

export function archiveDateDirectoriesBetween(
	startMs: number,
	endMs: number,
	localOffsetMs: number
): string[] {
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
		throw new Error("Invalid archive time range");
	}

	const directories: string[] = [];
	let cursor = startOfLocalDayMs(startMs, localOffsetMs);
	const endDay = startOfLocalDayMs(endMs, localOffsetMs);
	while (cursor <= endDay) {
		directories.push(localDateToken(cursor, localOffsetMs));
		if (directories.length > MAX_ARCHIVE_DAYS) {
			throw new Error(`Archive time range is too large: max ${MAX_ARCHIVE_DAYS} days`);
		}
		cursor += MS_PER_DAY;
	}
	return directories;
}

export function archiveGlobPattern(logFileName: string, dateDirectory: string): string {
	if (!/^[\w.\-]+$/.test(logFileName)) {
		throw new Error(`Invalid log file name: ${logFileName}`);
	}
	if (!/^\d{6}$/.test(dateDirectory)) {
		throw new Error(`Invalid archive date directory: ${dateDirectory}`);
	}
	return `${logFileName}.${dateDirectory}*.gz`;
}

export function resolveArchiveLogFile(
	logPath: string,
	logFileName: string,
	dateDirectory: string,
	fileName: string
): ArchiveLogFile {
	validateLogPath(logPath);
	if (!fileName.startsWith(`${logFileName}.${dateDirectory}`) || !fileName.endsWith(".gz")) {
		throw new Error(`Archive file does not match ${logFileName}.${dateDirectory}*.gz: ${fileName}`);
	}
	const filePath = `${logPath}/${dateDirectory}/${fileName}`;
	validateLogPath(filePath);
	return { type: "archive", dateDirectory, fileName, filePath };
}
