/** Top-level parser for hashline file sections. */

import { hasClipboardEdit } from "./clipboard.ts";
import { HL_FILE_HASH_EXAMPLES } from "./format.ts";
import {
	ABORT_MARKER,
	BEGIN_PATCH_MARKER,
	CLIPBOARD_INTERLEAVED_SECTIONS,
	END_PATCH_MARKER,
	jsonQuote,
} from "./messages.ts";
import { type Parsed, ParseFailure, parsePatch } from "./parser.ts";
import { headerPathHasOrphanBracket, Tokenizer } from "./tokenizer.ts";
import type { Edit, FileOp } from "./types.ts";

export interface SplitOptions {
	/** Working directory used to shorten absolute header paths. */
	cwd: string | undefined;
	/** Target path used when a streaming body has no header yet. */
	path: string | undefined;
}

interface RawSection {
	path: string;
	file_hash: string | undefined;
	diff: string;
	interleaved: boolean;
}

export class PatchSection {
	path: string;
	file_hash: string | undefined;
	diff: string;
	interleaved: boolean;
	#parsed: Parsed | undefined | Error;

	constructor(path: string, fileHash: string | undefined, diff: string, interleaved = false) {
		this.path = path;
		this.file_hash = fileHash;
		this.diff = diff;
		this.interleaved = interleaved;
		this.#parsed = undefined;
	}

	static fromRaw(raw: RawSection): PatchSection {
		return new PatchSection(raw.path, raw.file_hash, raw.diff, raw.interleaved);
	}

	/** Parse and memoize this section's body. */
	parse(): Parsed {
		const cached = this.#parsed;
		if (cached instanceof Error) throw cached;
		if (cached !== undefined) return cached;
		try {
			const parsed = parsePatch(this.diff);
			if (this.interleaved && hasClipboardEdit(parsed.edits)) {
				throw new ParseFailure(CLIPBOARD_INTERLEAVED_SECTIONS);
			}
			if (parsed.file_op?.kind === "move") {
				parsed.file_op = { kind: "move", dest: normalizeHashlinePath(parsed.file_op.dest, undefined) };
			}
			this.#parsed = parsed;
			return parsed;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.#parsed = err;
			throw err;
		}
	}

	edits(): Edit[] {
		return this.parse().edits;
	}

	fileOp(): FileOp | undefined {
		return this.parse().file_op;
	}

	warnings(): string[] {
		return this.parse().warnings;
	}

	hasAnchorScopedEdit(): boolean {
		return this.edits().some(
			(edit) =>
				edit.type === "delete" ||
				edit.type === "cut" ||
				edit.type === "block" ||
				(edit.type === "paste" &&
					(edit.at.kind === "span" ||
						(edit.at.kind === "gap" && (edit.at.cursor.kind === "before" || edit.at.cursor.kind === "after")))) ||
				(edit.type === "insert" && (edit.cursor.kind === "before" || edit.cursor.kind === "after")),
		);
	}

	/** Collect concrete anchor lines in ascending order without duplicates. */
	collectAnchorLines(): number[] {
		const lines: number[] = [];
		for (const edit of this.edits()) {
			switch (edit.type) {
				case "delete":
				case "block":
					lines.push(edit.anchor.line);
					break;
				case "cut":
					for (let line = edit.range.start.line; line <= edit.range.end.line; line += 1) lines.push(line);
					break;
				case "paste":
					if (edit.at.kind === "span") {
						for (let line = edit.at.range.start.line; line <= edit.at.range.end.line; line += 1) lines.push(line);
					} else if (edit.at.cursor.kind === "before" || edit.at.cursor.kind === "after") {
						lines.push(edit.at.cursor.anchor.line);
					}
					break;
				case "insert":
					if (edit.cursor.kind === "before" || edit.cursor.kind === "after") {
						lines.push(edit.cursor.anchor.line);
					}
					break;
			}
		}
		return [...new Set(lines)].sort((a, b) => a - b);
	}

	/** Rebind this section to another path while preserving its cached parse. */
	withPath(path: string): PatchSection {
		const next = new PatchSection(path, this.file_hash, this.diff, this.interleaved);
		next.#parsed = this.#parsed;
		return next;
	}
}

