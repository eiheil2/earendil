/** Section staging: prepare/commit split. */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { applyEdits } from "./apply.ts";
import { hasBlockEdit, nativeBlockResolver, resolveBlockEdits } from "./block.ts";
import { validateClipboardSequence } from "./clipboard.ts";
import { fileHash, payloadHash } from "./hash.ts";
import type { Patch, PatchSection } from "./input.ts";
import {
	HEADTAIL_DRIFT_WARNING,
	missingSnapshotTagMessage,
	pathRecoveredFromTagMessage,
	type RevealedLine,
	type UnseenLinesReveal,
	unseenLinesMessage,
} from "./messages.ts";
import { mismatchError } from "./mismatch.ts";
import { ParseFailure } from "./parser.ts";
import { tryRecover } from "./recovery.ts";
import type { EditStore } from "./store.ts";
import type { Clipboard, Edit } from "./types.ts";

export const SEEN_LINE_REVEAL_CAP = 40;
export const SEEN_LINE_REVEAL_MAX_COLUMNS = 512;

/** A parsed section ready to be applied. */
export interface PreparedSection {
	parsed: ReturnType<PatchSection["parse"]>;
	path: string;
	absolute: string;
	text: string;
}

function hasAnchorScopedEdit(edits: Edit[]): boolean {
	return edits.some((edit) => {
		if (edit.type === "delete" || edit.type === "block" || edit.type === "cut") return true;
		if (edit.type === "paste") {
			if (edit.at.kind === "span") return true;
			const cursor = edit.at.cursor;
			return cursor.kind === "before" || cursor.kind === "after";
		}
		if (edit.type === "insert") return edit.cursor.kind === "before" || edit.cursor.kind === "after";
		return false;
	});
}

function mismatch(
	section: PatchSection,
	canonical: string,
	normalized: string,
	expected: string,
	store: EditStore,
): Error {
	const actual = fileHash(normalized);
	store.record(canonical, normalized, undefined);
	const tagOriginPaths = store
		.findByHash(expected)
		.map((snapshot) => snapshot.path)
		.filter((path) => path !== canonical);
	return mismatchError({
		path: section.path,
		expected_file_hash: expected,
		actual_file_hash: actual,
		file_lines: normalized.split("\n"),
		anchor_lines: section.collectAnchorLines(),
		hash_recognized: store.byHash(canonical, expected) !== undefined,
		tag_origin_paths: tagOriginPaths,
	});
}

function assertSeenLines(
	section: PatchSection,
	expected: string,
	canonical: string,
	store: EditStore,
	text: string,
): void {
	const snapshot = store.byContent(canonical, text);
	if (snapshot?.seen_lines === undefined || snapshot.seen_lines.size === 0) return;
	const seen = snapshot.seen_lines;
	const unseen = section.collectAnchorLines().filter((line) => !seen.has(line));
	if (unseen.length === 0) return;
	const source = snapshot.text.split("\n");
	const revealed: RevealedLine[] = [];
	let columnTruncated = false;
	for (const line of unseen.slice(0, SEEN_LINE_REVEAL_CAP)) {
		const value = source[line - 1];
		if (value === undefined) continue;
		if (value.length > SEEN_LINE_REVEAL_MAX_COLUMNS) {
			revealed.push({ line, text: `${value.slice(0, SEEN_LINE_REVEAL_MAX_COLUMNS)}…` });
			columnTruncated = true;
		} else {
			revealed.push({ line, text: value });
		}
	}
	const truncated = unseen.length > revealed.length || columnTruncated;
	if (!truncated) {
		store.recordSeenLines(
			canonical,
			expected,
			revealed.map((item) => item.line),
		);
	}
	throw new Error(
		unseenLinesMessage(section.path, unseen, expected, { lines: revealed, truncated } as UnseenLinesReveal),
	);
}

