/** Pure data types shared across the hashline tokenizer, parser, applier, and patcher. */

/** A 1-indexed line anchor. */
export interface Anchor {
	line: number;
}

/** Where an `insert` edit lands relative to existing content. */
export type Cursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before"; anchor: Anchor }
	| { kind: "after"; anchor: Anchor };

export const CursorBof: Cursor = { kind: "bof" };
export const CursorEof: Cursor = { kind: "eof" };
export function beforeAnchor(anchor: Anchor): Cursor {
	return { kind: "before", anchor };
}
export function afterAnchor(anchor: Anchor): Cursor {
	return { kind: "after", anchor };
}

/** A parsed `A-B` inclusive line range. */
export interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

/** Where a `paste` edit lands: an insertion gap, or a span it replaces. */
export type PasteTarget = { kind: "gap"; cursor: Cursor } | { kind: "span"; range: ParsedRange };

/** Deferred block-op mode (`undefined` = block replacement). */
export type BlockMode = "insertAfter" | "cut" | "pasteAfter";

export interface InsertEdit {
	type: "insert";
	cursor: Cursor;
	text: string;
	/** 1-indexed payload line this edit came from (for messages). */
	line_num: number;
	/** Position in the section's op list. */
	index: number;
	/** True for replacement-payload inserts (vs. literal insertion). */
	replacement: boolean;
	/** Resolved block's first line for inserts lowered from `insert_after_block`; bounds landing correction. */
	block_start: number | undefined;
}

export interface DeleteEdit {
	type: "delete";
	anchor: Anchor;
	line_num: number;
	index: number;
	/** Expected old content (`-` assertion row) when the payload carried one. */
	old_assertion: string | undefined;
}

export interface CutEdit {
	type: "cut";
	range: ParsedRange;
	register: string | undefined;
	line_num: number;
	index: number;
}

export interface PasteEdit {
	type: "paste";
	at: PasteTarget;
	register: string | undefined;
	line_num: number;
	index: number;
	block_start: number | undefined;
}

export interface BlockEdit {
	type: "block";
	anchor: Anchor;
	payloads: string[];
	mode: BlockMode | undefined;
	register: string | undefined;
	line_num: number;
	index: number;
}

/** One low-level edit produced by the parser and consumed by the applier. */
export type Edit = InsertEdit | DeleteEdit | CutEdit | PasteEdit | BlockEdit;

export function editLineNum(edit: Edit): number {
	return edit.line_num;
}

export function editIndex(edit: Edit): number {
	return edit.index;
}

/** File-level operation parsed from a section body (`REM` / `MV`). */
export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

/** Which block op produced a {@link BlockResolution}. */
export type BlockOpKind = "replace" | "insertAfter" | "cut" | "pasteAfter";

/** One block-op anchor resolved to its concrete line span. */
export interface BlockResolution {
	/** The 1-indexed line the block op was anchored on (the `N`). */
	anchor_line: number;
	start: number;
	end: number;
	op: BlockOpKind;
}

/** Resolved 1-indexed inclusive line span of a block target. */
export interface BlockSpan {
	start: number;
	end: number;
}

/** Result of applying a parsed set of edits to a text body. */
export interface ApplyResult {
	text: string;
	/** 1-indexed first changed line; `undefined` for a no-op apply. */
	first_changed_line: number | undefined;
	warnings: string[];
	/** Resolved spans for each block op, in patch order (only when the apply matched the tagged content). */
	block_resolutions: BlockResolution[];
}

/** Clipboard registers threaded through one patch application. */
export interface Clipboard {
	/** Latest anonymous cut. */
	lines: string[] | undefined;
	/** Named registers, retained between batches. */
	named: Map<string, string[]> | undefined;
	/** Anonymous cuts not yet consumed. */
	pending_anon_cuts: string[] | undefined;
}

export function clipboardFork(source: Clipboard): Clipboard {
	return {
		lines: source.lines ? [...source.lines] : undefined,
		named: source.named ? new Map([...source.named].map(([k, v]) => [k, [...v]])) : undefined,
		pending_anon_cuts: source.pending_anon_cuts ? [...source.pending_anon_cuts] : undefined,
	};
}

/** Start a batch with named registers only. */
export function clipboardStartBatch(source: Clipboard): Clipboard {
	return {
		lines: undefined,
		named: source.named ? new Map([...source.named].map(([k, v]) => [k, [...v]])) : undefined,
		pending_anon_cuts: undefined,
	};
}

/** Merge named registers from a completed transaction. */
export function clipboardCommitFrom(target: Clipboard, fork: Clipboard): void {
	if (!fork.named) return;
	if (!target.named) target.named = new Map();
	for (const [key, value] of fork.named) target.named.set(key, [...value]);
}
