/** Clipboard edit resolution. */

import {
	ambiguousAnonymousPasteMessage,
	EMPTY_PASTE,
	emptyRegisterPasteWarning,
	emptyRegisterSpanPasteMessage,
} from "./messages.ts";
import { beforeAnchor, type Clipboard, type Edit } from "./types.ts";

export type EmptyPaste = "throw" | "drop";

function describeCut(edit: Edit & { type: "cut" }): string {
	const span =
		edit.range.start.line === edit.range.end.line
			? `${edit.range.start.line}`
			: `${edit.range.start.line}.=${edit.range.end.line}`;
	return edit.register === undefined ? `CUT ${span}` : `CUT ${span} @${edit.register}`;
}

/** Whether an edit stream contains an operation that reads or writes a clipboard register. */
export function hasClipboardEdit(edits: Edit[]): boolean {
	return edits.some((edit) => {
		if (edit.type === "cut" || edit.type === "paste") return true;
		if (edit.type === "block") {
			return edit.mode === "cut" || edit.mode === "pasteAfter" || edit.register !== undefined;
		}
		return false;
	});
}

function knownRegisters(clipboard: Clipboard): string[] {
	const known: string[] = [];
	if (clipboard.named) for (const key of clipboard.named.keys()) known.push(key);
	return known.sort();
}

function readRegister(
	register: string | undefined,
	span: boolean,
	clipboard: Clipboard,
	lineNum: number,
	onEmptyPaste: EmptyPaste,
	onWarning: (warning: string) => void,
): string[] | "dropped" {
	if (register !== undefined) {
		const lines = clipboard.named?.get(register);
		if (lines !== undefined) return structuredClone(lines);
		if (onEmptyPaste === "drop") return "dropped";
		const known = knownRegisters(clipboard);
		if (span) throw new Error(`line ${lineNum}: ${emptyRegisterSpanPasteMessage(register, known)}`);
		onWarning(`line ${lineNum}: ${emptyRegisterPasteWarning(register, known)}`);
		return [];
	}
	const pending = clipboard.pending_anon_cuts ?? [];
	if (pending.length > 1) {
		if (onEmptyPaste === "drop") return "dropped";
		throw new Error(`line ${lineNum}: ${ambiguousAnonymousPasteMessage(pending)}`);
	}
	if (clipboard.lines === undefined) {
		if (onEmptyPaste === "drop") return "dropped";
		throw new Error(`line ${lineNum}: ${EMPTY_PASTE}`);
	}
	const lines = clipboard.lines;
	clipboard.pending_anon_cuts = [];
	return structuredClone(lines);
}

function writeRegister(edit: Edit & { type: "cut" }, fileLines: string[], clipboard: Clipboard): void {
	if (edit.range.start.line === 0 || edit.range.end.line > fileLines.length) {
		throw new Error(
			`line ${edit.line_num}: \`${describeCut(edit)}\` is out of range (file has ${fileLines.length} lines).`,
		);
	}
	const captured = fileLines.slice(edit.range.start.line - 1, edit.range.end.line);
	if (edit.register !== undefined) {
		if (!clipboard.named) clipboard.named = new Map();
		clipboard.named.set(edit.register, captured);
	} else {
		clipboard.lines = captured;
		if (!clipboard.pending_anon_cuts) clipboard.pending_anon_cuts = [];
		clipboard.pending_anon_cuts.push(describeCut(edit));
	}
}

/** Lower cut/paste operations into inserts and deletes against the original file lines. */
export function resolveClipboardEdits(
	edits: Edit[],
	fileLines: string[],
	clipboard: Clipboard,
	onEmptyPaste: EmptyPaste,
	onWarning: (warning: string) => void,
): Edit[] {
	if (!hasClipboardEdit(edits)) return [...edits];
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		switch (edit.type) {
			case "cut":
				writeRegister(edit, fileLines, clipboard);
				break;
			case "paste": {
				const lines = readRegister(
					edit.register,
					edit.at.kind === "span",
					clipboard,
					edit.line_num,
					onEmptyPaste,
					onWarning,
				);
				if (lines === "dropped") break;
				if (edit.at.kind === "gap") {
					for (const text of lines) {
						resolved.push({
							type: "insert",
							cursor: edit.at.cursor,
							text,
							line_num: edit.line_num,
							index: synthIndex,
							replacement: false,
							block_start: edit.block_start,
						});
						synthIndex += 1;
					}
				} else {
					const range = edit.at.range;
					if (range.start.line === 0 || range.end.line > fileLines.length) {
						const register = edit.register === undefined ? "" : ` @${edit.register}`;
						throw new Error(
							`line ${edit.line_num}: \`PUT ${range.start.line}.=${range.end.line}${register}\` is out of range (file has ${fileLines.length} lines).`,
						);
					}
					const cursor = beforeAnchor({ line: range.start.line });
					for (const text of lines) {
						resolved.push({
							type: "insert",
							cursor,
							text,
							line_num: edit.line_num,
							index: synthIndex,
							replacement: true,
							block_start: undefined,
						});
						synthIndex += 1;
					}
					for (let line = range.start.line; line <= range.end.line; line += 1) {
						resolved.push({
							type: "delete",
							anchor: { line },
							line_num: edit.line_num,
							index: synthIndex,
							old_assertion: undefined,
						});
						synthIndex += 1;
					}
				}
				break;
			}
			default:
				resolved.push(edit);
		}
	}
	return resolved;
}

/** Validate anonymous clipboard sequencing without mutating the supplied clipboard. */
export function validateClipboardSequence(edits: Edit[], clipboard: Clipboard): void {
	const fork: Clipboard = {
		lines: clipboard.lines ? [...clipboard.lines] : undefined,
		named: clipboard.named ? new Map([...clipboard.named].map(([k, v]) => [k, [...v]])) : undefined,
		pending_anon_cuts: clipboard.pending_anon_cuts ? [...clipboard.pending_anon_cuts] : undefined,
	};
	for (const edit of edits) {
		switch (edit.type) {
			case "cut":
				if (edit.register !== undefined) {
					if (!fork.named) fork.named = new Map();
					fork.named.set(edit.register, []);
				} else {
					fork.lines = [];
					if (!fork.pending_anon_cuts) fork.pending_anon_cuts = [];
					fork.pending_anon_cuts.push(describeCut(edit));
				}
				break;
			case "paste": {
				readRegister(edit.register, edit.at.kind === "span", fork, edit.line_num, "throw", () => {});
				break;
			}
			default:
				break;
		}
	}
}
