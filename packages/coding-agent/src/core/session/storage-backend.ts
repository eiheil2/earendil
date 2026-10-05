import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "fs";
import { join, sep } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";

/** Chunk size for bounded window reads (readSlices). */
const SLICE_READ_CHUNK = 64 * 1024;
/** Chunk size for whole-file line scans (readLines). */
const LINE_READ_CHUNK = 1024 * 1024;

/** Session file record returned by loadIndex for discovery ordering. */
export interface SessionStorageIndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
}

/** Size and modification time of a single session file. */
export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
}

/** Outcome of a line scan over a session file. */
export interface SessionLineScanResult {
	/** True when the file's final line had no trailing newline. */
	unterminatedFinalLine: boolean;
}

/**
 * A session file changed between a caller's read and its conditional
 * write, so replacing it would discard another writer's durable
 * entries. `expectedSize` and `actualSize` are UTF-8 byte lengths,
 * or null when the file is missing.
 */
export class SessionStorageConflict extends Error {
	readonly path: string;
	readonly expectedSize: number | null;
	readonly actualSize: number | null;

	constructor(path: string, expectedSize: number | null, actualSize: number | null) {
		const expected = expectedSize === null ? "missing" : `${expectedSize} bytes`;
		const actual = actualSize === null ? "missing" : `${actualSize} bytes`;
		super(`Session file changed before rewrite: ${path} (expected ${expected}, found ${actual}).`);
		this.name = "SessionStorageConflict";
		this.path = path;
		this.expectedSize = expectedSize;
		this.actualSize = actualSize;
	}
}

/**
 * Pluggable persistence layer for session JSONL files.
 *
 * The default implementation is the local filesystem backend, which
 * preserves pi's existing session file behavior byte for byte; the
 * in-memory backend implements the same contract for tests and
 * embedding. All primitives are synchronous because pi's session API
 * is synchronous; readLinesAsync serves the asynchronous session
 * listing APIs, whose abort-during-read semantics require real I/O.
 */
export interface SessionStorageBackend {
	/** Ensure a session directory exists. */
	init(dir: string): void;
	/**
	 * List the session files (`.jsonl`) directly inside `dir` with
	 * their size and mtime for discovery ordering. Filesystem
	 * backends throw when the directory cannot be read; backends
	 * without a directory concept list every stored path below
	 * `dir`.
	 */
	loadIndex(dir: string): Iterable<SessionStorageIndexEntry>;
	/** Read a session file's full text, or null when it does not exist. */
	readFull(path: string): string | null;
	/**
	 * Read the UTF-8 text windows of `prefixBytes` from the head and
	 * `suffixBytes` from the tail of a file. A window that splits a
	 * multi-byte character yields replacement characters. Throws when
	 * the file does not exist.
	 */
	readSlices(path: string, prefixBytes: number, suffixBytes: number): [string, string];
	/**
	 * Scan a session file's lines without materializing the whole
	 * file. Lines are delivered without their trailing newline; a
	 * throw from `onLine` aborts the scan and propagates. Returns
	 * null when the file does not exist.
	 */
	readLines(path: string, onLine: (line: string) => void): SessionLineScanResult | null;
	/**
	 * Asynchronous line scan for the session listing APIs. The signal
	 * aborts the scan mid-read, which the synchronous readLines cannot
	 * express. Returns null when the file does not exist.
	 */
	readLinesAsync(
		path: string,
		onLine: (line: string) => void,
		signal?: AbortSignal,
	): Promise<SessionLineScanResult | null>;
	/**
	 * Replace a file's content. `content` is either full file text or
	 * lines that each include their trailing newline. When `expectedSize`
	 * is a number, the write is rejected with SessionStorageConflict
	 * unless the file's current UTF-8 byte length matches; `null`
	 * requires the file not to exist (exclusive create); `undefined`
	 * writes unconditionally.
	 */
	writeFull(path: string, content: string | Iterable<string>, mtimeMs: number, expectedSize?: number | null): void;
	/** Append one line, which MUST include its trailing newline. */
	append(path: string, line: string, mtimeMs: number): void;
	/** Empty a file's content, creating the file when it is missing. */
	truncate(path: string, mtimeMs: number): void;
	/** Delete files; missing paths are ignored. */
	remove(paths: string[]): void;
	/** Rename a file onto `dst`, overwriting it when it exists. */
	move(src: string, dst: string, mtimeMs: number): void;
	/** Size and mtime of a single session file; throws when missing. */
	stat(path: string): SessionStorageStat;
}

function isErrnoError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function storageEntryNotFound(path: string): Error {
	return Object.assign(new Error(`Session storage entry not found: ${path}`), { code: "ENOENT" });
}

function currentSizeOrNull(path: string): number | null {
	try {
		return statSync(path).size;
	} catch (error) {
		if (!isErrnoError(error, "ENOENT")) {
			throw error;
		}
		return null;
	}
}

