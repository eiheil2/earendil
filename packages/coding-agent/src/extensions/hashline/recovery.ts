/** Stale-tag anchor recovery. */

import * as Diff from "diff";
import { applyEdits } from "./apply.ts";
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING } from "./messages.ts";
import type { EditStore, Snapshot } from "./store.ts";
import { nodeChain } from "./syntax.ts";
import type { Anchor, Clipboard, Edit } from "./types.ts";

export interface RecoveryArgs {
	/** Canonical target path. */
	path: string;
	/** Current LF-normalized file text. */
	current_text: string;
	/** Requested stale snapshot tag. */
	file_hash: string;
	/** Parsed edits anchored against the stale snapshot. */
	edits: Edit[];
	/** Transactional clipboard, when the patch uses cut/paste. */
	clipboard: Clipboard | undefined;
}

export interface RecoveryResult {
	text: string;
	first_changed_line: number | undefined;
	warnings: string[];
}

function editAnchors(edit: Edit): Anchor[] {
	switch (edit.type) {
		case "delete":
		case "block":
			return [edit.anchor];
		case "cut": {
			const out: Anchor[] = [];
			for (let line = edit.range.start.line; line <= edit.range.end.line; line += 1) out.push({ line });
			return out;
		}
		case "paste": {
			if (edit.at.kind === "span") {
				const out: Anchor[] = [];
				for (let line = edit.at.range.start.line; line <= edit.at.range.end.line; line += 1) out.push({ line });
				return out;
			}
			const cursor = edit.at.cursor;
			return cursor.kind === "before" || cursor.kind === "after" ? [cursor.anchor] : [];
		}
		case "insert": {
			const cursor = edit.cursor;
			return cursor.kind === "before" || cursor.kind === "after" ? [cursor.anchor] : [];
		}
	}
}

interface LineRun {
	added: boolean;
	removed: boolean;
	count: number;
}

function lineRuns(previous: string, current: string): LineRun[] {
	const parts = Diff.diffLines(previous, current);
	const runs: LineRun[] = [];
	for (const part of parts) {
		const count = part.count ?? (part.value === "" ? 0 : part.value.replace(/\n$/, "").split("\n").length);
		if (count === 0) continue;
		runs.push({ added: part.added === true, removed: part.removed === true, count });
	}
	return runs;
}

function buildLineMap(previous: string, current: string): Map<number, number> {
	const map = new Map<number, number>();
	let previousLine = 1;
	let currentLine = 1;
	for (const run of lineRuns(previous, current)) {
		if (run.added) {
			currentLine += run.count;
		} else if (run.removed) {
			previousLine += run.count;
		} else {
			for (let offset = 0; offset < run.count; offset += 1) {
				map.set(previousLine + offset, currentLine + offset);
			}
			previousLine += run.count;
			currentLine += run.count;
		}
	}
	return map;
}

function duplicatedValues(lines: string[]): Set<string> {
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const line of lines) {
		if (seen.has(line)) duplicated.add(line);
		seen.add(line);
	}
	return duplicated;
}

interface Neighbors {
	before: number | undefined;
	after: number | undefined;
}

function anchorNeighbors(anchorLines: Set<number>, lineCount: number): Map<number, Neighbors> {
	const sorted = [...anchorLines].sort((a, b) => a - b);
	const neighbors = new Map<number, Neighbors>();
	let i = 0;
	while (i < sorted.length) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
		const start = sorted[i];
		const end = sorted[j];
		const before = start > 1 ? start - 1 : undefined;
		const after = end < lineCount ? end + 1 : undefined;
		for (let k = i; k <= j; k += 1) neighbors.set(sorted[k], { before, after });
		i = j + 1;
	}
	return neighbors;
}

