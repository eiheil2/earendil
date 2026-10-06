import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DshAppendOnlySessionStorageBackend,
	DshAppendOnlyViolation,
} from "../../src/core/session/dsh-append-only-backend.ts";
import {
	assertSessionHeaderLineage,
	DSH_SESSION_FORMAT_VERSION,
	DshSessionLogRefusedError,
	decodeDshHeaderLine,
	decodeDshSessionLog,
	decodeDshStoredText,
	encodeDshEventRow,
	encodeDshHeaderLine,
	encodeDshSessionLog,
	isDshHeaderLine,
	isDshSessionLog,
	isKnownEntryType,
	KNOWN_ENTRY_TYPES,
} from "../../src/core/session/dsh-session-log.ts";
import {
	defaultSessionStorageBackend,
	getSessionStorageBackend,
	LocalSessionStorageBackend,
	resetSessionStorageBackend,
	SessionStorageConflict,
	setSessionStorageBackend,
} from "../../src/core/session/storage-backend.ts";
import {
	findMostRecentSession,
	loadEntriesFromFile,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const TS = "2025-01-01T00:00:00.000Z";

/** A pi session header exactly as SessionManager.newSession() serializes it. */
function piHeader(): SessionHeader {
	return { type: "session", version: 3, id: "pi-session", timestamp: TS, cwd: "/tmp/project" };
}

/** The same header carrying every DSH lineage field. */
function lineageHeader(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "pi-session",
		timestamp: TS,
		cwd: "/tmp/project",
		parentSession: "/tmp/parent.jsonl",
		isSeeded: true,
		origin: "subagent",
		delegationDepth: 2,
		agentPreset: "plan",
	};
}

/** One sample of every SessionEntry union member, in union order. */
function sampleEntries(): SessionEntry[] {
	const usage = {
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 19,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return [
		// Fixed message timestamp: sampleEntries() must be byte-stable across calls.
		{
			type: "message",
			id: "e01",
			parentId: null,
			timestamp: TS,
			message: { role: "user", content: "hello", timestamp: 1700000000000 },
		},
		{ type: "thinking_level_change", id: "e02", parentId: "e01", timestamp: TS, thinkingLevel: "high" },
		{
			type: "model_change",
			id: "e03",
			parentId: "e02",
			timestamp: TS,
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		},
		{
			type: "usage",
			id: "e04",
			parentId: "e03",
			timestamp: TS,
			kind: "cache_warm",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
		},
		{
			type: "compaction",
			id: "e05",
			parentId: "e04",
			timestamp: TS,
			summary: "summary",
			firstKeptEntryId: "e01",
			tokensBefore: 1000,
		},
		{ type: "branch_summary", id: "e06", parentId: "e05", timestamp: TS, fromId: "e01", summary: "branch" },
		{ type: "custom", id: "e07", parentId: "e06", timestamp: TS, customType: "state", data: { plan: true } },
		{
			type: "custom_message",
			id: "e08",
			parentId: "e07",
			timestamp: TS,
			customType: "note",
			content: "note text",
			display: false,
		},
		{
			type: "context_edit",
			id: "e09",
			parentId: "e08",
			timestamp: TS,
			targetId: "e01",
			replacement: { content: "edited" },
		},
		{ type: "label", id: "e10", parentId: "e09", timestamp: TS, targetId: "e01", label: "marked" },
		{ type: "session_info", id: "e11", parentId: "e10", timestamp: TS, name: "named session" },
	];
}

/** One more entry used when appending to an already stored log. */
function extraEntry(): SessionEntry {
	return { type: "session_info", id: "e12", parentId: "e11", timestamp: TS, name: "appended" };
}

/** A stored row as this backend writes it: fixed envelope keys, dense seq. */
function row(entry: SessionEntry, seq: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ type: entry.type, seq, time: Date.parse(entry.timestamp), data: entry, ...extra });
}

