/** Block-op resolution via a (currently unwired) tree-sitter resolver. */

import { STRUCTURAL_CLOSER_RE } from "./apply.ts";
import {
	type AbsoluteRangeOp,
	type BlockDiagnosticSuggestions,
	type BlockOp,
	blockSingleLineMessage,
	blockUnresolvedMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	pasteAfterBlockCloserLoweredWarning,
	pasteAfterBlockUnresolvedLoweredWarning,
} from "./messages.ts";
import type { BlockResolution, BlockSpan, Edit } from "./types.ts";

export type Unresolved = "throw" | "drop";

/** Whether an edit stream contains a deferred block operation. */
export function hasBlockEdit(edits: Edit[]): boolean {
	return edits.some((edit) => edit.type === "block");
}

function blockMode(mode: "insertAfter" | "cut" | "pasteAfter" | undefined): {
	op: BlockOp;
	kind: BlockResolution["op"];
} {
	switch (mode) {
		case undefined:
			return { op: "replace", kind: "replace" };
		case "insertAfter":
			return { op: "insertAfter", kind: "insertAfter" };
		case "cut":
			return { op: "cut", kind: "cut" };
		case "pasteAfter":
			return { op: "pasteAfter", kind: "pasteAfter" };
	}
}

const BLOCK_SUGGESTION_SCAN_LIMIT = 64;

/**
 * Resolve the enclosing syntax block at a 1-indexed line.
 *
 * The OMP engine resolves this with tree-sitter (`pi_ast::block_range_at`).
 * Unified pi ships no tree-sitter runtime, so the resolver currently always
 * returns `undefined`; block locators then take their lowered/unresolved
 * fallback paths. Wire a real resolver here when one lands.
 */
export function nativeBlockResolver(_path: string, _text: string, _line: number): BlockSpan | undefined {
	return undefined;
}

function findNextBlock(anchorLine: number, lines: string[], path: string, text: string): BlockSpan | undefined {
	const last = Math.min(lines.length, anchorLine + BLOCK_SUGGESTION_SCAN_LIMIT);
	for (let line = anchorLine + 1; line <= last; line += 1) {
		const value = lines[line - 1];
		if (value === undefined || value.trim() === "") continue;
		const span = nativeBlockResolver(path, text, line);
		if (span !== undefined && span.start === line && span.end > line) return span;
	}
	return undefined;
}

function findEnclosingBlock(anchorLine: number, lines: string[], path: string, text: string): BlockSpan | undefined {
	const first = Math.max(anchorLine - BLOCK_SUGGESTION_SCAN_LIMIT, 1);
	for (let line = anchorLine - 1; line >= first; line -= 1) {
		const value = lines[line - 1];
		if (value === undefined || value.trim() === "") continue;
		const span = nativeBlockResolver(path, text, line);
		if (span !== undefined && span.start === line && span.end >= anchorLine && span.end > line) {
			return span;
		}
	}
	return undefined;
}