function validateContext(previous: string, current: string, lineMap: Map<number, number>, edits: Edit[]): boolean {
	const previousLines = previous.split("\n");
	const currentLines = current.split("\n");
	const anchors = new Set<number>();
	for (const edit of edits) for (const anchor of editAnchors(edit)) anchors.add(anchor.line);
	const previousDuplicates = duplicatedValues(previousLines);
	const currentDuplicates = duplicatedValues(currentLines);
	for (const [line, neighbors] of anchorNeighbors(anchors, previousLines.length)) {
		const mapped = lineMap.get(line);
		if (mapped === undefined) return false;
		const previousValue = previousLines[line - 1] ?? "";
		const currentValue = currentLines[mapped - 1] ?? "";
		if (!previousDuplicates.has(previousValue) && !currentDuplicates.has(currentValue)) {
			const offset = mapped - line;
			const afterMatches =
				neighbors.after !== undefined && lineMap.get(neighbors.after) === neighbors.after + offset;
			const beforeMatches =
				neighbors.before !== undefined && lineMap.get(neighbors.before) === neighbors.before + offset;
			if (!afterMatches && !beforeMatches) return false;
		} else {
			let checked = false;
			if (neighbors.before !== undefined) {
				checked = true;
				if (lineMap.get(neighbors.before) !== mapped - (line - neighbors.before)) return false;
			}
			if (neighbors.after !== undefined) {
				checked = true;
				if (lineMap.get(neighbors.after) !== mapped + (neighbors.after - line)) return false;
			}
			if (!checked) return false;
		}
	}
	return true;
}

function mapLine(lineMap: Map<number, number>, line: number, offsets: number[]): number | undefined {
	const mapped = lineMap.get(line);
	if (mapped === undefined) return undefined;
	offsets.push(mapped - line);
	return mapped;
}

function remapEdits(previous: string, current: string, edits: Edit[]): { edits: Edit[]; offset: number } | undefined {
	const lineMap = buildLineMap(previous, current);
	if (!validateContext(previous, current, lineMap, edits)) return undefined;
	const offsets: number[] = [];
	const remapped: Edit[] = [];
	for (const edit of edits) {
		let mapped: Edit | undefined;
		switch (edit.type) {
			case "delete": {
				const line = mapLine(lineMap, edit.anchor.line, offsets);
				if (line === undefined) return undefined;
				mapped = { ...edit, anchor: { line } };
				break;
			}
			case "block": {
				const line = mapLine(lineMap, edit.anchor.line, offsets);
				if (line === undefined) return undefined;
				mapped = { ...edit, anchor: { line } };
				break;
			}
			case "cut": {
				const start = mapLine(lineMap, edit.range.start.line, offsets);
				if (start === undefined) return undefined;
				let end = start;
				for (let line = edit.range.start.line + 1; line <= edit.range.end.line; line += 1) {
					const mappedLine = mapLine(lineMap, line, offsets);
					if (mappedLine === undefined) return undefined;
					end = mappedLine;
				}
				mapped = { ...edit, range: { start: { line: start }, end: { line: end } } };
				break;
			}
			case "paste": {
				let blockStart = edit.block_start;
				if (blockStart !== undefined) {
					const mappedLine = mapLine(lineMap, blockStart, offsets);
					if (mappedLine === undefined) return undefined;
					blockStart = mappedLine;
				}
				let at = edit.at;
				if (at.kind === "span") {
					const start = mapLine(lineMap, at.range.start.line, offsets);
					if (start === undefined) return undefined;
					let end = start;
					for (let line = at.range.start.line + 1; line <= at.range.end.line; line += 1) {
						const mappedLine = mapLine(lineMap, line, offsets);
						if (mappedLine === undefined) return undefined;
						end = mappedLine;
					}
					at = { kind: "span", range: { start: { line: start }, end: { line: end } } };
				} else if (at.cursor.kind === "before") {
					const line = mapLine(lineMap, at.cursor.anchor.line, offsets);
					if (line === undefined) return undefined;
					at = { kind: "gap", cursor: { kind: "before", anchor: { line } } };
				} else if (at.cursor.kind === "after") {
					const line = mapLine(lineMap, at.cursor.anchor.line, offsets);
					if (line === undefined) return undefined;
					at = { kind: "gap", cursor: { kind: "after", anchor: { line } } };
				}
				mapped = { ...edit, at, block_start: blockStart };
				break;
			}
			case "insert": {
				let blockStart = edit.block_start;
				if (blockStart !== undefined) {
					const mappedLine = mapLine(lineMap, blockStart, offsets);
					if (mappedLine === undefined) return undefined;
					blockStart = mappedLine;
				}
				let cursor = edit.cursor;
				if (cursor.kind === "before") {
					const line = mapLine(lineMap, cursor.anchor.line, offsets);
					if (line === undefined) return undefined;
					cursor = { kind: "before", anchor: { line } };
				} else if (cursor.kind === "after") {
					const line = mapLine(lineMap, cursor.anchor.line, offsets);
					if (line === undefined) return undefined;
					cursor = { kind: "after", anchor: { line } };
				}
				mapped = { ...edit, cursor, block_start: blockStart };
				break;
			}
		}
		remapped.push(mapped);
	}
	if (offsets.length === 0) return undefined;
	const first = offsets[0];
	if (offsets.some((offset) => offset !== first)) return undefined;
	return { edits: remapped, offset: first };
}