function parseLines(text: string): Record<string, unknown>[] {
	return text
		.trimEnd()
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

describe("session format v4 codec", () => {
	it("round-trips a header with full lineage plus every entry type losslessly", () => {
		const header = lineageHeader();
		const entries = sampleEntries();

		const log = encodeDshSessionLog(header, entries);

		expect(decodeDshSessionLog(log)).toEqual([header, ...entries]);
	});

	it("re-encodes a decoded log to identical bytes", () => {
		const header = lineageHeader();
		const entries = sampleEntries();
		const log = encodeDshSessionLog(header, entries);

		const decoded = decodeDshSessionLog(log);
		const reencoded = encodeDshSessionLog(decoded[0] as SessionHeader, decoded.slice(1) as SessionEntry[]);

		expect(reencoded).toBe(log);
	});

	it("samples every entry type the session union knows about", () => {
		expect(Object.keys(KNOWN_ENTRY_TYPES).sort()).toEqual(
			sampleEntries()
				.map((entry) => entry.type)
				.sort(),
		);
		expect(isKnownEntryType("message")).toBe(true);
		expect(isKnownEntryType("future_entry")).toBe(false);
	});

	it("writes the DSH header first with the fixed key order and piVersion lineage", () => {
		const log = encodeDshSessionLog(lineageHeader(), sampleEntries());
		const lines = log.trimEnd().split("\n");
		const storedHeader = JSON.parse(lines[0]);

		expect(Object.keys(storedHeader)).toEqual([
			"type",
			"version",
			"id",
			"createdAt",
			"timestamp",
			"piVersion",
			"cwd",
			"parentSession",
			"isSeeded",
			"origin",
			"delegationDepth",
			"agentPreset",
		]);
		expect(storedHeader).toMatchObject({
			type: "session",
			version: DSH_SESSION_FORMAT_VERSION,
			id: "pi-session",
			createdAt: Date.parse(TS),
			timestamp: TS,
			piVersion: 3,
			isSeeded: true,
			origin: "subagent",
			delegationDepth: 2,
			agentPreset: "plan",
		});
		expect(isDshHeaderLine(lines[0])).toBe(true);
		expect(isDshSessionLog(log)).toBe(true);
		expect(decodeDshHeaderLine(lines[0])).toMatchObject({ type: "session", version: 3, id: "pi-session" });
	});

	it("writes one dense row per entry with the DSH envelope keys", () => {
		const entries = sampleEntries();
		const rows = parseLines(encodeDshSessionLog(piHeader(), entries)).slice(1);

		expect(rows).toHaveLength(entries.length);
		rows.forEach((storedRow, index) => {
			expect(Object.keys(storedRow)).toEqual(["type", "seq", "time", "data"]);
			expect(storedRow.seq).toBe(index);
			expect(storedRow.time).toBe(Date.parse(TS));
			expect(storedRow.data).toEqual(entries[index]);
		});
	});

	it("leaves lineage fields out when the pi header does not carry them", () => {
		const storedHeader = JSON.parse(encodeDshHeaderLine(piHeader()));

		expect(storedHeader).toEqual({
			type: "session",
			version: DSH_SESSION_FORMAT_VERSION,
			id: "pi-session",
			createdAt: Date.parse(TS),
			timestamp: TS,
			piVersion: 3,
			cwd: "/tmp/project",
		});
	});

	it("decodes a DSH-authored header without pi fields", () => {
		const line = JSON.stringify({
			type: "session",
			version: 4,
			id: "dsh-session",
			createdAt: Date.parse(TS),
			isSeeded: false,
			delegationDepth: 0,
		});

		expect(decodeDshHeaderLine(line)).toEqual({
			type: "session",
			version: 4,
			id: "dsh-session",
			timestamp: new Date(Date.parse(TS)).toISOString(),
			cwd: "",
			parentSession: undefined,
			isSeeded: false,
			origin: undefined,
			delegationDepth: 0,
			agentPreset: undefined,
		});
	});

	it("does not mistake a pi header at version 4 for a stored log", () => {
		const piV4Header = JSON.stringify({ type: "session", version: 4, id: "x", timestamp: TS, cwd: "/tmp" });

		expect(isDshHeaderLine(piV4Header)).toBe(false);
		expect(isDshSessionLog(`${piV4Header}\n`)).toBe(false);
	});

	it("refuses content that is not a session format v4 log", () => {
		const piText = [piHeader(), ...sampleEntries()].map((entry) => `${JSON.stringify(entry)}\n`).join("");

		expect(() => decodeDshStoredText(piText)).toThrow(DshSessionLogRefusedError);
	});

	it("rejects header lineage outside DSH's contract", () => {
		expect(() => assertSessionHeaderLineage({ ...lineageHeader(), origin: "peer" as "subagent" })).toThrow(
			'origin must be "subagent"',
		);
		expect(() => assertSessionHeaderLineage({ ...lineageHeader(), isSeeded: "yes" as unknown as boolean })).toThrow(
			"isSeeded must be a boolean",
		);
		expect(() => assertSessionHeaderLineage({ ...lineageHeader(), delegationDepth: -1 })).toThrow(
			"delegationDepth must be a non-negative safe integer",
		);
		expect(() => assertSessionHeaderLineage({ ...lineageHeader(), delegationDepth: 1.5 })).toThrow(
			"delegationDepth must be a non-negative safe integer",
		);
		expect(() => assertSessionHeaderLineage({ ...lineageHeader(), parentSession: 7 as unknown as string })).toThrow(
			"parentSession must be a string",
		);
		expect(() => assertSessionHeaderLineage({ ...lineageHeader(), agentPreset: 7 as unknown as string })).toThrow(
			"agentPreset must be a string",
		);
	});
});

describe("session format v4 row guard", () => {
	const header = piHeader();
	const headerLine = encodeDshHeaderLine(header);
	const [first, second] = sampleEntries();

	function log(...rows: string[]): string {
		return `${headerLine}\n${rows.map((entry) => `${entry}\n`).join("")}`;
	}

	it("refuses an unknown entry type that is not marked ignorable", () => {
		const futureRow = JSON.stringify({
			type: "future_entry",
			seq: 1,
			time: 0,
			data: { type: "future_entry", id: "f1", parentId: null, timestamp: TS },
		});

		expect(() => decodeDshStoredText(log(row(first, 0), futureRow))).toThrow(DshSessionLogRefusedError);
		expect(() => decodeDshStoredText(log(row(first, 0), futureRow))).toThrow("ignorable:true");
	});

	it("drops an ignorable unknown entry while still consuming its seq", () => {
		const futureRow = JSON.stringify({
			type: "future_entry",
			seq: 0,
			time: 0,
			data: { type: "future_entry", id: "f1", parentId: null, timestamp: TS },
			ignorable: true,
		});

		expect(decodeDshSessionLog(log(futureRow, row(second, 1)))).toEqual([header, second]);
	});

	it("refuses a seq gap", () => {
		expect(() => decodeDshStoredText(log(row(first, 0), row(second, 2)))).toThrow(DshSessionLogRefusedError);
		expect(() => decodeDshStoredText(log(row(first, 0), row(second, 2)))).toThrow("not dense");
	});

	it("refuses an unexpected row field", () => {
		expect(() => decodeDshStoredText(log(row(first, 0, { source: "somewhere" })))).toThrow("unexpected field");
	});

	it("refuses a non-true ignorable flag", () => {
		expect(() => decodeDshStoredText(log(row(first, 0, { ignorable: "true" })))).toThrow("ignorable must be true");
	});

	it("refuses a payload that does not match the row type", () => {
		const mismatched = JSON.stringify({ type: "message", seq: 0, time: 0, data: second });

		expect(() => decodeDshStoredText(log(mismatched))).toThrow("does not carry a message entry payload");
	});

	it("refuses a row missing a required envelope field", () => {
		const missingData = JSON.stringify({ type: "message", seq: 0, time: 0 });

		expect(() => decodeDshStoredText(log(missingData))).toThrow("lacks required field");
	});

	it("skips a malformed row and keeps the sequence dense", () => {
		expect(decodeDshSessionLog(log("not json at all", row(second, 1)))).toEqual([header, second]);
	});

	it("ignores blank lines without shifting the sequence", () => {
		expect(decodeDshSessionLog(`${headerLine}\n\n${row(first, 0)}\n`)).toEqual([header, first]);
	});

	it("refuses to write an entry type this build does not know", () => {
		const futureEntry = {
			type: "future_entry",
			id: "f1",
			parentId: null,
			timestamp: TS,
		} as unknown as SessionEntry;

		expect(() => encodeDshEventRow(futureEntry, 0)).toThrow(DshSessionLogRefusedError);
		expect(() => encodeDshEventRow(first, -1)).toThrow(DshSessionLogRefusedError);
	});
});

describe("DshAppendOnlySessionStorageBackend", () => {
	let tempDir: string;
	let adapter: DshAppendOnlySessionStorageBackend;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-dsh-backend-"));
		adapter = new DshAppendOnlySessionStorageBackend();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Write a pi-format session file through pi's own writer shape. */
	function writePiFile(name: string): string {
		const file = join(tempDir, name);
		const text = [piHeader(), ...sampleEntries()].map((entry) => `${JSON.stringify(entry)}\n`).join("");
		writeFileSync(file, text);
		return file;
	}

	/** Append one entry to a pi-format file so the backend converts it to a stored log. */
	function convertToDsh(name: string): { file: string; piText: string } {
		const file = writePiFile(name);
		const piText = readFileSync(file, "utf8");
		adapter.append(file, `${JSON.stringify(extraEntry())}\n`, Date.now());
		expect(isDshSessionLog(readFileSync(file, "utf8"))).toBe(true);
		return { file, piText };
	}

	it("reads a pi-format file through unchanged", () => {
		const file = writePiFile("pi.jsonl");
		const piText = readFileSync(file, "utf8");
		const lines: string[] = [];

		expect(adapter.readFull(file)).toBe(piText);
		const scan = adapter.readLines(file, (line) => lines.push(line));
		expect(lines).toEqual(piText.trimEnd().split("\n"));
		expect(scan).toEqual({ unterminatedFinalLine: false });
		expect(adapter.readSlices(file, 40, 40)).toEqual(new LocalSessionStorageBackend().readSlices(file, 40, 40));
	});

	it("reads a stored log as byte windows of the projected pi text", () => {
		const { file } = convertToDsh("slices.jsonl");
		const projected = adapter.readFull(file)!;
		const bytes = Buffer.from(projected, "utf8");

		expect(isDshSessionLog(readFileSync(file, "utf8"))).toBe(true);
		expect(adapter.readSlices(file, 40, 40)).toEqual([
			bytes.subarray(0, 40).toString("utf8"),
			bytes.subarray(bytes.length - 40).toString("utf8"),
		]);
	});

	it("converts a pi-format file on append and reads back byte for byte", () => {
		const { file, piText } = convertToDsh("convert.jsonl");
		const appended = `${piText}${JSON.stringify(extraEntry())}\n`;

		expect(adapter.readFull(file)).toBe(appended);
		expect(decodeDshSessionLog(readFileSync(file, "utf8"))).toEqual([piHeader(), ...sampleEntries(), extraEntry()]);
	});

	it("appends one dense row to a stored log without rewriting earlier rows", () => {
		const file = join(tempDir, "stored.jsonl");
		const piText = [piHeader(), ...sampleEntries()].map((entry) => `${JSON.stringify(entry)}\n`).join("");
		writeFileSync(file, encodeDshSessionLog(piHeader(), sampleEntries()));
		const before = readFileSync(file, "utf8");
		const nextSeq = parseLines(before).length - 1;
		const entry = extraEntry();

		adapter.append(file, `${JSON.stringify(entry)}\n`, Date.now());

		const after = readFileSync(file, "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(parseLines(after.slice(before.length))).toEqual([
			{ type: "session_info", seq: nextSeq, time: Date.parse(TS), data: entry },
		]);
		expect(adapter.readFull(file)).toBe(`${piText}${JSON.stringify(entry)}\n`);
	});

	it("creates a stored log only from a session header line", () => {
		const file = join(tempDir, "created.jsonl");
		const header = piHeader();

		expect(() => adapter.append(file, `${JSON.stringify(header)}\n`, Date.now())).toThrow(DshSessionLogRefusedError);
		expect(existsSync(file)).toBe(false);

		adapter.append(file, `${encodeDshHeaderLine(header)}\n`, Date.now());
		expect(isDshSessionLog(readFileSync(file, "utf8"))).toBe(true);
	});

	it("repairs an unterminated final row with a bare newline", () => {
		const { file, piText } = convertToDsh("repair.jsonl");
		const stored = readFileSync(file, "utf8");
		writeFileSync(file, stored.slice(0, -1));

		const lines: string[] = [];
		expect(adapter.readLines(file, (line) => lines.push(line))).toEqual({ unterminatedFinalLine: true });
		expect(adapter.readFull(file)).toBe(`${piText}${JSON.stringify(extraEntry())}\n`);

		adapter.append(file, "\n", Date.now());
		expect(readFileSync(file, "utf8")).toBe(stored);
	});

	it("refuses a writeFull that would replace a stored log", () => {
		const { file } = convertToDsh("replace.jsonl");
		const stored = readFileSync(file, "utf8");
		const otherSession = `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: TS, cwd: "/x" })}\n`;

		expect(() => adapter.writeFull(file, otherSession, Date.now())).toThrow(DshAppendOnlyViolation);
		expect(readFileSync(file, "utf8")).toBe(stored);
	});

	it("extends a stored log through writeFull when the bytes are a prefix", () => {
		const { file, piText } = convertToDsh("extend.jsonl");
		const stored = readFileSync(file, "utf8");
		const entry = { type: "label", id: "e13", parentId: "e12", timestamp: TS, targetId: "e01", label: "later" };
		const extended = `${piText}${JSON.stringify(extraEntry())}\n${JSON.stringify(entry)}\n`;

		adapter.writeFull(file, extended, Date.now(), Buffer.byteLength(stored, "utf8"));

		const after = readFileSync(file, "utf8");
		expect(after.startsWith(stored)).toBe(true);
		expect(adapter.readFull(file)).toBe(extended);
		expect(
			parseLines(after)
				.slice(1)
				.map((storedRow) => storedRow.seq),
		).toEqual([...Array(13).keys()]);
	});

	it("rejects a conditional write whose size does not match the stored log", () => {
		const { file } = convertToDsh("cas.jsonl");
		const stored = readFileSync(file, "utf8");
		const extended = `${adapter.readFull(file)}${JSON.stringify(extraEntry())}\n`;

		expect(() => adapter.writeFull(file, extended, Date.now(), 5)).toThrow(SessionStorageConflict);
		expect(readFileSync(file, "utf8")).toBe(stored);
	});

	it("refuses text without a header, with two headers, or with malformed JSON", () => {
		const entry = extraEntry();
		const header = piHeader();

		expect(() =>
			adapter.writeFull(join(tempDir, "no-header.jsonl"), `${JSON.stringify(entry)}\n`, Date.now()),
		).toThrow("no session header line");
		expect(() =>
			adapter.writeFull(
				join(tempDir, "two-headers.jsonl"),
				`${JSON.stringify(header)}\n${JSON.stringify(header)}\n`,
				Date.now(),
			),
		).toThrow("more than one session header");
		expect(() =>
			adapter.writeFull(join(tempDir, "malformed.jsonl"), `${JSON.stringify(header)}\nnot json\n`, Date.now()),
		).toThrow("not valid JSON");
		expect(existsSync(join(tempDir, "no-header.jsonl"))).toBe(false);
	});

	it("refuses to write an entry type outside the known set", () => {
		const futureEntry = { type: "future_entry", id: "f1", parentId: null, timestamp: TS };
		const text = `${JSON.stringify(piHeader())}\n${JSON.stringify(futureEntry)}\n`;

		expect(() => adapter.writeFull(join(tempDir, "future.jsonl"), text, Date.now())).toThrow(
			DshSessionLogRefusedError,
		);
		expect(existsSync(join(tempDir, "future.jsonl"))).toBe(false);
	});

	it("refuses to truncate a stored log", () => {
		const { file } = convertToDsh("truncate.jsonl");
		const stored = readFileSync(file, "utf8");

		expect(() => adapter.truncate(file, Date.now())).toThrow(DshAppendOnlyViolation);
		expect(readFileSync(file, "utf8")).toBe(stored);
	});

	it("throws from readSlices when the file is missing", () => {
		expect(() => adapter.readSlices(join(tempDir, "missing.jsonl"), 4, 4)).toThrow();
	});

	it("writes blank text as-is", () => {
		const file = join(tempDir, "blank.jsonl");
		adapter.writeFull(file, "", Date.now());

		expect(readFileSync(file, "utf8")).toBe("");
		expect(adapter.readFull(file)).toBe("");
	});

	it("delegates init, loadIndex, stat, move and remove to the wrapped backend", () => {
		const { file } = convertToDsh("delegate.jsonl");
		const stored = readFileSync(file, "utf8");
		const dir = join(tempDir, "nested");
		adapter.init(dir);
		expect(existsSync(dir)).toBe(true);

		expect(Array.from(adapter.loadIndex(tempDir)).map((entry) => entry.path)).toEqual([file]);
		expect(adapter.stat(file)).toMatchObject({ size: Buffer.byteLength(stored, "utf8") });

		const moved = join(tempDir, "moved.jsonl");
		adapter.move(file, moved, Date.now());
		expect(readFileSync(moved, "utf8")).toBe(stored);
		expect(adapter.readFull(file)).toBeNull();

		adapter.remove([moved]);
		expect(adapter.readFull(moved)).toBeNull();
	});
});

