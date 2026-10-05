/** Token-driven parser for hashline section bodies. */

import {
	type AbsoluteRangeOp,
	BARE_BODY_AUTO_PIPED_WARNING,
	BARE_RANGE_AUTO_PUT_WARNING,
	COLON_ON_REGISTER_PUT,
	COLONLESS_PUT_TAKES_NO_BODY,
	COLONLESS_SPAN_PUT,
	CUT_COLON_IGNORED_WARNING,
	CUT_TAKES_NO_BODY,
	DIFF_OLD_ROWS_IGNORED_WARNING,
	EMPTY_INSERT,
	EMPTY_PUT_AUTO_CUT_WARNING,
	invalidAbsoluteRangeMessage,
	jsonQuote,
	literalOpRowWarning,
	MINUS_BULLET_AUTO_PIPED_WARNING,
	MINUS_ROW_REJECTED,
	MOVE_TAKES_NO_BODY,
	READ_METADATA_IGNORED_WARNING,
	REGISTER_PUT_TAKES_NO_BODY,
	REM_TAKES_NO_BODY,
	REPLACE_PAIR_COALESCED_WARNING,
	repeatedSnapshotRowMessage,
	SNAPSHOT_ROWS_AUTO_PUT_WARNING,
} from "./messages.ts";
import { isReadMetadataLine, stripOneLeadingHashlinePrefix } from "./prefixes.ts";
import {
	type BlockTarget,
	blockTargetRegister,
	isHunkHeaderText,
	parseHunkHeader,
	type Token,
	Tokenizer,
} from "./tokenizer.ts";
import type { Anchor, BlockMode, BlockSpan, Cursor, Edit, FileOp, ParsedRange, PasteTarget } from "./types.ts";
import { afterAnchor, beforeAnchor, CursorBof, CursorEof } from "./types.ts";

const MAX_EXPANDED_RANGE_LINES = 100_000;
const UNIFIED_HUNK_RE = /^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/;

/** Inverted concrete range with metadata for source-aware enrichment. */
export interface InvalidAbsoluteRange {
	patch_line: number;
	start_line: number;
	end_line: number;
	op: AbsoluteRangeOp;
	register: string | undefined;
	block: BlockSpan | undefined;
}

export function invalidAbsoluteRangeError(error: InvalidAbsoluteRange): Error {
	return new Error(
		invalidAbsoluteRangeMessage(
			error.patch_line,
			error.start_line,
			error.end_line,
			error.op,
			error.block,
			error.register,
		),
	);
}

export class ParseFailure extends Error {
	invalidRange: InvalidAbsoluteRange | undefined;
	constructor(message: string, invalidRange?: InvalidAbsoluteRange) {
		super(message);
		this.invalidRange = invalidRange;
	}
}

export function enrichInvalidRange(error: ParseFailure, block: BlockSpan): ParseFailure {
	if (error.invalidRange === undefined) return error;
	return new ParseFailure(error.message, { ...error.invalidRange, block });
}

interface PayloadRow {
	text: string;
	line_num: number;
	bare: boolean;
	minus: boolean;
}

interface Pending {
	target: BlockTarget;
	line_num: number;
	payloads: PayloadRow[];
	had_colon: boolean;
	deferred_blanks: PayloadRow[];
}

export interface Parsed {
	edits: Edit[];
	file_op: FileOp | undefined;
	warnings: string[];
}

export class Executor {
	#edits: Edit[] = [];
	#warnings: string[] = [];
	#editIndex = 0;
	#pending: Pending | undefined;
	#fileOp: FileOp | undefined;
	#terminated = false;
	#skippableComments: Array<{ line_num: number; text: string }> = [];
	#recoveredSnapshotLines = new Set<number>();

	push(token: Token): void {
		this.feed(token);
	}

	end(): Parsed {
		const next = this.clone();
		return next.finish(false);
	}

	endStreaming(): Parsed {
		const next = this.clone();
		return next.finish(true);
	}

	reset(): void {
		this.#edits = [];
		this.#warnings = [];
		this.#editIndex = 0;
		this.#pending = undefined;
		this.#fileOp = undefined;
		this.#terminated = false;
		this.#skippableComments = [];
		this.#recoveredSnapshotLines = new Set();
	}