/** Identity of the constructs enclosing `line`: each node's kind paired with the trimmed text of the row it opens. */
function enclosingContext(lines: string[], path: string, line: number): Array<[string, string]> {
	return nodeChain(lines, path, line)
		.map((span) => {
			const opener = lines[span.start_line - 1];
			return opener === undefined ? undefined : ([span.kind, opener.trim()] as [string, string]);
		})
		.filter((entry): entry is [string, string] => entry !== undefined);
}

function contextPreserved(
	previous: string,
	current: string,
	path: string,
	authored: Edit[],
	remapped: Edit[],
): boolean {
	const previousLines = previous.split("\n");
	const currentLines = current.split("\n");
	const checked = new Set<string>();
	for (let index = 0; index < authored.length; index += 1) {
		const authoredAnchors = editAnchors(authored[index]);
		const remappedAnchors = editAnchors(remapped[index]);
		const edges: Array<[Anchor | undefined, Anchor | undefined]> = [
			[authoredAnchors[0], remappedAnchors[0]],
			[authoredAnchors[authoredAnchors.length - 1], remappedAnchors[remappedAnchors.length - 1]],
		];
		for (const [authoredAnchor, remappedAnchor] of edges) {
			if (authoredAnchor === undefined || remappedAnchor === undefined) continue;
			const key = `${authoredAnchor.line}:${remappedAnchor.line}`;
			if (checked.has(key)) continue;
			checked.add(key);
			const before = enclosingContext(previousLines, path, authoredAnchor.line);
			const after = enclosingContext(currentLines, path, remappedAnchor.line);
			if (
				before.length !== after.length ||
				before.some((value, i) => value[0] !== after[i][0] || value[1] !== after[i][1])
			) {
				return false;
			}
		}
	}
	return true;
}

/** Attempt to rebase stale anchors from a retained snapshot onto current text. */
export function tryRecover(store: EditStore, args: RecoveryArgs): RecoveryResult | undefined {
	const snapshot: Snapshot | undefined = store.byHash(args.path, args.file_hash);
	if (snapshot === undefined) return undefined;
	const head = store.head(args.path);
	const warning =
		head !== undefined && head.text === snapshot.text ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
	const remapped = remapEdits(snapshot.text, args.current_text, args.edits);
	if (remapped === undefined) return undefined;
	if (!contextPreserved(snapshot.text, args.current_text, args.path, args.edits, remapped.edits)) {
		return undefined;
	}
	try {
		const applied = applyEdits(args.current_text, remapped.edits, {
			clipboard: args.clipboard,
			path: args.path,
			onEmptyPaste: "throw",
		});
		if (applied.text === args.current_text) return undefined;
		const warnings = [remapped.offset === 0 ? warning : RECOVERY_LINE_REMAP_WARNING, ...applied.warnings];
		return { text: applied.text, first_changed_line: applied.first_changed_line, warnings };
	} catch {
		return undefined;
	}
}