/** Resolve deferred block operations to ordinary edits. */
export function resolveBlockEdits(
	edits: Edit[],
	text: string,
	path: string,
	onUnresolved: Unresolved,
	onResolved: (resolution: BlockResolution) => void,
	onWarning: (warning: string) => void,
): Edit[] {
	if (!hasBlockEdit(edits)) return [...edits];
	const lines = text.split("\n");
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.type !== "block") {
			resolved.push(edit);
			continue;
		}
		const { register, anchor, payloads, mode, line_num } = edit;
		const { op: messageOp, kind: resultKind } = blockMode(mode);
		const span = nativeBlockResolver(path, text, anchor.line);
		if (span === undefined) {
			if (mode === "insertAfter" || mode === "pasteAfter") {
				const anchorText = lines[anchor.line - 1];
				const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
				if (mode === "pasteAfter") {
					onWarning(
						isCloser
							? pasteAfterBlockCloserLoweredWarning(anchor.line)
							: pasteAfterBlockUnresolvedLoweredWarning(anchor.line),
					);
					resolved.push({
						type: "paste",
						at: { kind: "gap", cursor: { kind: "after", anchor: { ...anchor } } },
						register,
						line_num,
						index: synthIndex,
						block_start: undefined,
					});
					synthIndex += 1;
				} else {
					onWarning(
						isCloser
							? insertAfterBlockCloserLoweredWarning(anchor.line)
							: insertAfterBlockUnresolvedLoweredWarning(anchor.line),
					);
					for (const payload of payloads) {
						resolved.push({
							type: "insert",
							cursor: { kind: "after", anchor: { ...anchor } },
							text: payload,
							line_num,
							index: synthIndex,
							replacement: false,
							block_start: undefined,
						});
						synthIndex += 1;
					}
				}
				continue;
			}
			if (onUnresolved === "drop") continue;
			const anchorText = lines[anchor.line - 1];
			const next =
				anchorText !== undefined && anchorText.trim() === ""
					? findNextBlock(anchor.line, lines, path, text)
					: undefined;
			const enclosing = next === undefined ? findEnclosingBlock(anchor.line, lines, path, text) : undefined;
			const suggestions: BlockDiagnosticSuggestions = { next_block: next, enclosing_block: enclosing };
			const rangeOp: AbsoluteRangeOp = messageOp === "cut" ? "cut" : "replace";
			throw new Error(
				`line ${line_num}: ${blockUnresolvedMessage(anchor.line, rangeOp, lines, suggestions, register)}`,
			);
		}
		if (span.start === span.end) {
			if (onUnresolved === "drop") continue;
			const enclosing = findEnclosingBlock(anchor.line, lines, path, text);
			throw new Error(`line ${line_num}: ${blockSingleLineMessage(anchor.line, messageOp, enclosing)}`);
		}
		onResolved({ anchor_line: anchor.line, start: span.start, end: span.end, op: resultKind });
		switch (mode) {
			case "pasteAfter":
				resolved.push({
					type: "paste",
					at: { kind: "gap", cursor: { kind: "after", anchor: { line: span.end } } },
					register,
					line_num,
					index: synthIndex,
					block_start: span.start,
				});
				synthIndex += 1;
				break;
			case "cut":
				resolved.push({
					type: "cut",
					range: { start: { line: span.start }, end: { line: span.end } },
					register,
					line_num,
					index: synthIndex,
				});
				synthIndex += 1;
				for (let line = span.start; line <= span.end; line += 1) {
					resolved.push({
						type: "delete",
						anchor: { line },
						line_num,
						index: synthIndex,
						old_assertion: undefined,
					});
					synthIndex += 1;
				}
				break;
			case "insertAfter":
				for (const payload of payloads) {
					resolved.push({
						type: "insert",
						cursor: { kind: "after", anchor: { line: span.end } },
						text: payload,
						line_num,
						index: synthIndex,
						replacement: false,
						block_start: span.start,
					});
					synthIndex += 1;
				}
				break;
			case undefined:
				if (register !== undefined) {
					resolved.push({
						type: "paste",
						at: { kind: "span", range: { start: { line: span.start }, end: { line: span.end } } },
						register,
						line_num,
						index: synthIndex,
						block_start: undefined,
					});
					synthIndex += 1;
				} else {
					for (const payload of payloads) {
						resolved.push({
							type: "insert",
							cursor: { kind: "before", anchor: { line: span.start } },
							text: payload,
							line_num,
							index: synthIndex,
							replacement: true,
							block_start: undefined,
						});
						synthIndex += 1;
					}
					for (let line = span.start; line <= span.end; line += 1) {
						resolved.push({
							type: "delete",
							anchor: { line },
							line_num,
							index: synthIndex,
							old_assertion: undefined,
						});
						synthIndex += 1;
					}
				}
				break;
		}
	}
	return resolved;
}