export function applyWithRecovery(
	section: PatchSection,
	canonical: string,
	normalized: string,
	edits: Edit[],
	clipboard: Clipboard,
	store: EditStore,
	enforceSeenLines: boolean,
): {
	text: string;
	first_changed_line: number | undefined;
	warnings: string[];
	block_resolutions: import("./types.ts").BlockResolution[];
} {
	const expected = section.file_hash ?? "";
	const liveMatches = fileHash(normalized).toUpperCase() === expected.toUpperCase();
	const stored = store.byHash(canonical, expected);
	const blockResolutions: import("./types.ts").BlockResolution[] = [];
	const resolveWarnings: string[] = [];
	let resolved: Edit[];
	if (hasBlockEdit(edits)) {
		const base = liveMatches ? normalized : stored?.text;
		if (base === undefined) throw mismatch(section, canonical, normalized, expected, store);
		resolved = resolveBlockEdits(
			edits,
			base,
			canonical,
			"throw",
			(resolution) => blockResolutions.push(resolution),
			(warning) => resolveWarnings.push(warning),
		);
	} else {
		resolved = [...edits];
	}
	validateClipboardSequence(resolved, clipboard);
	if (liveMatches) {
		if (enforceSeenLines) assertSeenLines(section, expected, canonical, store, normalized);
		const result = applyEdits(normalized, resolved, {
			clipboard,
			path: canonical,
			onEmptyPaste: "throw",
		});
		result.block_resolutions = blockResolutions;
		return {
			text: result.text,
			first_changed_line: result.first_changed_line,
			warnings: [...resolveWarnings, ...result.warnings],
			block_resolutions: blockResolutions,
		};
	}
	if (!hasAnchorScopedEdit(resolved)) {
		const result = applyEdits(normalized, resolved, {
			clipboard,
			path: canonical,
			onEmptyPaste: "throw",
		});
		return {
			text: result.text,
			first_changed_line: result.first_changed_line,
			warnings: [HEADTAIL_DRIFT_WARNING, ...resolveWarnings, ...result.warnings],
			block_resolutions: [],
		};
	}
	const recovered = tryRecover(store, {
		path: canonical,
		current_text: normalized,
		file_hash: expected,
		edits: resolved,
		clipboard,
	});
	if (recovered !== undefined) {
		return {
			text: recovered.text,
			first_changed_line: recovered.first_changed_line,
			warnings: [...resolveWarnings, ...recovered.warnings],
			block_resolutions: [],
		};
	}
	throw mismatch(section, canonical, normalized, expected, store);
}

export interface StagedSection {
	section: PatchSection;
	path: string;
	op: "update" | "delete" | "move" | "noop";
	text: string;
	warnings: string[];
	moveTo: string | undefined;
	/** True when the on-disk file carried a UTF-8 BOM that must be restored on write. */
	bom: boolean;
}

