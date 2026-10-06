// Append-only session log in deepseek-harness' SESSION_FORMAT_VERSION 4 shape,
// carrying pi session entries. Ported from deepseek-harness@639ed015397290b3745d163aafe02ffee4aa3f84:
// header line from packages/session/session-persistence-jsonl/src/format.ts, row envelope from
// packages/session/session-format-v1-to-v2/src/codec.ts, ignorable guard from
// packages/session/session-format-v3-to-v4/src/validation.ts, header lineage validation from
// packages/core/session/src/index.ts.
//
// Layout: line 1 is the session header (`type:"session"`, `version:4`, `id`, `createdAt`, plus pi's
// `timestamp`/`piVersion` and the lineage fields), every following line is one row
// `{"type","seq","time","data"}` whose `data` is one pi session entry verbatim. Rows are append-only
// and dense: `seq` is the row's position after the header, counted from 0, and a row type this build
// does not know is refused unless it carries `ignorable:true`, which drops the row while still
// consuming its `seq`.
import type { FileEntry, SessionEntry, SessionHeader } from "../session-manager.ts";

/** Session log format generation this module reads and writes (DSH `SESSION_FORMAT_VERSION`). */
export const DSH_SESSION_FORMAT_VERSION = 4;

/** Largest epoch millisecond `Date.prototype.toISOString()` accepts. */
const MAX_DATE_MS = 8.64e15;

/** Header line keys: DSH's required/optional sets plus pi's `timestamp`/`piVersion`. */
const HEADER_LINE_KEYS: ReadonlySet<string> = new Set([
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

/** Row keys: DSH's `EVENT_REQUIRED`/`EVENT_OPTIONAL` sets (session-format-v1-to-v2/src/codec.ts:21-23). */
const ROW_REQUIRED_KEYS = ["type", "seq", "time", "data"] as const;
const ROW_KEYS: ReadonlySet<string> = new Set([...ROW_REQUIRED_KEYS, "ignorable", "sourceEventSeqs", "surfaceOp"]);

/**
 * A stored row violated the v4 row contract (density, envelope keys, unknown entry type without
 * `ignorable:true`). Refusing keeps a session this build cannot faithfully decode from being
 * silently dropped or rewritten, matching DSH's "refuse unknown, never corrupt" policy.
 */
export class DshSessionLogRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DshSessionLogRefusedError";
	}
}

/**
 * Every pi session entry type this build decodes, keyed by its type tag. The `Record` over the
 * `SessionEntry` union fails to compile when a union member is missing, so adding an entry type
 * forces a decision here (DSH's `KNOWN_SESSION_EVENT_TYPES` guard).
 */
export const KNOWN_ENTRY_TYPES: Record<SessionEntry["type"], true> = {
	message: true,
	thinking_level_change: true,
	model_change: true,
	usage: true,
	compaction: true,
	branch_summary: true,
	custom: true,
	custom_message: true,
	context_edit: true,
	label: true,
	session_info: true,
};

/** Type guard: `type` is an entry type this build can decode and encode. */
export function isKnownEntryType(type: string): type is SessionEntry["type"] {
	return Object.hasOwn(KNOWN_ENTRY_TYPES, type);
}

/**
 * Validate the header lineage fields (port of DSH `validateSessionHeader`, index.ts:122-137):
 * `origin` may only be `"subagent"`, `delegationDepth` a non-negative safe integer, `isSeeded` a
 * boolean, `parentSession`/`agentPreset` strings. Unlike DSH, `isSeeded` and `delegationDepth`
 * stay optional so a pi header round-trips without inventing values DSH requires on write.
 */
export function assertSessionHeaderLineage(header: SessionHeader): void {
	const parentSession = (header as { parentSession?: unknown }).parentSession;
	if (parentSession !== undefined && typeof parentSession !== "string") {
		throw new Error("session header parentSession must be a string");
	}
	const isSeeded = (header as { isSeeded?: unknown }).isSeeded;
	if (isSeeded !== undefined && typeof isSeeded !== "boolean") {
		throw new Error("session header isSeeded must be a boolean");
	}
	const origin = (header as { origin?: unknown }).origin;
	if (origin !== undefined && origin !== "subagent") {
		throw new Error('session header origin must be "subagent"');
	}
	const delegationDepth = (header as { delegationDepth?: unknown }).delegationDepth;
	if (
		delegationDepth !== undefined &&
		(typeof delegationDepth !== "number" || !Number.isSafeInteger(delegationDepth) || delegationDepth < 0)
	) {
		throw new Error("session header delegationDepth must be a non-negative safe integer");
	}
	const agentPreset = (header as { agentPreset?: unknown }).agentPreset;
	if (agentPreset !== undefined && typeof agentPreset !== "string") {
		throw new Error("session header agentPreset must be a string");
	}
}