/**
 * Local filesystem backend. This is the default SessionStorageBackend
 * and preserves pi's existing session file behavior: session files are
 * created exclusively, appended line by line, and rewritten entry by
 * entry, with the caller-supplied mtime stamped onto the file.
 */
export class LocalSessionStorageBackend implements SessionStorageBackend {
	init(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	loadIndex(dir: string): SessionStorageIndexEntry[] {
		const entries: SessionStorageIndexEntry[] = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			const { size, mtimeMs } = statSync(path);
			entries.push({ path, size, mtimeMs });
		}
		return entries;
	}

	readFull(path: string): string | null {
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if (isErrnoError(error, "ENOENT")) {
				return null;
			}
			throw error;
		}
	}

	readSlices(path: string, prefixBytes: number, suffixBytes: number): [string, string] {
		const fd = openSync(path, "r");
		try {
			const { size } = fstatSync(fd);
			const prefix = this.#readWindow(fd, 0, Math.min(prefixBytes, size));
			const suffixStart = Math.max(0, size - suffixBytes);
			const suffix = this.#readWindow(fd, suffixStart, Math.min(suffixBytes, size));
			return [prefix, suffix];
		} finally {
			closeSync(fd);
		}
	}

	readLines(path: string, onLine: (line: string) => void): SessionLineScanResult | null {
		let fd: number;
		try {
			fd = openSync(path, "r");
		} catch (error) {
			if (isErrnoError(error, "ENOENT")) {
				return null;
			}
			throw error;
		}
		try {
			const decoder = new StringDecoder("utf8");
			const buffer = Buffer.allocUnsafe(LINE_READ_CHUNK);
			let pending = "";
			for (;;) {
				const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				pending += decoder.write(buffer.subarray(0, bytesRead));
				let lineStart = 0;
				let newlineIndex = pending.indexOf("\n", lineStart);
				while (newlineIndex !== -1) {
					onLine(pending.slice(lineStart, newlineIndex));
					lineStart = newlineIndex + 1;
					newlineIndex = pending.indexOf("\n", lineStart);
				}
				pending = pending.slice(lineStart);
			}
			pending += decoder.end();
			if (pending !== "") {
				onLine(pending);
				return { unterminatedFinalLine: true };
			}
			return { unterminatedFinalLine: false };
		} finally {
			closeSync(fd);
		}
	}

	async readLinesAsync(
		path: string,
		onLine: (line: string) => void,
		signal?: AbortSignal,
	): Promise<SessionLineScanResult | null> {
		try {
			const lines = createInterface({
				input: createReadStream(path, { encoding: "utf8", signal }),
				crlfDelay: Infinity,
			});
			for await (const line of lines) {
				onLine(line);
			}
		} catch (error) {
			if (isErrnoError(error, "ENOENT")) {
				return null;
			}
			throw error;
		}
		return { unterminatedFinalLine: this.#endsWithoutNewline(path) };
	}

	writeFull(path: string, content: string | Iterable<string>, mtimeMs: number, expectedSize?: number | null): void {
		if (expectedSize !== undefined) {
			const actualSize = currentSizeOrNull(path);
			if (actualSize !== expectedSize) {
				throw new SessionStorageConflict(path, expectedSize, actualSize);
			}
		}
		let fd: number;
		try {
			fd = expectedSize === null ? openSync(path, "wx") : openSync(path, "w");
		} catch (error) {
			if (expectedSize === null && isErrnoError(error, "EEXIST")) {
				throw new SessionStorageConflict(path, null, currentSizeOrNull(path));
			}
			throw error;
		}
		try {
			if (typeof content === "string") {
				writeFileSync(fd, content);
			} else {
				for (const line of content) {
					writeFileSync(fd, line);
				}
			}
		} finally {
			closeSync(fd);
		}
		this.#stampMtime(path, mtimeMs);
	}

	append(path: string, line: string, mtimeMs: number): void {
		appendFileSync(path, line);
		this.#stampMtime(path, mtimeMs);
	}

	truncate(path: string, mtimeMs: number): void {
		// Opening with "w" truncates the file to zero bytes while keeping it.
		const fd = openSync(path, "w");
		try {
			closeSync(fd);
		} finally {
			this.#stampMtime(path, mtimeMs);
		}
	}

	remove(paths: string[]): void {
		for (const path of paths) {
			rmSync(path, { force: true });
		}
	}

	move(src: string, dst: string, mtimeMs: number): void {
		renameSync(src, dst);
		this.#stampMtime(dst, mtimeMs);
	}

	stat(path: string): SessionStorageStat {
		const { size, mtimeMs } = statSync(path);
		return { size, mtimeMs };
	}

	#readWindow(fd: number, offset: number, count: number): string {
		if (count <= 0) {
			return "";
		}
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(Math.min(count, SLICE_READ_CHUNK));
		let text = "";
		let position = offset;
		let remaining = count;
		while (remaining > 0) {
			const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), position);
			if (bytesRead === 0) break;
			position += bytesRead;
			remaining -= bytesRead;
			text += decoder.write(buffer.subarray(0, bytesRead));
		}
		return text + decoder.end();
	}

	#endsWithoutNewline(path: string): boolean {
		try {
			const fd = openSync(path, "r");
			try {
				const { size } = fstatSync(fd);
				if (size === 0) {
					return false;
				}
				const buffer = Buffer.allocUnsafe(1);
				const bytesRead = readSync(fd, buffer, 0, 1, size - 1);
				return bytesRead === 1 && buffer[0] !== 0x0a;
			} finally {
				closeSync(fd);
			}
		} catch {
			return false;
		}
	}

	#stampMtime(path: string, mtimeMs: number): void {
		try {
			const time = new Date(mtimeMs);
			utimesSync(path, time, time);
		} catch {
			// The filesystem mtime remains the record when the stamp cannot be applied.
		}
	}
}