export class Patch {
	sections: PatchSection[];
	constructor(sections: PatchSection[]) {
		this.sections = sections;
	}

	static parse(input: string, options: SplitOptions): Patch {
		const raw = mergeSamePathSections(splitRawSections(input, options));
		return new Patch(raw.map(PatchSection.fromRaw));
	}

	static parseSingle(input: string, options: SplitOptions): PatchSection {
		const patch = Patch.parse(input, options);
		const section = patch.sections[0];
		if (section === undefined) throw new ParseFailure("Patch input did not produce any sections.");
		return section;
	}
}

const PATH_NOISE_RE = /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;
const RECOVERY_TAG_RE = /#([0-9A-Fa-f]{4})\s*$/;
const UNIFIED_HUNK_RE = /^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/;

const ENVELOPE_MARKERS = [BEGIN_PATCH_MARKER, END_PATCH_MARKER, ABORT_MARKER];

function unquote(path: string): string {
	if (
		path.length >= 2 &&
		((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
	) {
		return path.slice(1, -1);
	}
	return path;
}

export function normalizeHashlinePath(raw: string, cwd: string | undefined): string {
	const cleaned = unquote(raw.trim()).replace(PATH_NOISE_RE, "");
	if (cwd === undefined) return cleaned;
	if (!isAbsolutePath(cleaned)) return cleaned;
	const path = lexicalNormalize(cleaned);
	const normalizedCwd = lexicalNormalize(cwd);
	if (path === normalizedCwd) return ".";
	if (path.startsWith(`${normalizedCwd}/`)) {
		const relative = path.slice(normalizedCwd.length + 1);
		return relative === "" ? "." : relative;
	}
	return cleaned;
}

function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function lexicalNormalize(path: string): string {
	const parts = path.split(/[\\/]+/);
	const out: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return (path.startsWith("/") ? "/" : "") + out.join("/");
}

function parseHeaderLine(line: string, cwd: string | undefined): RawSection | undefined {
	const trimmed = unbracketEnvelopeMarkers(line.trimEnd());
	if (!trimmed.startsWith("[")) return undefined;
	const tokenizer = new Tokenizer();
	const token = tokenizer.tokenize(trimmed, 0);
	if (token.kind === "header") {
		const path = normalizeHashlinePath(token.path, cwd);
		if (path === "") throw new ParseFailure('Input header "[]" is empty; provide a file path.');
		return { path, file_hash: token.file_hash, diff: "", interleaved: false };
	}
	const recovered = recoverHeader(trimmed, cwd);
	if (recovered !== undefined) return recovered;
	throw new ParseFailure(
		`Input header must be [PATH] or [PATH#TAG] with a 4-hex content-hash tag; got ${jsonQuote(trimmed)}.`,
	);
}

function recoverHeader(line: string, cwd: string | undefined): RawSection | undefined {
	if (!line.startsWith("[") || !line.endsWith("]")) return undefined;
	let body = line.slice(1, -1).trim();
	body = body.replace(PATH_NOISE_RE, "");
	if (body === "") return undefined;
	let pathText: string;
	let fileHash: string | undefined;
	const tagMatch = body.match(RECOVERY_TAG_RE);
	if (tagMatch !== null && tagMatch.index !== undefined) {
		pathText = body.slice(0, tagMatch.index);
		fileHash = tagMatch[1].toUpperCase();
	} else {
		pathText = body.trimEnd();
	}
	if ((fileHash === undefined && pathText.includes("#")) || headerPathHasOrphanBracket(pathText)) {
		return undefined;
	}
	const path = normalizeHashlinePath(pathText, cwd);
	return path === "" ? undefined : { path, file_hash: fileHash, diff: "", interleaved: false };
}

/** Unwrap leading bracketed `apply_patch` envelope markers from a row. */
export function unbracketEnvelopeMarkers(line: string): string {
	let rest = line;
	for (;;) {
		if (!rest.startsWith("[")) return rest;
		const inner = rest.slice(1).trimStart();
		const marker = ENVELOPE_MARKERS.find((candidate) => inner.startsWith(candidate));
		if (marker === undefined) return rest;
		let tail = inner.slice(marker.length).trimStart();
		if (tail.startsWith("]")) tail = tail.slice(1).trimStart();
		if (tail === "") return marker;
		rest = tail;
	}
}

function stripLeadingBlanks(input: string): string {
	const tokenizer = new Tokenizer();
	let lines = input.replace(/^\uFEFF/, "").split("\n");
	while (lines.length > 0) {
		const clean = unbracketEnvelopeMarkers(lines[0].replace(/\r$/, ""));
		const token = tokenizer.tokenize(clean, 0);
		if (clean.trim() === "" || token.kind === "envelopeBegin") lines = lines.slice(1);
		else break;
	}
	return lines.join("\n");
}

function splitRawSections(input: string, options: SplitOptions): RawSection[] {
	const normalized = normalizeFallback(input, options);
	const stripped = stripLeadingBlanks(normalized);
	const lines = stripped.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const first = lines[0] ?? "";
	if (parseHeaderLine(first, options.cwd) === undefined) {
		if (UNIFIED_HUNK_RE.test(first.trimEnd())) {
			throw new ParseFailure(
				"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. File sections start with `[path#HASH]`; use `replace`, `delete`, or `insert` ops.",
			);
		}
		const preview = first.slice(0, 120);
		throw new ParseFailure(
			`input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: ${jsonQuote(preview)}. Example: "[src/foo.ts#${HL_FILE_HASH_EXAMPLES[0]}]" then edit ops.`,
		);
	}
	const tokenizer = new Tokenizer();
	const sections: RawSection[] = [];
	let current: RawSection | undefined;
	let body: string[] = [];
	const flush = () => {
		if (current === undefined) {
			body = [];
			return;
		}
		if (body.some((line) => line.trim() !== "")) {
			current.diff = body.join("\n");
			sections.push(current);
		}
		current = undefined;
		body = [];
	};
	for (const line of lines) {
		const clean = unbracketEnvelopeMarkers(line.trimEnd());
		const token = tokenizer.tokenize(clean, 0);
		if (token.kind === "envelopeEnd" || token.kind === "abort") break;
		if (token.kind === "envelopeBegin") continue;
		if (clean.startsWith("[")) {
			const header = parseHeaderLine(clean, options.cwd);
			if (header !== undefined) {
				flush();
				current = header;
				continue;
			}
		}
		body.push(line);
	}
	flush();
	return sections;
}

function normalizeFallback(input: string, options: SplitOptions): string {
	const stripped = input.replace(/^\uFEFF/, "");
	for (const line of stripped.split("\n")) {
		if (parseHeaderLine(line, options.cwd) !== undefined) return input;
	}
	if (options.path === undefined) return input;
	const tokenizer = new Tokenizer();
	let recognizable = false;
	for (const line of input.split("\n")) {
		if (tokenizer.isOp(line.replace(/\r$/, ""))) {
			recognizable = true;
			break;
		}
	}
	if (!recognizable) return input;
	const path = normalizeHashlinePath(options.path, options.cwd);
	if (path === "") return input;
	return `[${path}]\n${input}`;
}

function mergeSamePathSections(sections: RawSection[]): RawSection[] {
	const result: RawSection[] = [];
	const positions = new Map<string, number>();
	let previous: string | undefined;
	for (const section of sections) {
		const index = positions.get(section.path);
		if (index !== undefined) {
			const existing = result[index];
			if (
				existing.file_hash !== undefined &&
				section.file_hash !== undefined &&
				existing.file_hash !== section.file_hash
			) {
				throw new ParseFailure(
					`Conflicting hashline snapshot tags for ${section.path}: #${existing.file_hash} and #${section.file_hash}. Re-read the file and retry with one current header.`,
				);
			}
			if (existing.file_hash === undefined) existing.file_hash = section.file_hash;
			if (previous !== section.path) existing.interleaved = true;
			existing.diff += `\n${section.diff}`;
			previous = section.path;
			continue;
		}
		positions.set(section.path, result.length);
		previous = section.path;
		result.push(section);
	}
	return result;
}
