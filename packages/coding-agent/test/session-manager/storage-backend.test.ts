import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	InMemorySessionStorageBackend,
	LocalSessionStorageBackend,
	type SessionStorageBackend,
	SessionStorageConflict,
} from "../../src/core/session/storage-backend.ts";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

/**
 * Register the backend contract suite. Every assertion holds for every
 * SessionStorageBackend implementation, so the same tests run against the
 * local filesystem backend and the in-memory backend.
 */
function registerBackendContract(backend: () => SessionStorageBackend, sessionFile: (name: string) => string): void {
	it("init does not throw for new session directories", () => {
		expect(() => backend().init(sessionFile("dir"))).not.toThrow();
	});

	it("loadIndex lists session files with size and mtime, ignoring other files", () => {
		const storage = backend();
		const dir = sessionFile("index-dir");
		storage.init(dir);
		expect(Array.from(storage.loadIndex(dir))).toEqual([]);

		storage.writeFull(join(dir, "a.jsonl"), "a\n", 1000);
		storage.writeFull(join(dir, "b.jsonl"), "bb\n", 2000);
		storage.writeFull(join(dir, "notes.txt"), "ignored\n", 3000);

		const entries = Array.from(storage.loadIndex(dir)).sort((a, b) => a.path.localeCompare(b.path));
		expect(entries).toEqual([
			{ path: join(dir, "a.jsonl"), size: 2, mtimeMs: 1000 },
			{ path: join(dir, "b.jsonl"), size: 3, mtimeMs: 2000 },
		]);
	});

	it("readFull returns null for missing files and the written text otherwise", () => {
		const storage = backend();
		const path = sessionFile("full.jsonl");
		expect(storage.readFull(path)).toBeNull();
		storage.writeFull(path, "header\nentry\n", 1000);
		expect(storage.readFull(path)).toBe("header\nentry\n");
	});

	it("readSlices returns byte windows from the head and tail", () => {
		const storage = backend();
		const path = sessionFile("slices.jsonl");
		storage.writeFull(path, "0123456789", 1000);
		expect(storage.readSlices(path, 4, 3)).toEqual(["0123", "789"]);
		expect(storage.readSlices(path, 0, 0)).toEqual(["", ""]);
		expect(storage.readSlices(path, 100, 100)).toEqual(["0123456789", "0123456789"]);
	});

	it("readSlices windows are byte offsets that split multi-byte characters", () => {
		const storage = backend();
		const path = sessionFile("multibyte.jsonl");
		storage.writeFull(path, "éé", 1000);
		expect(storage.readSlices(path, 1, 0)).toEqual(["�", ""]);
		expect(storage.readSlices(path, 2, 0)).toEqual(["é", ""]);
	});

	it("writeFull replaces content unconditionally by default", () => {
		const storage = backend();
		const path = sessionFile("replace.jsonl");
		storage.writeFull(path, "first\n", 1000);
		storage.writeFull(path, "second\n", 2000);
		expect(storage.readFull(path)).toBe("second\n");
		expect(storage.stat(path)).toEqual({ size: 7, mtimeMs: 2000 });
	});

	it("writeFull accepts line iterables whose lines carry their trailing newline", () => {
		const storage = backend();
		const path = sessionFile("lines.jsonl");
		storage.writeFull(path, ["header\n", "entry\n"], 1000);
		expect(storage.readFull(path)).toBe("header\nentry\n");
	});

	it("writeFull creates files exclusively when expectedSize is null", () => {
		const storage = backend();
		const path = sessionFile("exclusive.jsonl");
		storage.writeFull(path, "created\n", 1000, null);
		expect(storage.readFull(path)).toBe("created\n");
		expect(() => storage.writeFull(path, "replaced\n", 2000, null)).toThrow(SessionStorageConflict);
		expect(storage.readFull(path)).toBe("created\n");
	});

	it("writeFull passes the CAS check when the UTF-8 byte size matches", () => {
		const storage = backend();
		const path = sessionFile("cas.jsonl");
		storage.writeFull(path, "12345\n", 1000);
		storage.writeFull(path, "abcdef\n", 2000, 6);
		expect(storage.readFull(path)).toBe("abcdef\n");
	});

	it("writeFull rejects a CAS write when the byte size differs", () => {
		const storage = backend();
		const path = sessionFile("conflict.jsonl");
		storage.writeFull(path, "12345\n", 1000);
		expect(() => storage.writeFull(path, "abcdef\n", 2000, 5)).toThrow(SessionStorageConflict);
		expect(storage.readFull(path)).toBe("12345\n");
	});

	it("writeFull rejects a CAS write against a missing file", () => {
		const storage = backend();
		const path = sessionFile("missing-cas.jsonl");
		let conflict: SessionStorageConflict | undefined;
		try {
			storage.writeFull(path, "content\n", 1000, 4);
		} catch (error) {
			conflict = error as SessionStorageConflict;
		}
		expect(conflict).toBeInstanceOf(SessionStorageConflict);
		expect(conflict!.path).toBe(path);
		expect(conflict!.expectedSize).toBe(4);
		expect(conflict!.actualSize).toBeNull();
	});

	it("append creates files and extends existing content", () => {
		const storage = backend();
		const path = sessionFile("append.jsonl");
		storage.append(path, "header\n", 1000);
		storage.append(path, "entry\n", 2000);
		expect(storage.readFull(path)).toBe("header\nentry\n");
		expect(storage.stat(path).mtimeMs).toBe(2000);
	});

	it("stat reports size and mtime and throws for missing files", () => {
		const storage = backend();
		const path = sessionFile("stat.jsonl");
		expect(() => storage.stat(path)).toThrow();
		storage.writeFull(path, "abc\n", 1000);
		expect(storage.stat(path)).toEqual({ size: 4, mtimeMs: 1000 });
	});

	it("truncate empties a file and keeps it listed", () => {
		const storage = backend();
		const dir = sessionFile("truncate-dir");
		storage.init(dir);
		const path = join(dir, "session.jsonl");
		storage.writeFull(path, "content\n", 1000);
		storage.truncate(path, 2000);
		expect(storage.readFull(path)).toBe("");
		expect(storage.stat(path)).toEqual({ size: 0, mtimeMs: 2000 });
		expect(Array.from(storage.loadIndex(dir))).toEqual([{ path, size: 0, mtimeMs: 2000 }]);
	});

	it("truncate creates an empty file when missing", () => {
		const storage = backend();
		const dir = sessionFile("truncate-new-dir");
		storage.init(dir);
		const path = join(dir, "new.jsonl");
		storage.truncate(path, 1000);
		expect(storage.stat(path)).toEqual({ size: 0, mtimeMs: 1000 });
	});

	it("remove deletes files and tolerates missing paths", () => {
		const storage = backend();
		const dir = sessionFile("remove-dir");
		storage.init(dir);
		const kept = join(dir, "kept.jsonl");
		const removed = join(dir, "removed.jsonl");
		storage.writeFull(kept, "kept\n", 1000);
		storage.writeFull(removed, "removed\n", 1000);
		storage.remove([removed, join(dir, "missing.jsonl")]);
		expect(storage.readFull(removed)).toBeNull();
		expect(storage.readFull(kept)).toBe("kept\n");
		expect(Array.from(storage.loadIndex(dir)).map((entry) => entry.path)).toEqual([kept]);
	});

	it("move renames a file onto the destination", () => {
		const storage = backend();
		const dir = sessionFile("move-dir");
		storage.init(dir);
		const src = join(dir, "src.jsonl");
		const dst = join(dir, "dst.jsonl");
		storage.writeFull(src, "content\n", 1000);
		storage.move(src, dst, 2000);
		expect(storage.readFull(src)).toBeNull();
		expect(storage.readFull(dst)).toBe("content\n");
		expect(storage.stat(dst)).toEqual({ size: 8, mtimeMs: 2000 });
	});

	it("move overwrites an existing destination", () => {
		const storage = backend();
		const dir = sessionFile("move-overwrite-dir");
		storage.init(dir);
		const src = join(dir, "src.jsonl");
		const dst = join(dir, "dst.jsonl");
		storage.writeFull(src, "from src\n", 1000);
		storage.writeFull(dst, "from dst\n", 1000);
		storage.move(src, dst, 2000);
		expect(storage.readFull(dst)).toBe("from src\n");
		expect(() => storage.stat(src)).toThrow();
	});

	it("readLines delivers lines without newlines and flags a terminated final line", () => {
		const storage = backend();
		const path = sessionFile("lines.jsonl");
		expect(storage.readLines(path, () => {})).toBeNull();
		storage.writeFull(path, "a\nb\n", 1000);
		const lines: string[] = [];
		const scan = storage.readLines(path, (line) => lines.push(line));
		expect(lines).toEqual(["a", "b"]);
		expect(scan).toEqual({ unterminatedFinalLine: false });
	});

	it("readLines delivers a final unterminated line", () => {
		const storage = backend();
		const path = sessionFile("unterminated.jsonl");
		storage.writeFull(path, "a\nb", 1000);
		const lines: string[] = [];
		const scan = storage.readLines(path, (line) => lines.push(line));
		expect(lines).toEqual(["a", "b"]);
		expect(scan).toEqual({ unterminatedFinalLine: true });
	});

	it("readLines aborts the scan when the callback throws", () => {
		const storage = backend();
		const path = sessionFile("abort.jsonl");
		storage.writeFull(path, "a\nb\nc\n", 1000);
		const lines: string[] = [];
		expect(() =>
			storage.readLines(path, (line) => {
				lines.push(line);
				throw new Error("stop");
			}),
		).toThrow("stop");
		expect(lines).toEqual(["a"]);
	});

	it("readLinesAsync delivers the same lines and returns null for missing files", async () => {
		const storage = backend();
		const path = sessionFile("async-lines.jsonl");
		await expect(storage.readLinesAsync(path, () => {})).resolves.toBeNull();
		storage.writeFull(path, "a\nb\n", 1000);
		const lines: string[] = [];
		const scan = await storage.readLinesAsync(path, (line) => lines.push(line));
		expect(lines).toEqual(["a", "b"]);
		expect(scan).toEqual({ unterminatedFinalLine: false });
	});

	it("readLinesAsync rejects with an abort error when the signal is already aborted", async () => {
		const storage = backend();
		const path = sessionFile("async-abort.jsonl");
		storage.writeFull(path, "a\nb\n", 1000);
		const controller = new AbortController();
		controller.abort();
		await expect(storage.readLinesAsync(path, () => {}, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
}

describe("SessionStorageBackend contract (local filesystem)", () => {
	let tempDir: string;
	let storage: SessionStorageBackend;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-storage-contract-"));
		storage = new LocalSessionStorageBackend();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	registerBackendContract(
		() => storage,
		(name) => join(tempDir, name),
	);
});

describe("SessionStorageBackend contract (in-memory)", () => {
	let storage: SessionStorageBackend;

	beforeEach(() => {
		storage = new InMemorySessionStorageBackend();
	});

	registerBackendContract(
		() => storage,
		(name) => join("/virtual/sessions", name),
	);
});

describe("SessionStorageBackend default backend parity", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-storage-parity-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("SessionManager persists the exact JSONL records through the default backend", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		session.appendMessage(userMsg("hello"));

		const sessionFile = session.getSessionFile()!;
		const lines = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line !== "");
		expect(lines).toHaveLength(3);

		const header = JSON.parse(lines[0]!);
		expect(header).toMatchObject({
			type: "session",
			version: 3,
			id: session.getSessionId(),
			cwd: tempDir,
		});
		expect(JSON.parse(lines[1]!)).toMatchObject({
			type: "model_change",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		expect(JSON.parse(lines[2]!)).toMatchObject({
			type: "message",
			message: { role: "user", content: "hello" },
		});
	});

	it("loadEntriesFromFile repairs an unterminated final record with a newline byte", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg("hello"));
		const sessionFile = session.getSessionFile()!;

		// Strip the trailing newline to simulate an unterminated final record.
		const content = readFileSync(sessionFile, "utf8");
		writeFileSync(sessionFile, content.slice(0, -1));

		const entries = loadEntriesFromFile(sessionFile);
		expect(entries).toHaveLength(2);
		expect(readFileSync(sessionFile, "utf8")).toBe(content);
	});

	it("appended records preserve earlier records byte for byte", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg("first"));
		const sessionFile = session.getSessionFile()!;
		const before = readFileSync(sessionFile, "utf8");

		session.appendMessage(userMsg("second"));

		const after = readFileSync(sessionFile, "utf8");
		expect(after.startsWith(before)).toBe(true);
		const appended = after.slice(before.length);
		const appendedEntry = JSON.parse(appended);
		expect(appendedEntry.type).toBe("message");
		expect(appendedEntry.message.content).toBe("second");
		expect(appended.endsWith("\n")).toBe(true);
	});

	it("a session directory is created on demand for the default session dir", () => {
		const sessionDir = join(tempDir, "nested", "sessions");
		expect(existsSync(sessionDir)).toBe(false);
		const session = SessionManager.create(tempDir, sessionDir);
		session.appendMessage(userMsg("hello"));
		expect(existsSync(sessionDir)).toBe(true);
		expect(session.getSessionFile()).toBeDefined();
	});
});