/**
 * In-memory backend. Session files live in a path-keyed map so the
 * same contract tests run against it as against the local filesystem
 * backend.
 */
export class InMemorySessionStorageBackend implements SessionStorageBackend {
	#files = new Map<string, { content: string; mtimeMs: number }>();

	init(_dir: string): void {
		// The in-memory namespace has no directories to create.
	}

	loadIndex(dir: string): SessionStorageIndexEntry[] {
		const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
		const entries: SessionStorageIndexEntry[] = [];
		for (const [path, entry] of this.#files) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\") || name.includes(sep)) continue;
			if (!name.endsWith(".jsonl")) continue;
			entries.push({ path, size: Buffer.byteLength(entry.content, "utf8"), mtimeMs: entry.mtimeMs });
		}
		return entries;
	}

	readFull(path: string): string | null {
		return this.#files.get(path)?.content ?? null;
	}

	readSlices(path: string, prefixBytes: number, suffixBytes: number): [string, string] {
		const entry = this.#require(path);
		const bytes = Buffer.from(entry.content, "utf8");
		const prefix = bytes.subarray(0, prefixBytes).toString("utf8");
		const suffixStart = Math.max(0, bytes.length - suffixBytes);
		const suffix = bytes.subarray(suffixStart).toString("utf8");
		return [prefix, suffix];
	}

	readLines(path: string, onLine: (line: string) => void): SessionLineScanResult | null {
		const entry = this.#files.get(path);
		if (!entry) {
			return null;
		}
		return { unterminatedFinalLine: this.#scanLines(entry.content, onLine) };
	}

	async readLinesAsync(
		path: string,
		onLine: (line: string) => void,
		signal?: AbortSignal,
	): Promise<SessionLineScanResult | null> {
		const entry = this.#files.get(path);
		if (!entry) {
			return null;
		}
		signal?.throwIfAborted();
		return { unterminatedFinalLine: this.#scanLines(entry.content, onLine, signal) };
	}

	writeFull(path: string, content: string | Iterable<string>, mtimeMs: number, expectedSize?: number | null): void {
		const existing = this.#files.get(path);
		const actualSize = existing ? Buffer.byteLength(existing.content, "utf8") : null;
		if (expectedSize !== undefined && actualSize !== expectedSize) {
			throw new SessionStorageConflict(path, expectedSize, actualSize);
		}
		this.#files.set(path, {
			content: typeof content === "string" ? content : Array.from(content).join(""),
			mtimeMs,
		});
	}

	append(path: string, line: string, mtimeMs: number): void {
		const entry = this.#files.get(path);
		if (entry) {
			entry.content += line;
			entry.mtimeMs = mtimeMs;
		} else {
			this.#files.set(path, { content: line, mtimeMs });
		}
	}

	truncate(path: string, mtimeMs: number): void {
		this.#files.set(path, { content: "", mtimeMs });
	}

	remove(paths: string[]): void {
		for (const path of paths) {
			this.#files.delete(path);
		}
	}

	move(src: string, dst: string, mtimeMs: number): void {
		const entry = this.#files.get(src);
		if (!entry) {
			throw storageEntryNotFound(src);
		}
		this.#files.delete(src);
		this.#files.set(dst, { content: entry.content, mtimeMs });
	}

	stat(path: string): SessionStorageStat {
		const entry = this.#files.get(path);
		if (!entry) {
			throw storageEntryNotFound(path);
		}
		return { size: Buffer.byteLength(entry.content, "utf8"), mtimeMs: entry.mtimeMs };
	}

	#require(path: string): { content: string; mtimeMs: number } {
		const entry = this.#files.get(path);
		if (!entry) {
			throw storageEntryNotFound(path);
		}
		return entry;
	}

	#scanLines(content: string, onLine: (line: string) => void, signal?: AbortSignal): boolean {
		if (content === "") {
			return false;
		}
		const lines = content.split("\n");
		if (content.endsWith("\n")) {
			lines.pop();
		}
		for (const line of lines) {
			signal?.throwIfAborted();
			onLine(line);
		}
		return !content.endsWith("\n");
	}
}

/** Default backend: pi's existing local filesystem session storage. */
export const defaultSessionStorageBackend: SessionStorageBackend = new LocalSessionStorageBackend();
