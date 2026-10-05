/** Stateful line-oriented hashline tokenizer. */

import {
	describeAnchorExamples,
	HL_CUT_KEYWORD,
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_MOVE_KEYWORD,
	HL_PUT_KEYWORD,
	HL_REM_KEYWORD,
} from "./format.ts";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER, jsonQuote } from "./messages.ts";
import type { Anchor, ParsedRange } from "./types.ts";

/** Locator and optional register parsed from one operation header. */
export type BlockTarget =
	| { kind: "replace"; range: ParsedRange; register: string | undefined }
	| { kind: "block"; anchor: Anchor; register: string | undefined }
	| { kind: "insertBefore"; anchor: Anchor; register: string | undefined }
	| { kind: "insertAfter"; anchor: Anchor; register: string | undefined }
	| { kind: "insertAfterBlock"; anchor: Anchor; register: string | undefined }
	| { kind: "cut"; range: ParsedRange; register: string | undefined }
	| { kind: "cutBlock"; anchor: Anchor; register: string | undefined }
	| { kind: "bof"; register: string | undefined }
	| { kind: "eof"; register: string | undefined }
	| { kind: "rem" }
	| { kind: "move"; dest: string };

export function blockTargetRegister(target: BlockTarget): string | undefined {
	switch (target.kind) {
		case "replace":
		case "block":
		case "insertBefore":
		case "insertAfter":
		case "insertAfterBlock":
		case "cut":
		case "cutBlock":
		case "bof":
		case "eof":
			return target.register;
		case "rem":
		case "move":
			return undefined;
	}
}

/** One classified hashline input row. */
export type Token =
	| { kind: "blank"; line_num: number }
	| { kind: "envelopeBegin"; line_num: number }
	| { kind: "envelopeEnd"; line_num: number }
	| { kind: "abort"; line_num: number }
	| { kind: "header"; line_num: number; path: string; file_hash: string | undefined }
	| { kind: "opBlock"; line_num: number; target: BlockTarget; had_colon: boolean }
	| { kind: "payloadLiteral"; line_num: number; text: string }
	| { kind: "raw"; line_num: number; text: string };

export function tokenLineNum(token: Token): number {
	return token.line_num;
}

export class Tokenizer {
	#buffer = "";
	#nextLineNum = 1;
	#closed = false;