/** Error raised when a section's tag does not match the file. */
export function stagePatch(
	patch: Patch,
	store: EditStore,
	cwd: string,
	rawInput: string,
	enforceSeenLines: boolean,
): { staged: StagedSection[]; clipboard: Clipboard } {
	const clipboard = store.startClipboardBatch();
	const staged: StagedSection[] = [];
	const canonicalPaths = new Map<string, string>();
	for (const original of patch.sections) {
		const parsed = original.parse();
		const tag = original.file_hash;
		if (tag === undefined) {
			throw new Error(missingSnapshotTagMessage(original.path));
		}
		const absolute = path.isAbsolute(original.path) ? original.path : path.resolve(cwd, original.path);
		const resolvedPath = recoverTargetPath(absolute, store, tag);
		const recoveredWarning =
			resolvedPath !== absolute ? [pathRecoveredFromTagMessage(original.path, resolvedPath, tag)] : [];
		const undecodableDelete = parsed.file_op?.kind === "rem";
		let read: string;
		let bom = false;
		try {
			const raw = readFileSync(resolvedPath, "utf8");
			bom = raw.startsWith("\uFEFF");
			read = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
		} catch {
			if (undecodableDelete && existsSync(resolvedPath)) {
				staged.push({
					section: original,
					path: original.path,
					op: "delete",
					text: "",
					warnings: [...parsed.warnings, ...recoveredWarning],
					moveTo: undefined,
					bom: false,
				});
				continue;
			}
			throw new Error(`File not found: ${original.path}. Use the write tool to create new files.`);
		}
		const canonical = resolvedPath;
		// Seed the snapshot store as a `read` would, so a tag from an earlier
		// read resolves to its version (or fails the same way a stale tag must).
		store.record(canonical, read, undefined);
		const previous = canonicalPaths.get(canonical);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${original.path}). Merge their ops under one header before applying.`,
			);
		}
		canonicalPaths.set(canonical, original.path);
		if (parsed.file_op?.kind === "move") {
			const destination = path.isAbsolute(parsed.file_op.dest)
				? parsed.file_op.dest
				: path.resolve(cwd, parsed.file_op.dest);
			if (destination === canonical) {
				throw new Error(`MV destination is the same as ${original.path}.`);
			}
		}
		const edits = parsed.file_op?.kind === "rem" ? [] : parsed.edits;
		const apply = applyWithRecovery(original, canonical, read, edits, clipboard, store, enforceSeenLines);
		const warnings = [...parsed.warnings, ...recoveredWarning, ...apply.warnings];
		if (parsed.file_op?.kind === "rem") {
			staged.push({
				section: original,
				path: original.path,
				op: "delete",
				text: "",
				warnings,
				moveTo: undefined,
				bom,
			});
			continue;
		}
		if (parsed.file_op?.kind === "move") {
			const moveTo = path.isAbsolute(parsed.file_op.dest)
				? parsed.file_op.dest
				: path.resolve(cwd, parsed.file_op.dest);
			staged.push({ section: original, path: original.path, op: "move", text: apply.text, warnings, moveTo, bom });
			continue;
		}
		const noop = apply.text === read;
		if (noop && patch.sections.length === 1) {
			const [count, escalate] = store.recordNoop(canonical, payloadHash(rawInput));
			if (escalate) {
				throw new Error(noChangeLoopDiagnostic(original.path, count));
			}
			staged.push({
				section: original,
				path: original.path,
				op: "noop",
				text: apply.text,
				warnings,
				moveTo: undefined,
				bom,
			});
			continue;
		}
		staged.push({
			section: original,
			path: original.path,
			op: "update",
			text: apply.text,
			warnings,
			moveTo: undefined,
			bom,
		});
	}
	if (staged.length > 1) {
		const noopItem = staged.find((item) => item.op === "noop");
		if (noopItem !== undefined) {
			const canonical = path.resolve(cwd, noopItem.path);
			const [count, escalateNow] = store.recordNoop(canonical, payloadHash(rawInput));
			throw new Error(
				escalateNow
					? noChangeLoopDiagnostic(noopItem.section.path, count)
					: noChangeDiagnostic(noopItem.section.path),
			);
		}
	}
	return { staged, clipboard };
}

function recoverTargetPath(absolute: string, store: EditStore, tag: string): string {
	if (existsSync(absolute)) return absolute;
	const candidates = store
		.findByHash(tag)
		.map((snapshot) => snapshot.path)
		.filter((candidate) => {
			return path.basename(candidate) === path.basename(absolute) && candidate !== absolute;
		});
	const unique = [...new Set(candidates)].sort();
	if (unique.length === 1 && existsSync(unique[0])) return unique[0];
	return absolute;
}

/** Diagnostic for a clean, byte-identical hashline apply. */
export function noChangeDiagnostic(path: string): string {
	return `Edits to ${path} parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else �?re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.`;
}

/** Escalated diagnostic for a repeated identical no-op payload. */
export function noChangeLoopDiagnostic(path: string, count: number): string {
	return `STOP. Edits to ${path} have been a byte-identical no-op ${count} times in a row �?the patch body matches the file at the targeted lines and the soft hint did not break the cycle. Cease re-issuing this payload. Either the intended change is already on disk (move on), or your anchor is wrong (re-read the file with \`read\` to observe the current line numbers and tag, then author a different edit). This exact payload will keep being rejected until it changes.`;
}

export { ParseFailure, nativeBlockResolver };
export type { Clipboard };