function parseJsonObject(line: string): Record<string, unknown> | null {
	if (!line.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}

/**
 * Parse one line of pi's own session JSONL into a file entry; null for blank or malformed lines,
 * exactly how `loadEntriesFromFile` treats them.
 */
export function parsePiFileEntry(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

/** Non-negative safe integer (DSH's `sessionFormatCount`). */
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** ISO timestamp (pi) → epoch milliseconds for the row `time`/header `createdAt` fields. */
function epochMs(timestamp: unknown): number {
	if (typeof timestamp !== "string") return 0;
	const parsed = Date.parse(timestamp);
	return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_DATE_MS ? parsed : 0;
}

/** Epoch milliseconds → ISO timestamp when a stored header carries no pi `timestamp`. */
function timestampFromEpoch(createdAt: number): string {
	return createdAt <= MAX_DATE_MS ? new Date(createdAt).toISOString() : "";
}

/**
 * True when `line` opens a session format v4 log: a `type:"session"` record with `version:4` and a
 * numeric `createdAt`. pi's own header carries a `timestamp` string and no `createdAt`, so a future
 * pi header with `version:4` is not mistaken for this format.
 */
export function isDshHeaderLine(line: string): boolean {
	const record = parseJsonObject(line);
	if (record === null) return false;
	return (
		record.type === "session" && record.version === DSH_SESSION_FORMAT_VERSION && typeof record.createdAt === "number"
	);
}

/** True when `content`'s first non-blank line is a v4 session header. */
export function isDshSessionLog(content: string): boolean {
	let start = 0;
	for (;;) {
		const newline = content.indexOf("\n", start);
		const line = newline === -1 ? content.slice(start) : content.slice(start, newline);
		if (line.trim()) return isDshHeaderLine(line);
		if (newline === -1) return false;
		start = newline + 1;
	}
}

/**
 * Serialize one pi session header as a v4 header line. Key order is fixed
 * (`type, version, id, createdAt, timestamp, piVersion, cwd, parentSession, isSeeded, origin,
 * delegationDepth, agentPreset`) so a header always re-encodes to identical bytes. `version` is
 * the log generation; `piVersion` carries pi's entry schema version, and optional fields are only
 * written when the header holds them, which is what makes the decode below lossless.
 */
export function encodeDshHeaderLine(header: SessionHeader): string {
	assertSessionHeaderLineage(header);
	const timestamp = (header as { timestamp?: unknown }).timestamp;
	const cwd = (header as { cwd?: unknown }).cwd;
	const line: Record<string, unknown> = {
		type: "session",
		version: DSH_SESSION_FORMAT_VERSION,
		id: header.id,
		createdAt: epochMs(timestamp),
	};
	if (typeof timestamp === "string") line.timestamp = timestamp;
	if (header.version !== undefined) line.piVersion = header.version;
	if (typeof cwd === "string") line.cwd = cwd;
	if (header.parentSession !== undefined) line.parentSession = header.parentSession;
	if (header.isSeeded !== undefined) line.isSeeded = header.isSeeded;
	if (header.origin !== undefined) line.origin = header.origin;
	if (header.delegationDepth !== undefined) line.delegationDepth = header.delegationDepth;
	if (header.agentPreset !== undefined) line.agentPreset = header.agentPreset;
	return JSON.stringify(line);
}

/**
 * Decode a v4 header line into the pi header it wraps, or null when the line is not a v4 header
 * or breaks its contract (unknown keys, wrong types, non-count `createdAt`/`delegationDepth`).
 * `piVersion` becomes the pi header's `version` (absent → `version:4`, which pi never migrates);
 * a header without pi's `timestamp` gets one synthesized from `createdAt`.
 */
export function decodeDshHeaderLine(line: string): SessionHeader | null {
	if (!isDshHeaderLine(line)) return null;
	const record = parseJsonObject(line);
	if (record === null) return null;
	for (const key of Object.keys(record)) {
		if (!HEADER_LINE_KEYS.has(key)) return null;
	}
	const {
		id,
		createdAt,
		version,
		timestamp,
		piVersion,
		cwd,
		parentSession,
		isSeeded,
		origin,
		delegationDepth,
		agentPreset,
	} = record;
	if (typeof id !== "string" || !isCount(createdAt)) return null;
	if (typeof version !== "number" || version !== DSH_SESSION_FORMAT_VERSION) return null;
	if (timestamp !== undefined && typeof timestamp !== "string") return null;
	if (piVersion !== undefined && typeof piVersion !== "number") return null;
	if (cwd !== undefined && typeof cwd !== "string") return null;
	if (parentSession !== undefined && typeof parentSession !== "string") return null;
	if (isSeeded !== undefined && typeof isSeeded !== "boolean") return null;
	if (delegationDepth !== undefined && !isCount(delegationDepth)) return null;
	if (agentPreset !== undefined && typeof agentPreset !== "string") return null;
	let originValue: "subagent" | undefined;
	if (origin === undefined) {
		originValue = undefined;
	} else if (origin === "subagent") {
		originValue = "subagent";
	} else {
		return null;
	}
	return {
		type: "session",
		version: piVersion ?? version,
		id,
		timestamp: typeof timestamp === "string" ? timestamp : timestampFromEpoch(createdAt),
		cwd: cwd ?? "",
		parentSession,
		isSeeded,
		origin: originValue,
		delegationDepth: isCount(delegationDepth) ? delegationDepth : undefined,
		agentPreset,
	};
}

/**
 * Encode one pi entry as a v4 row with `seq` as its dense position. Refuses an entry type outside
 * `KNOWN_ENTRY_TYPES`: the writer cannot vouch for a payload it does not understand, so it may not
 * mark it `ignorable` on the reader's behalf.
 */
export function encodeDshEventRow(entry: SessionEntry, seq: number): string {
	if (!isKnownEntryType(entry.type)) {
		throw new DshSessionLogRefusedError(
			`refusing to write unknown session entry type ${JSON.stringify(entry.type)} at seq ${seq}`,
		);
	}
	if (!isCount(seq)) {
		throw new DshSessionLogRefusedError(`session row seq must be a non-negative safe integer, got ${String(seq)}`);
	}
	return JSON.stringify({ type: entry.type, seq, time: epochMs(entry.timestamp), data: entry });
}

/** Outcome of decoding one stored row: a pi entry, an ignorable row to skip, or unparsable text. */
export type DshRowDecode = { kind: "entry"; entry: SessionEntry } | { kind: "skip" } | { kind: "malformed" };

/**
 * Decode one stored row against `expectedSeq`, the position it must occupy. Throws
 * `DshSessionLogRefusedError` on a density gap, an envelope violation, a payload that is not the
 * entry the row names, or an unknown entry type without `ignorable:true` (port of DSH's guard:
 * `if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) throw ...`,
 * validation.ts:59-64). Unparsable JSON returns `malformed`, which pi's reader drops line by line
 * the way it already drops malformed lines from its own JSONL files.
 */
export function decodeDshEventRow(line: string, expectedSeq: number): DshRowDecode {
	const record = parseJsonObject(line);
	if (record === null) return { kind: "malformed" };
	for (const key of Object.keys(record)) {
		if (!ROW_KEYS.has(key)) {
			throw new DshSessionLogRefusedError(
				`session log row has unexpected field ${JSON.stringify(key)} at seq ${expectedSeq}`,
			);
		}
	}
	for (const key of ROW_REQUIRED_KEYS) {
		if (!Object.hasOwn(record, key)) {
			throw new DshSessionLogRefusedError(
				`session log row lacks required field ${JSON.stringify(key)} at seq ${expectedSeq}`,
			);
		}
	}
	const { type, seq, time, data, ignorable } = record;
	if (typeof type !== "string") {
		throw new DshSessionLogRefusedError(`session log row type must be a string at seq ${expectedSeq}`);
	}
	if (!isCount(seq)) {
		throw new DshSessionLogRefusedError(
			`session log row seq must be a non-negative safe integer at seq ${expectedSeq}`,
		);
	}
	if (seq !== expectedSeq) {
		throw new DshSessionLogRefusedError(
			`session log row is not dense: expected seq ${expectedSeq}, got ${seq} (row ${expectedSeq})`,
		);
	}
	if (!isCount(time)) {
		throw new DshSessionLogRefusedError(
			`session log row time must be a non-negative safe integer at seq ${expectedSeq}`,
		);
	}
	if (ignorable !== undefined && ignorable !== true) {
		throw new DshSessionLogRefusedError(`session log row ignorable must be true when present at seq ${expectedSeq}`);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new DshSessionLogRefusedError(`session log row data must be an object at seq ${expectedSeq}`);
	}
	if (!isKnownEntryType(type)) {
		if (ignorable === true) return { kind: "skip" };
		throw new DshSessionLogRefusedError(
			`session log contains unknown entry type ${JSON.stringify(type)} at seq ${expectedSeq}; writers must mark rows this build cannot read with ignorable:true`,
		);
	}
	const payload = data as Record<string, unknown>;
	if (
		payload.type !== type ||
		typeof payload.id !== "string" ||
		typeof payload.timestamp !== "string" ||
		!Object.hasOwn(payload, "parentId")
	) {
		throw new DshSessionLogRefusedError(
			`session log row at seq ${expectedSeq} does not carry a ${type} entry payload`,
		);
	}
	return { kind: "entry", entry: payload as unknown as SessionEntry };
}

/**
 * Line-by-line projection of stored text onto pi's own JSONL. The first non-blank line selects the
 * mode: a v4 header switches to decoding rows, anything else passes every later line through
 * unchanged so a plain pi file reads byte for byte. In v4 mode each non-blank line consumes one
 * `seq` (including ones dropped as malformed or ignorable), which is exactly the dense position
 * `encodeDshEventRow` hands out when appending.
 */
export interface DshStoredLineDecoder {
	/** Feed one stored line; returns the pi-format line to emit, or null when nothing is emitted. */
	push(line: string): string | null;
}

/** Create a decoder over one file's lines in order. */
export function createDshStoredLineDecoder(): DshStoredLineDecoder {
	let mode: "unknown" | "dsh" | "passthrough" = "unknown";
	let nextSeq = 0;
	return {
		push(line: string): string | null {
			if (mode === "passthrough") return line;
			if (!line.trim()) return mode === "dsh" ? null : line;
			if (mode === "unknown") {
				if (!isDshHeaderLine(line)) {
					mode = "passthrough";
					return line;
				}
				const header = decodeDshHeaderLine(line);
				if (header === null) {
					throw new DshSessionLogRefusedError("session log header line is not a valid session format v4 header");
				}
				mode = "dsh";
				return JSON.stringify(header);
			}
			const seq = nextSeq;
			nextSeq += 1;
			const decoded = decodeDshEventRow(line, seq);
			if (decoded.kind !== "entry") return null;
			return JSON.stringify(decoded.entry);
		},
	};
}

/**
 * Project a stored file's full text onto pi's JSONL: a v4 log decodes to header + entries, one per
 * line with a trailing newline. Refuses content that is not a v4 log instead of guessing.
 */
export function decodeDshStoredText(content: string): string {
	if (!isDshSessionLog(content)) {
		throw new DshSessionLogRefusedError("content is not a session format v4 log");
	}
	const decoder = createDshStoredLineDecoder();
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const projected: string[] = [];
	for (const line of lines) {
		const projectedLine = decoder.push(line);
		if (projectedLine !== null) projected.push(projectedLine);
	}
	return projected.length === 0 ? "" : `${projected.join("\n")}\n`;
}

/** Decode a stored v4 log into pi's file entries (header first), refusing on a contract violation. */
export function decodeDshSessionLog(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of decodeDshStoredText(content).split("\n")) {
		const entry = parsePiFileEntry(line);
		if (entry !== null) entries.push(entry);
	}
	return entries;
}

/** Encode a pi header plus its entries as a complete stored v4 log, one line per record. */
export function encodeDshSessionLog(header: SessionHeader, entries: readonly SessionEntry[]): string {
	const lines = [encodeDshHeaderLine(header)];
	let seq = 0;
	for (const entry of entries) {
		lines.push(encodeDshEventRow(entry, seq));
		seq++;
	}
	return lines.map((line) => `${line}\n`).join("");
}