	feed(chunk: string): Token[] {
		if (this.#closed) throw new Error("Tokenizer is closed; call reset() before reusing.");
		if (chunk === "") return [];
		this.#buffer += chunk;
		const tokens: Token[] = [];
		let index = this.#buffer.indexOf("\n");
		while (index !== -1) {
			let line = this.#buffer.slice(0, index);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.#buffer = this.#buffer.slice(index + 1);
			tokens.push(classifyLine(line, this.#nextLineNum));
			this.#nextLineNum += 1;
			index = this.#buffer.indexOf("\n");
		}
		return tokens;
	}

	end(): Token[] {
		if (this.#closed) return [];
		this.#closed = true;
		if (this.#buffer === "") return [];
		let line = this.#buffer;
		this.#buffer = "";
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const token = classifyLine(line, this.#nextLineNum);
		this.#nextLineNum += 1;
		return [token];
	}

	reset(): void {
		this.#buffer = "";
		this.#nextLineNum = 1;
		this.#closed = false;
	}

	tokenizeAll(text: string): Token[] {
		this.reset();
		return [...this.feed(text), ...this.end()];
	}

	tokenize(line: string, lineNum: number): Token {
		return classifyLine(line, lineNum);
	}

	isOp(line: string): boolean {
		return parseHunkHeader(line) !== undefined;
	}

	isHeader(line: string): boolean {
		return parseHeader(line) !== undefined;
	}

	isEnvelopeMarker(line: string): boolean {
		return (
			markerLineEquals(line, BEGIN_PATCH_MARKER) ||
			markerLineEquals(line, END_PATCH_MARKER) ||
			markerLineEquals(line, ABORT_MARKER)
		);
	}
}

/** Split LF/CRLF text without retaining a terminal empty sentinel. */
export function splitHashlineLines(text: string): string[] {
	if (text === "") return [""];
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

/** Parse a positive bare line-number anchor. */
export function parseLid(raw: string, lineNum: number): Anchor {
	const value = raw.trim();
	if (!validLineNumber(value)) {
		throw new Error(
			`line ${lineNum}: expected a line number such as ${describeAnchorExamples("119")}; got ${jsonQuote(raw)}. Use [PATH#hash] from your latest read for file-version binding.`,
		);
	}
	return { line: Number.parseInt(value, 10) };
}

/** Whether text is a complete operation header. */
export function isHunkHeaderText(text: string): boolean {
	const lead = text.trimStart();
	const hasKeyword = [HL_PUT_KEYWORD, HL_CUT_KEYWORD, HL_REM_KEYWORD, HL_MOVE_KEYWORD].some((k) => lead.startsWith(k));
	return hasKeyword && parseHunkHeader(text) !== undefined;
}

export function containsRecognizableHashlineOperations(input: string): boolean {
	const tokenizer = new Tokenizer();
	return input.split("\n").some((line) => tokenizer.isOp(line.replace(/\r$/, "")));
}

function markerLineEquals(line: string, marker: string): boolean {
	return line.trimEnd() === marker;
}

function validLineNumber(raw: string): boolean {
	return (
		raw !== "" && !raw.startsWith("0") && /^\d+$/.test(raw) && Number.parseInt(raw, 10) <= Number.MAX_SAFE_INTEGER
	);
}

function parseNumberPrefix(raw: string): { value: number; used: number } | undefined {
	if (raw.length === 0 || !/[1-9]/.test(raw[0])) return undefined;
	let end = 1;
	while (end < raw.length && /[0-9]/.test(raw[end])) end += 1;
	const value = Number.parseInt(raw.slice(0, end), 10);
	if (Number.isNaN(value)) return undefined;
	return { value, used: end };
}

interface ParsedRangeResult {
	range: ParsedRange;
	used: number;
	hadSeparator: boolean;
}

function parseRange(raw: string, allowSingle: boolean): ParsedRangeResult | undefined {
	const leading = raw.length - raw.trimStart().length;
	const start = parseNumberPrefix(raw.slice(leading));
	if (start === undefined) return undefined;
	let cursor = leading + start.used;
	let sawNonWs = false;
	while (cursor < raw.length) {
		const ch = raw[cursor];
		if (/\s/.test(ch) || ch === "-" || ch === "." || ch === "=" || ch === "…") {
			if (!/\s/.test(ch)) sawNonWs = true;
			cursor += 1;
		} else {
			break;
		}
	}
	const end = parseNumberPrefix(raw.slice(cursor));
	if (end !== undefined) {
		cursor += end.used;
		while (cursor < raw.length && /\s/.test(raw[cursor])) cursor += 1;
		return {
			range: { start: { line: start.value }, end: { line: end.value } },
			used: cursor,
			hadSeparator: true,
		};
	}
	if (!allowSingle) return undefined;
	if (sawNonWs && (cursor === raw.length || raw[cursor] === ":" || raw[cursor] === "@")) {
		return { range: { start: { line: start.value }, end: { line: start.value } }, used: cursor, hadSeparator: true };
	}
	return { range: { start: { line: start.value }, end: { line: start.value } }, used: cursor, hadSeparator: false };
}

function parseRegisterAndColon(
	raw: string,
	target: BlockTarget,
): { target: BlockTarget; hadColon: boolean } | undefined {
	let rest = raw.trimStart();
	if (rest.startsWith("@")) {
		const registerRaw = rest.slice(1);
		let nameLen = 0;
		while (nameLen < registerRaw.length && /[A-Za-z0-9_-]/.test(registerRaw[nameLen])) nameLen += 1;
		if (nameLen === 0 || nameLen > 64) return undefined;
		target = withRegister(target, registerRaw.slice(0, nameLen));
		rest = registerRaw.slice(nameLen).trimStart();
	}
	const hadColon = rest.startsWith(":");
	if (hadColon) rest = rest.slice(1).trimStart();
	if (rest === "") return { target, hadColon };
	return undefined;
}

function withRegister(target: BlockTarget, register: string | undefined): BlockTarget {
	switch (target.kind) {
		case "replace":
			return { kind: "replace", range: target.range, register };
		case "block":
			return { kind: "block", anchor: target.anchor, register };
		case "insertBefore":
			return { kind: "insertBefore", anchor: target.anchor, register };
		case "insertAfter":
			return { kind: "insertAfter", anchor: target.anchor, register };
		case "insertAfterBlock":
			return { kind: "insertAfterBlock", anchor: target.anchor, register };
		case "cut":
			return { kind: "cut", range: target.range, register };
		case "cutBlock":
			return { kind: "cutBlock", anchor: target.anchor, register };
		case "bof":
			return { kind: "bof", register };
		case "eof":
			return { kind: "eof", register };
		default:
			return target;
	}
}

function parsePutTarget(raw: string): { target: BlockTarget; hadColon: boolean } | undefined {
	const rest = raw.trimStart();
	if (rest.startsWith(">")) {
		const after = rest.slice(1).trimStart();
		if (after.startsWith("$")) return parseRegisterAndColon(after.slice(1), { kind: "eof", register: undefined });
		const line = parseNumberPrefix(after);
		if (line === undefined) return undefined;
		let tail = after.slice(line.used);
		const block = tail.startsWith("*");
		if (block) tail = tail.slice(1);
		const target: BlockTarget = block
			? { kind: "insertAfterBlock", anchor: { line: line.value }, register: undefined }
			: { kind: "insertAfter", anchor: { line: line.value }, register: undefined };
		return parseRegisterAndColon(tail, target);
	}
	if (rest.startsWith("<")) {
		const after = rest.slice(1).trimStart();
		const line = parseNumberPrefix(after);
		if (line === undefined) return undefined;
		let tail = after.slice(line.used);
		if (tail.startsWith("*")) tail = tail.slice(1);
		const target: BlockTarget =
			line.value === 1
				? { kind: "bof", register: undefined }
				: { kind: "insertBefore", anchor: { line: line.value }, register: undefined };
		return parseRegisterAndColon(tail, target);
	}
	const range = parseRange(rest, true);
	if (range === undefined) return undefined;
	let tail = rest.slice(range.used);
	if (tail.startsWith("*")) {
		if (range.hadSeparator) return undefined;
		tail = tail.slice(1);
		return parseRegisterAndColon(tail, { kind: "block", anchor: range.range.start, register: undefined });
	}
	return parseRegisterAndColon(tail, { kind: "replace", range: range.range, register: undefined });
}

function parseCutTarget(raw: string): { target: BlockTarget; hadColon: boolean } | undefined {
	const rest = raw.trimStart();
	const range = parseRange(rest, true);
	if (range === undefined) return undefined;
	let tail = rest.slice(range.used);
	if (tail.startsWith("*")) {
		if (range.hadSeparator) return undefined;
		tail = tail.slice(1);
		return parseRegisterAndColon(tail, { kind: "cutBlock", anchor: range.range.start, register: undefined });
	}
	return parseRegisterAndColon(tail, { kind: "cut", range: range.range, register: undefined });
}

function keywordTail(line: string, keyword: string): string | undefined {
	if (!line.startsWith(keyword)) return undefined;
	const rest = line.slice(keyword.length);
	if (rest === "" || rest.startsWith(":") || /\s/.test(rest[0])) return rest;
	return undefined;
}

export function parseHunkHeader(line: string): { target: BlockTarget; hadColon: boolean } | undefined {
	const trimmed = line.trim();
	const rem = keywordTail(trimmed, HL_REM_KEYWORD);
	if (rem !== undefined) return rem.trim() === "" ? { target: { kind: "rem" }, hadColon: false } : undefined;
	const move = keywordTail(trimmed, HL_MOVE_KEYWORD);
	if (move !== undefined) {
		const dest = unquotePath(move.trim());
		return dest !== undefined && dest !== "" ? { target: { kind: "move", dest }, hadColon: false } : undefined;
	}
	const put = keywordTail(trimmed, HL_PUT_KEYWORD);
	if (put !== undefined) return parsePutTarget(put);
	const cut = keywordTail(trimmed, HL_CUT_KEYWORD);
	if (cut !== undefined) return parseCutTarget(cut);
	return undefined;
}

function unquotePath(raw: string): string | undefined {
	if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
		return raw.slice(1, -1);
	}
	if (raw.startsWith('"') || raw.startsWith("'")) return undefined;
	return raw;
}

/** Whether a header path closes a bracket it never opened. */
export function headerPathHasOrphanBracket(path: string): boolean {
	let depth = 0;
	for (const ch of path) {
		if (ch === "[") depth += 1;
		else if (ch === "]") {
			if (depth === 0) return true;
			depth -= 1;
		}
	}
	return false;
}

/** Split a `[PATH]` / `[PATH#TAG]` header row. */
function parseHeader(line: string): { path: string; file_hash: string | undefined } | undefined {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX) || !trimmed.endsWith(HL_FILE_SUFFIX)) return undefined;
	const body = trimmed.slice(1, -1);
	if (body === "") return undefined;
	const sep = body.lastIndexOf(HL_FILE_HASH_SEP);
	if (sep !== -1) {
		const path = body.slice(0, sep);
		const hash = body.slice(sep + 1);
		if (
			path === "" ||
			headerPathHasOrphanBracket(path) ||
			hash.length !== HL_FILE_HASH_LENGTH ||
			!/^[0-9a-fA-F]{4}$/.test(hash)
		) {
			return undefined;
		}
		return { path, file_hash: hash.toUpperCase() };
	}
	if (headerPathHasOrphanBracket(body)) return undefined;
	return { path: body, file_hash: undefined };
}

function classifyLine(line: string, lineNum: number): Token {
	if (line === "") return { kind: "blank", line_num: lineNum };
	if (markerLineEquals(line, BEGIN_PATCH_MARKER)) return { kind: "envelopeBegin", line_num: lineNum };
	if (markerLineEquals(line, END_PATCH_MARKER)) return { kind: "envelopeEnd", line_num: lineNum };
	if (markerLineEquals(line, ABORT_MARKER)) return { kind: "abort", line_num: lineNum };
	const header = parseHeader(line);
	if (header !== undefined) return { kind: "header", line_num: lineNum, ...header };
	const hunk = parseHunkHeader(line);
	if (hunk !== undefined) {
		return { kind: "opBlock", line_num: lineNum, target: hunk.target, had_colon: hunk.hadColon };
	}
	if (line.startsWith("+")) return { kind: "payloadLiteral", line_num: lineNum, text: line.slice(1) };
	return { kind: "raw", line_num: lineNum, text: line };
}