	clone(): Executor {
		const next = new Executor();
		next.#edits = [...this.#edits];
		next.#warnings = [...this.#warnings];
		next.#editIndex = this.#editIndex;
		next.#pending =
			this.#pending === undefined
				? undefined
				: {
						target: this.#pending.target,
						line_num: this.#pending.line_num,
						payloads: [...this.#pending.payloads],
						had_colon: this.#pending.had_colon,
						deferred_blanks: [...this.#pending.deferred_blanks],
					};
		next.#fileOp = this.#fileOp;
		next.#terminated = this.#terminated;
		next.#skippableComments = [...this.#skippableComments];
		next.#recoveredSnapshotLines = new Set(this.#recoveredSnapshotLines);
		return next;
	}

	warnOnce(warning: string): void {
		if (!this.#warnings.includes(warning)) this.#warnings.push(warning);
	}

	consumeComments(): void {
		const comments = this.#skippableComments;
		this.#skippableComments = [];
		for (const { text, line_num } of comments) this.handleRaw(text, line_num);
	}

	get edits(): Edit[] {
		return this.#edits;
	}

	get warnings(): string[] {
		return this.#warnings;
	}

	get fileOp(): FileOp | undefined {
		return this.#fileOp;
	}

	finish(streaming: boolean): Parsed {
		this.consumeComments();
		if (streaming) {
			const pending = this.#pending;
			const flush = pending !== undefined && (pending.payloads.length > 0 || completeBodyless(pending));
			if (flush) this.flushPending();
			else this.#pending = undefined;
		} else {
			this.flushPending();
		}
		if (this.#fileOp?.kind === "rem" && this.#edits.length > 0) {
			throw new ParseFailure("`REM` deletes the whole file and cannot be combined with line ops.");
		}
		this.normalizeOverlaps();
		return { edits: this.#edits, file_op: this.#fileOp, warnings: this.#warnings };
	}

	feed(token: Token): void {
		if (this.#terminated) return;
		switch (token.kind) {
			case "envelopeBegin":
				this.consumeComments();
				break;
			case "envelopeEnd":
				this.consumeComments();
				this.#terminated = true;
				break;
			case "abort":
				this.#terminated = true;
				break;
			case "header":
				this.consumeComments();
				this.flushPending();
				break;
			case "blank":
				this.consumeComments();
				this.handleBlank("", token.line_num);
				break;
			case "payloadLiteral":
				this.consumeComments();
				this.handleLiteral(token.text, token.line_num);
				break;
			case "raw":
				if (this.#pending === undefined && token.text.trimStart().startsWith("#")) {
					this.#skippableComments.push({ line_num: token.line_num, text: token.text });
					break;
				}
				this.consumeComments();
				this.handleRaw(token.text, token.line_num);
				break;
			case "opBlock": {
				this.#skippableComments = [];
				const { target, had_colon, line_num } = token;
				if (target.kind === "replace") validateRange(target.range, line_num, "replace", target.register);
				if (target.kind === "cut") validateRange(target.range, line_num, "cut", target.register);
				if (had_colon && (target.kind === "cut" || target.kind === "cutBlock")) {
					this.warnOnce(CUT_COLON_IGNORED_WARNING);
				}
				if (
					had_colon &&
					target.kind !== "rem" &&
					target.kind !== "move" &&
					blockTargetRegister(target) !== undefined
				) {
					throw failAt(line_num, COLON_ON_REGISTER_PUT);
				}
				if (target.kind === "rem") {
					this.flushPending();
					this.setFileOp({ kind: "rem" }, line_num);
				} else if (target.kind === "move") {
					this.flushPending();
					this.setFileOp({ kind: "move", dest: target.dest }, line_num);
				} else {
					this.flushPending();
					this.#pending = {
						target,
						line_num,
						payloads: [],
						had_colon,
						deferred_blanks: [],
					};
				}
				break;
			}
		}
	}

	setFileOp(op: FileOp, lineNum: number): void {
		if (this.#fileOp !== undefined) {
			throw failAt(lineNum, "only one file-level op (`REM` or `MV`) per section. Merge them under one header.");
		}
		if (op.kind === "rem" && this.#edits.length > 0) throw failAt(lineNum, REM_TAKES_NO_BODY);
		this.#fileOp = op;
	}

	handleLiteral(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (pending === undefined) {
			if (this.#fileOp !== undefined) throw failAt(lineNum, MOVE_TAKES_NO_BODY);
			throw failAt(lineNum, `payload line has no preceding hunk header. Got ${jsonQuote(`+${text}`)}.`);
		}
		const message = bodylessMessage(pending.target, pending.had_colon);
		if (message !== undefined) throw failAt(lineNum, message);
		pending.payloads.push(...pending.deferred_blanks.splice(0));
		if (isHunkHeaderText(text)) this.#warnings.push(literalOpRowWarning(lineNum, text));
		pending.payloads.push({ text, line_num: lineNum, bare: false, minus: false });
	}

	handleRaw(text: string, lineNum: number): void {
		if (this.#pending === undefined && isReadMetadataLine(text)) {
			this.warnOnce(READ_METADATA_IGNORED_WARNING);
			return;
		}
		const contamination = contaminationMessage(text);
		if (contamination !== undefined) throw failAt(lineNum, contamination);
		if (this.#fileOp !== undefined) throw failAt(lineNum, MOVE_TAKES_NO_BODY);
		const pending = this.#pending;
		if (pending !== undefined) {
			if (text.trim() === "") {
				this.handleBlank(text, lineNum);
				return;
			}
			const message = bodylessMessage(pending.target, pending.had_colon);
			if (message !== undefined) throw failAt(lineNum, message);
			const minus = text.trimStart().startsWith("-");
			if (!minus) this.warnOnce(BARE_BODY_AUTO_PIPED_WARNING);
			pending.payloads.push(...pending.deferred_blanks.splice(0));
			pending.payloads.push({ text, line_num: lineNum, bare: true, minus });
			return;
		}
		if (text.trim() === "") return;
		const bareRange = parseBareRange(text);
		if (bareRange !== undefined) {
			validateRange(bareRange, lineNum, "replace", undefined);
			this.#pending = {
				target: { kind: "replace", range: bareRange, register: undefined },
				line_num: lineNum,
				payloads: [],
				had_colon: true,
				deferred_blanks: [],
			};
			this.warnOnce(BARE_RANGE_AUTO_PUT_WARNING);
			return;
		}
		const snapshot = parseSnapshotRow(text);
		if (snapshot !== undefined) {
			const [line, value] = snapshot;
			if (this.#recoveredSnapshotLines.has(line)) {
				throw failAt(lineNum, repeatedSnapshotRowMessage(line));
			}
			this.#recoveredSnapshotLines.add(line);
			const range: ParsedRange = { start: { line }, end: { line } };
			this.pushInsert(beforeAnchor({ line }), value, lineNum, true);
			this.pushDeleteRange(range, lineNum);
			this.warnOnce(SNAPSHOT_ROWS_AUTO_PUT_WARNING);
			return;
		}
		throw failAt(
			lineNum,
			`payload line has no preceding hunk header. Use \`PUT N.=M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got ${jsonQuote(text)}.`,
		);
	}

	handleBlank(text: string, lineNum: number): void {
		const pending = this.#pending;
		if (pending === undefined) return;
		if (bodylessMessage(pending.target, pending.had_colon) !== undefined || pending.payloads.length === 0) return;
		pending.deferred_blanks.push({ text, line_num: lineNum, bare: true, minus: false });
	}

	flushPending(): void {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.#pending = undefined;
		resolveMinusRows(this, pending.payloads);
		stripUniformBarePrefixes(pending.payloads);
		const line = pending.line_num;
		const target = pending.target;
		switch (target.kind) {
			case "rem":
			case "move":
				break;
			case "cut":
				this.pushCut(target.range, target.register, line);
				break;
			case "cutBlock":
				this.pushBlock(target.anchor, [], "cut", target.register, line);
				break;
			case "replace": {
				if (target.register !== undefined) {
					this.pushPaste({ kind: "span", range: target.range }, target.register, line);
				} else if (pending.payloads.length === 0) {
					if (!pending.had_colon) throw failAt(line, COLONLESS_SPAN_PUT);
					this.pushDeleteRange(target.range, line);
					this.warnOnce(EMPTY_PUT_AUTO_CUT_WARNING);
				} else {
					for (const row of pending.payloads) {
						this.pushInsert(beforeAnchor(target.range.start), row.text, line, true);
					}
					this.pushDeleteRange(target.range, line);
				}
				break;
			}
			case "block": {
				if (target.register !== undefined) {
					this.pushBlock(target.anchor, [], undefined, target.register, line);
				} else if (pending.payloads.length === 0) {
					if (!pending.had_colon) throw failAt(line, COLONLESS_SPAN_PUT);
					this.pushBlock(target.anchor, [], undefined, undefined, line);
					this.warnOnce(EMPTY_PUT_AUTO_CUT_WARNING);
				} else {
					this.pushBlock(
						target.anchor,
						pending.payloads.map((row) => row.text),
						undefined,
						undefined,
						line,
					);
				}
				break;
			}
			case "insertAfterBlock": {
				if (target.register !== undefined || (!pending.had_colon && pending.payloads.length === 0)) {
					this.pushBlock(target.anchor, [], "pasteAfter", target.register, line);
				} else if (pending.payloads.length === 0) {
					throw failAt(line, EMPTY_INSERT);
				} else {
					this.pushBlock(
						target.anchor,
						pending.payloads.map((row) => row.text),
						"insertAfter",
						undefined,
						line,
					);
				}
				break;
			}
			case "insertBefore":
			case "insertAfter":
			case "bof":
			case "eof": {
				let cursor!: Cursor;
				let register: string | undefined;
				switch (target.kind) {
					case "insertBefore":
						cursor = beforeAnchor(target.anchor);
						register = target.register;
						break;
					case "insertAfter":
						cursor = afterAnchor(target.anchor);
						register = target.register;
						break;
					case "bof":
						cursor = CursorBof;
						register = target.register;
						break;
					case "eof":
						cursor = CursorEof;
						register = target.register;
						break;
				}
				if (register !== undefined || (!pending.had_colon && pending.payloads.length === 0)) {
					this.pushPaste({ kind: "gap", cursor }, register, line);
				} else if (pending.payloads.length === 0) {
					throw failAt(line, EMPTY_INSERT);
				} else {
					for (const row of pending.payloads) this.pushInsert(cursor, row.text, line, false);
				}
				break;
			}
		}
	}

	nextIndex(): number {
		const index = this.#editIndex;
		this.#editIndex += 1;
		return index;
	}

	pushInsert(cursor: Cursor, text: string, lineNum: number, replacement: boolean): void {
		const index = this.nextIndex();
		this.#edits.push({
			type: "insert",
			cursor,
			text,
			line_num: lineNum,
			index,
			replacement,
			block_start: undefined,
		});
	}

	pushDelete(anchor: Anchor, lineNum: number): void {
		const index = this.nextIndex();
		this.#edits.push({ type: "delete", anchor, line_num: lineNum, index, old_assertion: undefined });
	}

	pushDeleteRange(range: ParsedRange, lineNum: number): void {
		for (let line = range.start.line; line <= range.end.line; line += 1) {
			this.pushDelete({ line }, lineNum);
		}
	}

	pushCut(range: ParsedRange, register: string | undefined, lineNum: number): void {
		const index = this.nextIndex();
		this.#edits.push({ type: "cut", range, register, line_num: lineNum, index });
		this.pushDeleteRange(range, lineNum);
	}

	pushPaste(at: PasteTarget, register: string | undefined, lineNum: number): void {
		const index = this.nextIndex();
		this.#edits.push({ type: "paste", at, register, line_num: lineNum, index, block_start: undefined });
	}

	pushBlock(
		anchor: Anchor,
		payloads: string[],
		mode: BlockMode | undefined,
		register: string | undefined,
		lineNum: number,
	): void {
		const index = this.nextIndex();
		this.#edits.push({ type: "block", anchor, payloads, mode, register, line_num: lineNum, index });
	}

	normalizeOverlaps(): void {
		interface Hunk {
			lines: Set<number>;
			clipboard: boolean;
		}
		const hunks = new Map<number, Hunk>();
		for (const edit of this.#edits) {
			if (edit.type === "cut") {
				const hunk = hunks.get(edit.line_num) ?? { lines: new Set(), clipboard: false };
				hunk.clipboard = true;
				hunks.set(edit.line_num, hunk);
			} else if (edit.type === "paste" && edit.at.kind === "span") {
				const hunk = hunks.get(edit.line_num) ?? { lines: new Set(), clipboard: false };
				hunk.clipboard = true;
				for (let line = edit.at.range.start.line; line <= edit.at.range.end.line; line += 1) {
					hunk.lines.add(line);
				}
				hunks.set(edit.line_num, hunk);
			} else if (edit.type === "delete") {
				const hunk = hunks.get(edit.line_num) ?? { lines: new Set(), clipboard: false };
				hunk.lines.add(edit.anchor.line);
				hunks.set(edit.line_num, hunk);
			}
		}
		const owner = new Map<number, number>();
		const dropped = new Set<number>();
		const entries = [...hunks.entries()].sort((a, b) => a[0] - b[0]);
		for (const [lineNum, hunk] of entries) {
			if (hunk.lines.size === 0) continue;
			const overlaps = new Set<number>();
			for (const line of hunk.lines) {
				const prev = owner.get(line);
				if (prev !== undefined) overlaps.add(prev);
			}
			if (overlaps.size === 0) {
				for (const line of hunk.lines) owner.set(line, lineNum);
				continue;
			}
			const previous = overlaps.size === 1 ? [...overlaps][0] : undefined;
			let exact = false;
			if (previous !== undefined) {
				const old = hunks.get(previous);
				if (old !== undefined && !old.clipboard && setsEqual(old.lines, hunk.lines)) exact = true;
			}
			if (exact && previous !== undefined) {
				dropped.add(previous);
				for (const [line, value] of owner) if (value === previous) owner.delete(line);
				for (const line of hunk.lines) owner.set(line, lineNum);
				this.warnOnce(REPLACE_PAIR_COALESCED_WARNING);
				continue;
			}
			let first = 0;
			for (const line of [...hunk.lines].sort((a, b) => a - b)) {
				if (owner.has(line)) {
					first = line;
					break;
				}
			}
			const prior = previous === undefined ? "an earlier line" : `${previous}`;
			throw failAt(
				lineNum,
				`anchor line ${first} is already targeted by another hunk on line ${prior}. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
		if (dropped.size > 0) {
			this.#edits = this.#edits.filter((edit) => !dropped.has(edit.line_num));
		}
	}
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

function resolveMinusRows(executor: Executor, rows: PayloadRow[]): void {
	const minus = rows.filter((row) => row.minus);
	if (minus.length === 0) return;
	const allBullets = minus.every((row) => markdownBullet(row.text));
	const explicit = rows.filter((row) => !row.bare);
	if (allBullets && (explicit.length === 0 || explicit.some((row) => markdownBullet(row.text)))) {
		executor.warnOnce(MINUS_BULLET_AUTO_PIPED_WARNING);
		return;
	}
	if (explicit.length > 0 && !allBullets) {
		const kept = rows.filter((row) => !row.minus);
		rows.length = 0;
		rows.push(...kept);
		executor.warnOnce(DIFF_OLD_ROWS_IGNORED_WARNING);
		return;
	}
	throw failAt(minus[0].line_num, MINUS_ROW_REJECTED);
}

function bodylessMessage(target: BlockTarget, hadColon: boolean): string | undefined {
	if (target.kind === "cut" || target.kind === "cutBlock") return CUT_TAKES_NO_BODY;
	if (target.kind === "rem" || target.kind === "move") return undefined;
	if (blockTargetRegister(target) !== undefined) return REGISTER_PUT_TAKES_NO_BODY;
	if (!hadColon) return COLONLESS_PUT_TAKES_NO_BODY;
	return undefined;
}

function completeBodyless(pending: Pending): boolean {
	return (
		pending.target.kind === "cut" ||
		pending.target.kind === "cutBlock" ||
		blockTargetRegister(pending.target) !== undefined ||
		(!pending.had_colon &&
			(pending.target.kind === "insertBefore" ||
				pending.target.kind === "insertAfter" ||
				pending.target.kind === "insertAfterBlock" ||
				pending.target.kind === "bof" ||
				pending.target.kind === "eof"))
	);
}

function markdownBullet(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("- ") && trimmed.length > 2 && !/\s/.test(trimmed[2]);
}

function parseSnapshotRow(text: string): [number, string] | undefined {
	const trimmed = text.trimStart();
	const splitIndex = trimmed.search(/[:|]/);
	if (splitIndex === -1) return undefined;
	const number = trimmed.slice(0, splitIndex);
	if (number.startsWith("0") || !/^\d+$/.test(number) || number === "") return undefined;
	return [Number.parseInt(number, 10), trimmed.slice(splitIndex + 1)];
}

function parseBareRange(text: string): ParsedRange | undefined {
	const trimmed = text.trim();
	if (!trimmed.endsWith(":")) return undefined;
	const before = trimmed.slice(0, -1).trim();
	const parts = before.split(/[\s\-.=…]+/).filter((part) => part !== "");
	if (parts.length !== 2) return undefined;
	const start = Number.parseInt(parts[0], 10);
	const end = Number.parseInt(parts[1], 10);
	if (Number.isNaN(start) || Number.isNaN(end) || start === 0 || end === 0) return undefined;
	return { start: { line: start }, end: { line: end } };
}

function contaminationMessage(text: string): string | undefined {
	const trimmed = text.trimStart();
	for (const prefix of ["*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"]) {
		if (trimmed.startsWith(prefix)) {
			const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
			return `apply_patch sentinel ${jsonQuote(preview)} is not valid in hashline. File sections start with \`[path#HASH]\` (no \`Update File:\` / \`Add File:\` keyword). Use \`PUT N.=M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` ops.`;
		}
	}
	if (trimmed.startsWith("@@")) {
		if (UNIFIED_HUNK_RE.test(trimmed)) {
			return "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. Use `PUT N.=M:`, `CUT N.=M`, or `PUT <N:`/`PUT >N:` ops.";
		}
		const preview = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
		return `\`@@\`-bracketed hunk header ${jsonQuote(preview)} is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a header such as \`PUT N.=M:\`.`;
	}
	if (
		trimmed !== "" &&
		[...trimmed].every((ch) => /[0-9\s]/.test(ch)) &&
		trimmed.split(/\s+/).filter((part) => part !== "").length === 1
	) {
		return `hunk headers need a verb and both endpoints. Use \`PUT ${trimmed.trim()}.=${trimmed.trim()}:\` to replace, or \`CUT ${trimmed.trim()}.=${trimmed.trim()}\` to delete.`;
	}
	const pieces = trimmed
		.replace(/:$/, "")
		.split(/\s+/)
		.filter((part) => part !== "");
	if (pieces.length === 2 && pieces.every((piece) => /^\d+$/.test(piece))) {
		return `bare range hunk header ${jsonQuote(trimmed)} is not valid. Hunk headers need a verb: use \`PUT N.=M:\` or \`CUT N.=M\`.`;
	}
	return undefined;
}

function stripUniformBarePrefixes(rows: PayloadRow[]): void {
	let saw = false;
	let allLiteral = true;
	for (const row of rows) {
		if (!row.bare || row.text.trim() === "") continue;
		saw = true;
		const stripped = stripOneLeadingHashlinePrefix(row.text);
		if (stripped === row.text) return;
		allLiteral = allLiteral && literalValue(stripped);
	}
	if (!saw || allLiteral) return;
	for (const row of rows) {
		if (!row.bare || row.text.trim() === "") continue;
		row.text = stripOneLeadingHashlinePrefix(row.text);
	}
}

function literalValue(text: string): boolean {
	const value = text.trim().replace(/,+$/, "").trim();
	return (
		(value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) ||
		/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)
	);
}

function validateRange(range: ParsedRange, lineNum: number, op: AbsoluteRangeOp, register: string | undefined): void {
	if (range.end.line < range.start.line) {
		throw new ParseFailure(
			invalidAbsoluteRangeMessage(lineNum, range.start.line, range.end.line, op, undefined, register),
			{
				patch_line: lineNum,
				start_line: range.start.line,
				end_line: range.end.line,
				op,
				register,
				block: undefined,
			},
		);
	}
	const span = range.end.line - range.start.line + 1;
	if (span > MAX_EXPANDED_RANGE_LINES) {
		throw failAt(
			lineNum,
			`${op} range spans ${span} lines; the maximum is ${MAX_EXPANDED_RANGE_LINES}. Split it into smaller hunks.`,
		);
	}
}

function failAt(line: number, message: string): ParseFailure {
	return new ParseFailure(`line ${line}: ${message}`);
}

/** Parse a complete hashline section body. */
export function parsePatch(diff: string): Parsed {
	return parseImpl(diff, false);
}

/** Parse a partial body while dropping the trailing incomplete operation. */
export function parsePatchStreaming(diff: string): Parsed {
	return parseImpl(diff, true);
}

function parseImpl(diff: string, streaming: boolean): Parsed {
	const tokenizer = new Tokenizer();
	const executor = new Executor();
	try {
		for (const token of tokenizer.feed(diff)) executor.feed(token);
		for (const token of tokenizer.end()) executor.feed(token);
		return executor.finish(streaming);
	} catch (error) {
		if (error instanceof ParseFailure) {
			if (error.invalidRange !== undefined) throw invalidAbsoluteRangeError(error.invalidRange);
			throw error;
		}
		throw error;
	}
}

export { parseHunkHeader };
