// Append-only storage backend over DSH's session format v4 log (see dsh-session-log.ts).
// Selected explicitly with setSessionStorageBackend(); pi's default backend stays untouched.
import type { SessionEntry, SessionHeader } from "../session-manager.ts";
import {
	createDshStoredLineDecoder,
	DshSessionLogRefusedError,
	decodeDshStoredText,
	encodeDshEventRow,
	encodeDshSessionLog,
	isDshHeaderLine,
	isDshSessionLog,
	parsePiFileEntry,
} from "./dsh-session-log.ts";
import {
	defaultSessionStorageBackend,
	type SessionLineScanResult,
	type SessionStorageBackend,
	SessionStorageConflict,
	type SessionStorageIndexEntry,
	type SessionStorageStat,
} from "./storage-backend.ts";

/**
 * A write would replace or shrink a stored session format v4 log instead of extending it, or
 * truncate one outright. The v4 log is append-only: entries are added as new rows and existing
 * bytes are never rewritten.
 */
export class DshAppendOnlyViolation extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${message}: ${path}`);
		this.name = "DshAppendOnlyViolation";
		this.path = path;
	}
}

/** Count the non-blank lines of a stored log: header line plus the rows written so far. */
function countStoredLines(text: string): number {
	let count = 0;
	let start = 0;
	for (;;) {
		const newline = text.indexOf("\n", start);
		const line = newline === -1 ? text.slice(start) : text.slice(start, newline);
		if (line.trim()) count++;
		if (newline === -1) return count;
		start = newline + 1;
	}
}

/** Parse one appended pi JSONL line as an entry; headers and malformed text are refused. */
function requireSessionEntry(line: string): SessionEntry {
	const entry = parsePiFileEntry(line);
	if (entry === null) {
		throw new DshSessionLogRefusedError(
			`appended line is not valid session JSON: ${JSON.stringify(line.slice(0, 80))}`,
		);
	}
	if (entry.type === "session") {
		throw new DshSessionLogRefusedError("appending a session header line as an entry is not allowed");
	}
	return entry;
}

/** Encode full pi JSONL text as one stored v4 log (header first, then its entries in order). */
function encodeSessionText(text: string, appended?: SessionEntry): string {
	let header: SessionHeader | null = null;
	const entries: SessionEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const entry = parsePiFileEntry(line);
		if (entry === null) {
			throw new DshSessionLogRefusedError(
				`session text line is not valid JSON: ${JSON.stringify(line.slice(0, 80))}`,
			);
		}
		if (entry.type === "session") {
			if (header !== null) {
				throw new DshSessionLogRefusedError("session text carries more than one session header");
			}
			header = entry;
		} else {
			entries.push(entry);
		}
	}
	if (header === null) {
		throw new DshSessionLogRefusedError("session text has no session header line");
	}
	return encodeDshSessionLog(header, appended === undefined ? entries : [...entries, appended]);
}

/**
 * Session storage that persists pi sessions as DSH's append-only session format v4 log.
 *
 * Reads project the stored log back onto pi's JSONL, so a file written by this backend decodes to
 * the same header and entries a plain pi file would hold; a file this backend did not write (pi's
 * own JSONL) reads through unchanged. Writes always store the v4 log: `writeFull` may extend an
 * existing log but refuses to replace it with content that does not start with the stored bytes,
 * and `append` adds one dense row. Selecting this backend is opt-in
 * (`setSessionStorageBackend`), so the default path keeps pi's exact file bytes.
 */
export class DshAppendOnlySessionStorageBackend implements SessionStorageBackend {
	#inner: SessionStorageBackend;

	constructor(inner: SessionStorageBackend = defaultSessionStorageBackend) {
		this.#inner = inner;
	}

	init(dir: string): void {
		this.#inner.init(dir);
	}

	loadIndex(dir: string): Iterable<SessionStorageIndexEntry> {
		return this.#inner.loadIndex(dir);
	}

	readFull(path: string): string | null {
		const stored = this.#inner.readFull(path);
		if (stored === null || !isDshSessionLog(stored)) return stored;
		return decodeDshStoredText(stored);
	}

	/**
	 * Byte windows of the projected pi text. The projection decodes the whole log first, so the
	 * windows are bounded by the decoded text's size rather than the stored file's.
	 */
	readSlices(path: string, prefixBytes: number, suffixBytes: number): [string, string] {
		const text = this.readFull(path);
		if (text === null) {
			// readSlices throws for a missing file; the inner backend supplies that error.
			this.#inner.stat(path);
		}
		const bytes = Buffer.from(text ?? "", "utf8");
		return [
			bytes.subarray(0, prefixBytes).toString("utf8"),
			bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf8"),
		];
	}

	readLines(path: string, onLine: (line: string) => void): SessionLineScanResult | null {
		const decoder = createDshStoredLineDecoder();
		return this.#inner.readLines(path, (line) => {
			const projected = decoder.push(line);
			if (projected !== null) onLine(projected);
		});
	}

	async readLinesAsync(
		path: string,
		onLine: (line: string) => void,
		signal?: AbortSignal,
	): Promise<SessionLineScanResult | null> {
		const decoder = createDshStoredLineDecoder();
		return this.#inner.readLinesAsync(
			path,
			(line) => {
				const projected = decoder.push(line);
				if (projected !== null) onLine(projected);
			},
			signal,
		);
	}

	writeFull(path: string, content: string | Iterable<string>, mtimeMs: number, expectedSize?: number | null): void {
		const text = typeof content === "string" ? content : Array.from(content).join("");
		const stored = this.#inner.readFull(path);
		if (expectedSize !== undefined) {
			const actualSize = stored === null ? null : Buffer.byteLength(stored, "utf8");
			if (actualSize !== expectedSize) {
				throw new SessionStorageConflict(path, expectedSize, actualSize);
			}
		}
		const encoded = text.trim() === "" ? text : encodeSessionText(text);
		if (stored !== null && isDshSessionLog(stored) && !encoded.startsWith(stored)) {
			throw new DshAppendOnlyViolation(
				path,
				"refusing to replace a session format v4 log with content that does not extend it",
			);
		}
		this.#inner.writeFull(path, encoded, mtimeMs, expectedSize);
	}

	append(path: string, line: string, mtimeMs: number): void {
		// A bare newline is pi's repair for an unterminated final record; it adds no entry.
		if (line === "\n") {
			this.#inner.append(path, line, mtimeMs);
			return;
		}
		const stored = this.#inner.readFull(path);
		if (stored === null) {
			if (!isDshHeaderLine(line)) {
				throw new DshSessionLogRefusedError(
					"creating a session format v4 log by append requires a session header line",
				);
			}
			this.#inner.writeFull(path, line, mtimeMs, null);
			return;
		}
		const entry = requireSessionEntry(line);
		if (!isDshSessionLog(stored)) {
			// A log pi wrote in its own format converts once, with the new entry in the same write.
			const converted = encodeSessionText(stored, entry);
			this.#inner.writeFull(path, converted, mtimeMs, Buffer.byteLength(stored, "utf8"));
			return;
		}
		// Dense `seq` is the stored log's next physical line: header line plus rows written so far.
		const row = encodeDshEventRow(entry, countStoredLines(stored) - 1);
		this.#inner.append(path, `${row}\n`, mtimeMs);
	}

	/** Append-only: a v4 log has no in-place clear. No session-manager path calls this. */
	truncate(path: string, _mtimeMs: number): void {
		throw new DshAppendOnlyViolation(path, "refusing to truncate a session file held by the append-only backend");
	}

	remove(paths: string[]): void {
		this.#inner.remove(paths);
	}

	move(src: string, dst: string, mtimeMs: number): void {
		this.#inner.move(src, dst, mtimeMs);
	}

	stat(path: string): SessionStorageStat {
		return this.#inner.stat(path);
	}
}