describe("SessionManager through the append-only backend", () => {
	let tempDir: string;
	let projectCwd: string;
	let adapter: DshAppendOnlySessionStorageBackend;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-dsh-session-"));
		projectCwd = join(tempDir, "project");
		mkdirSync(projectCwd, { recursive: true });
		adapter = new DshAppendOnlySessionStorageBackend();
		setSessionStorageBackend(adapter);
	});

	afterEach(() => {
		resetSessionStorageBackend();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores a session as a v4 log and reopens it losslessly", () => {
		const session = SessionManager.create(projectCwd, tempDir, {
			isSeeded: false,
			origin: "subagent",
			delegationDepth: 1,
			agentPreset: "plan",
		});
		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		session.appendMessage(userMsg("first question"));
		session.appendMessage(assistantMsg("first answer"));
		session.appendSessionInfo("dsh session");
		const file = session.getSessionFile()!;

		const stored = readFileSync(file, "utf8");
		expect(isDshSessionLog(stored)).toBe(true);

		const lines = parseLines(stored);
		expect(lines[0]).toMatchObject({
			type: "session",
			version: DSH_SESSION_FORMAT_VERSION,
			piVersion: 3,
			id: session.getSessionId(),
			cwd: projectCwd,
			isSeeded: false,
			origin: "subagent",
			delegationDepth: 1,
			agentPreset: "plan",
		});
		expect(lines.slice(1).map((storedRow) => storedRow.seq)).toEqual([0, 1, 2, 3]);
		expect(lines.slice(1).map((storedRow) => storedRow.type)).toEqual([
			"model_change",
			"message",
			"message",
			"session_info",
		]);
		lines.slice(1).forEach((storedRow) => {
			expect(Object.keys(storedRow)).toEqual(["type", "seq", "time", "data"]);
			expect((storedRow.data as SessionEntry).type).toBe(storedRow.type);
		});

		const expected = [session.getHeader(), ...session.getEntries()];
		expect(loadEntriesFromFile(file)).toEqual(expected);
		expect(
			adapter
				.readFull(file)!
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual(expected);

		const reopened = SessionManager.open(file, tempDir);
		expect(reopened.getSessionId()).toBe(session.getSessionId());
		expect(reopened.getHeader()).toEqual(session.getHeader());
		expect(reopened.getEntries()).toEqual(session.getEntries());
		expect(reopened.buildSessionContext().messages).toEqual(session.buildSessionContext().messages);
	});

	it("keeps appending dense rows without rewriting earlier ones", () => {
		const session = SessionManager.create(projectCwd, tempDir);
		session.appendMessage(userMsg("first question"));
		const file = session.getSessionFile()!;
		const before = readFileSync(file, "utf8");
		const nextSeq = parseLines(before).length - 1;

		session.appendMessage(assistantMsg("first answer"));
		session.appendMessage(userMsg("second question"));

		const after = readFileSync(file, "utf8");
		expect(after.startsWith(before)).toBe(true);
		expect(parseLines(after.slice(before.length)).map((storedRow) => storedRow.seq)).toEqual([nextSeq, nextSeq + 1]);

		const reopened = SessionManager.open(file, tempDir);
		expect(reopened.getEntries()).toEqual(session.getEntries());
	});

	it("finds, lists and continues a stored log like any pi session", async () => {
		const session = SessionManager.create(projectCwd, tempDir);
		session.appendMessage(userMsg("first question"));
		session.appendMessage(assistantMsg("first answer"));
		session.appendSessionInfo("dsh session");
		const file = session.getSessionFile()!;

		expect(findMostRecentSession(tempDir, projectCwd)).toBe(file);

		const listed = await SessionManager.list(projectCwd, tempDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			path: file,
			id: session.getSessionId(),
			cwd: projectCwd,
			name: "dsh session",
			messageCount: 2,
		});

		const continued = SessionManager.continueRecent(projectCwd, tempDir);
		expect(continued.getSessionFile()).toBe(file);
		expect(continued.getEntries()).toEqual(session.getEntries());
	});

	it("converts a session written by pi's default backend on the next append", () => {
		resetSessionStorageBackend();
		const session = SessionManager.create(projectCwd, tempDir);
		session.appendMessage(userMsg("legacy question"));
		const file = session.getSessionFile()!;
		const piText = readFileSync(file, "utf8");
		expect(isDshSessionLog(piText)).toBe(false);

		setSessionStorageBackend(adapter);
		const reopened = SessionManager.open(file, tempDir);
		const answerId = reopened.appendMessage(assistantMsg("legacy answer"));
		const answer = reopened.getEntry(answerId)!;

		const stored = readFileSync(file, "utf8");
		expect(isDshSessionLog(stored)).toBe(true);
		expect(adapter.readFull(file)).toBe(`${piText}${JSON.stringify(answer)}\n`);
		expect(reopened.getEntries()).toEqual(session.getEntries().concat([answer]));
	});

	it("creates a missing session file as a stored log", () => {
		const file = join(tempDir, "explicit.jsonl");
		const session = SessionManager.open(file, tempDir);
		expect(existsSync(file)).toBe(false);

		session.appendMessage(userMsg("hello"));

		expect(isDshSessionLog(readFileSync(file, "utf8"))).toBe(true);
		expect(SessionManager.open(file, tempDir).getEntries()).toEqual(session.getEntries());
	});

	it("rejects a session header with lineage outside DSH's contract", () => {
		expect(() => SessionManager.create(projectCwd, tempDir, { origin: "peer" as unknown as "subagent" })).toThrow(
			'origin must be "subagent"',
		);
		expect(() => SessionManager.create(projectCwd, tempDir, { delegationDepth: -1 })).toThrow(
			"delegationDepth must be a non-negative safe integer",
		);
	});
});

describe("session storage backend selection", () => {
	let tempDir: string;

	beforeEach(() => {
		resetSessionStorageBackend();
		tempDir = mkdtempSync(join(tmpdir(), "pi-backend-selection-"));
	});

	afterEach(() => {
		resetSessionStorageBackend();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("defaults to pi's local filesystem backend and restores it on reset", () => {
		expect(getSessionStorageBackend()).toBe(defaultSessionStorageBackend);

		const local = new LocalSessionStorageBackend();
		setSessionStorageBackend(local);
		expect(getSessionStorageBackend()).toBe(local);

		resetSessionStorageBackend();
		expect(getSessionStorageBackend()).toBe(defaultSessionStorageBackend);
	});

	it("writes plain pi JSONL when no backend is selected", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg("hello"));
		const file = session.getSessionFile()!;
		const stored = readFileSync(file, "utf8");

		expect(isDshSessionLog(stored)).toBe(false);
		expect(parseLines(stored)).toEqual([session.getHeader(), ...session.getEntries()]);
	});
});
