/**
 * Structured diagnostics log.
 *
 * Records land in a rotating JSON-lines file under the user's private agent
 * directory and never on the console: writing to stdout/stderr while the TUI
 * is drawing corrupts the screen. Rotating file, per-process name, size-based
 * rollover and retention — the shape of omp `packages/utils/src/logger.ts:4`,
 * reduced to what pi's error paths need.
 *
 * Every line is redacted before it is written, so `pi doctor` can print log
 * tails verbatim.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { APP_NAME, getAgentDir } from "../config.ts";
import { redactSecrets } from "./redact.ts";

export type StructuredLogLevel = "error" | "warn" | "info" | "debug";

interface StructuredLogConfig {
	/** Directory holding the log files; defaults to `<agentDir>/logs`. */
	directory?: string;
	/** Size of one file before it rolls over. */
	maxBytes: number;
	/** Files kept per process day after rollover. */
	maxFiles: number;
	/** Finished-process files kept before the oldest are pruned. */
	retentionDays: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_RETENTION_DAYS = 14;
/** Longest tail of one file read back by {@link readStructuredLogTail}. */
const TAIL_READ_BYTES = 256 * 1024;

let config: StructuredLogConfig = {
	maxBytes: DEFAULT_MAX_BYTES,
	maxFiles: DEFAULT_MAX_FILES,
	retentionDays: DEFAULT_RETENTION_DAYS,
};

/** Bytes written to the current file, tracked to avoid a stat per record. */
let currentFile: string | undefined;
let currentBytes = 0;
let pruned = false;

/**
 * Point the log at another directory (tests, embedded runs) or tune rollover.
 * Clears the write cursor so the next record opens the new location.
 */
export function configureStructuredLog(
	options: { directory?: string; maxBytes?: number; maxFiles?: number; retentionDays?: number } = {},
): void {
	config = {
		directory: options.directory ?? config.directory,
		maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
		maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
		retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
	};
	currentFile = undefined;
	currentBytes = 0;
	pruned = false;
}

function resolveDirectory(): string {
	return config.directory ?? join(getAgentDir(), "logs");
}

function localDay(date: Date): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function baseFileName(date = new Date()): string {
	return `${APP_NAME}.${localDay(date)}.${process.pid}.jsonl`;
}

/** Path a record appended right now would land in (before rollover). */
export function structuredLogPath(date = new Date()): string {
	return join(resolveDirectory(), baseFileName(date));
}

function filePattern(): RegExp {
	const escaped = APP_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}\\.\\d{4}-\\d{2}-\\d{2}\\.\\d+\\.jsonl(?:\\.\\d+)?$`);
}

function removeBestEffort(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Another pi process may have rolled or removed the same file.
	}
}

/** Age out finished-process files past the retention window. Best effort. */
function pruneOldFiles(directory: string): void {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}
	const pattern = filePattern();
	const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
	for (const name of entries) {
		if (!pattern.test(name)) continue;
		try {
			if (statSync(join(directory, name)).mtimeMs < cutoff) removeBestEffort(join(directory, name));
		} catch {
			// Raced with another process; the next run prunes again.
		}
	}
}

/** Roll the current file once it exceeds `maxBytes`, keeping `maxFiles` copies. */
function rollIfNeeded(path: string): void {
	if (currentBytes < config.maxBytes) return;
	for (let index = Math.max(config.maxFiles - 1, 1); index >= 1; index--) {
		const from = index === 1 ? path : `${path}.${index - 1}`;
		const to = `${path}.${index}`;
		if (!existsSync(from)) continue;
		try {
			renameSync(from, to);
		} catch {
			removeBestEffort(to);
			try {
				renameSync(from, to);
			} catch {
				return;
			}
		}
	}
	const overflow = `${path}.${config.maxFiles}`;
	if (existsSync(overflow)) removeBestEffort(overflow);
	currentBytes = 0;
}

/**
 * JSON.stringify replacer that unwraps errors. Error's own properties are
 * non-enumerable, so a plain stringify yields `"{}"` and a `{ err }` context
 * loses message, stack, and cause.
 */
function errorReplacer(_key: string, value: unknown): unknown {
	if (!(value instanceof Error)) return value;
	const out: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
	const asRecord = value as unknown as Record<string, unknown>;
	for (const key in asRecord) out[key] = asRecord[key];
	if (value.cause !== undefined) out.cause = value.cause;
	return out;
}

/**
 * Append one redacted record to the rotating log.
 *
 * Never throws and never writes to the console: a diagnostics failure must not
 * mask the error being reported.
 */
export function logEvent(level: StructuredLogLevel, message: string, context?: Record<string, unknown>): void {
	try {
		const record: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level,
			pid: process.pid,
			message,
		};
		if (context !== undefined) record.context = context;
		const line = `${redactSecrets(JSON.stringify(record, errorReplacer))}\n`;
		const directory = resolveDirectory();
		const path = structuredLogPath();
		if (currentFile !== path) {
			currentFile = path;
			currentBytes = existsSync(path) ? statSync(path).size : 0;
			if (!pruned) {
				pruned = true;
				pruneOldFiles(directory);
			}
		}
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		rollIfNeeded(path);
		appendFileSync(path, line, { mode: 0o600 });
		currentBytes += Buffer.byteLength(line);
	} catch {
		// Logging is a side channel; the caller's own error still surfaces.
	}
}

function readTailLines(path: string, limit: number): string[] {
	let text: string;
	try {
		const file = readFileSync(path);
		text = file.subarray(Math.max(0, file.byteLength - TAIL_READ_BYTES)).toString("utf8");
	} catch {
		return [];
	}
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	return lines.slice(Math.max(0, lines.length - limit));
}

/**
 * Chronological tail of the structured log: oldest file first, oldest record
 * first within a file, capped to `limit` records. Lines are already redacted
 * at write time, so the tail can be reproduced verbatim.
 */
export function readStructuredLogTail(limit = 20): string[] {
	const directory = resolveDirectory();
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return [];
	}
	const pattern = filePattern();
	const ordered = entries
		.filter((name) => pattern.test(name))
		.map((name) => ({ name, path: join(directory, name) }))
		.sort((a, b) => {
			try {
				return statSync(a.path).mtimeMs - statSync(b.path).mtimeMs;
			} catch {
				return a.name < b.name ? -1 : 1;
			}
		});
	const records: string[] = [];
	for (const entry of ordered) {
		records.push(...readTailLines(entry.path, limit));
	}
	return records.slice(Math.max(0, records.length - limit));
}
