/** Edit application with boundary repair. */

import { type EmptyPaste, resolveClipboardEdits } from "./clipboard.ts";
import {
	afterInsertLandingShiftWarning,
	afterInsertOpenerEscapeWarning,
	ambiguousBoundaryEchoMessage,
	ambiguousBoundaryPlacementMessage,
	type BoundarySide,
	blockInsertLandingShiftWarning,
	boundaryVariantRepairWarning,
	editBrokeParseWarning,
	REPLACEMENT_INDENT_AUTO_SHIFT_WARNING,
	textualBoundaryEchoWarning,
	UNRESOLVED_BLOCK_INTERNAL,
	UNRESOLVED_CLIPBOARD_INTERNAL,
} from "./messages.ts";
import { enclosingBoundaries, nodeChain, parsesCleanly } from "./syntax.ts";
import type { Anchor, ApplyResult, BlockResolution, Clipboard, Cursor, Edit } from "./types.ts";

/** A line containing only closing delimiters and an optional trailing separator. */
export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

export interface ApplyOptions {
	/** Transactional clipboard shared across sections. */
	clipboard: Clipboard | undefined;
	/** Display path used to infer the syntax language. */
	path: string | undefined;
	/** Behavior for an empty anonymous paste. */
	onEmptyPaste: EmptyPaste;
}

function anchors(edit: Edit): Anchor[] {
	if (edit.type === "delete") return [edit.anchor];
	if (edit.type === "insert" && (edit.cursor.kind === "before" || edit.cursor.kind === "after")) {
		return [edit.cursor.anchor];
	}
	return [];
}

function withIndex(edit: Edit, index: number): Edit {
	if (edit.type === "insert") return { ...edit, index };
	if (edit.type === "delete") return { ...edit, index };
	return edit;
}

function phantomLine(lines: string[]): number | undefined {
	return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length : undefined;
}

function validateBounds(edits: Edit[], lines: string[]): void {
	for (const edit of edits) {
		for (const anchor of anchors(edit)) {
			if (anchor.line < 1 || anchor.line > lines.length) {
				throw new Error(`Line ${anchor.line} does not exist (file has ${lines.length} lines)`);
			}
		}
	}
}

interface ReplacementGroup {
	insert_indices: number[];
	delete_indices: number[];
	payload: string[];
	start: number;
	end: number;
}

function replacementGroup(edits: Edit[], start: number): ReplacementGroup | undefined {
	const first = edits[start];
	if (first === undefined || first.type !== "insert" || first.cursor.kind !== "before" || !first.replacement) {
		return undefined;
	}
	const anchorLine = first.cursor.anchor.line;
	const opLine = first.line_num;
	const insertIndices: number[] = [];
	const payload: string[] = [];
	let i = start;
	while (i < edits.length) {
		const edit = edits[i];
		if (
			edit.type === "insert" &&
			edit.cursor.kind === "before" &&
			edit.cursor.anchor.line === anchorLine &&
			edit.line_num === opLine &&
			edit.replacement
		) {
			insertIndices.push(i);
			payload.push(edit.text);
			i += 1;
		} else {
			break;
		}
	}
	const deleteIndices: number[] = [];
	let expected = anchorLine;
	while (i < edits.length) {
		const edit = edits[i];
		if (edit.type === "delete" && edit.anchor.line === expected && edit.line_num === opLine) {
			deleteIndices.push(i);
			expected += 1;
			i += 1;
		} else {
			break;
		}
	}
	if (deleteIndices.length === 0) return undefined;
	return {
		insert_indices: insertIndices,
		delete_indices: deleteIndices,
		payload,
		start: anchorLine,
		end: expected - 1,
	};
}

function leadingIndent(line: string): string {
	let end = 0;
	while (end < line.length && (line[end] === " " || line[end] === "\t")) end += 1;
	return line.slice(0, end);
}

function indentDeeper(deeper: string, shallower: string): boolean {
	return deeper.length > shallower.length && deeper.startsWith(shallower);
}

function hasContent(text: string): boolean {
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code === 9 || (code >= 10 && code <= 13) || code === 32) continue;
		return true;
	}
	return false;
}

function repairIndentation(edits: Edit[], lines: string[]): string[] {
	let repaired = false;
	let start = 0;
	while (start < edits.length) {
		const group = replacementGroup(edits, start);
		if (group === undefined) {
			start += 1;
			continue;
		}
		start = group.delete_indices[group.delete_indices.length - 1] + 1;
		if (group.payload.length !== group.delete_indices.length) continue;
		const preceding = lines[group.start - 2] ?? "";
		const sourceFirst = lines[group.start - 1] ?? "";
		const payloadFirst = group.payload[0] ?? "";
		if (
			!preceding.trimEnd().endsWith("{") ||
			!indentDeeper(leadingIndent(sourceFirst), leadingIndent(preceding)) ||
			indentDeeper(leadingIndent(payloadFirst), leadingIndent(preceding))
		) {
			continue;
		}
		let shift: string | undefined;
		let matches = 0;
		let consistent = true;
		for (let offset = 0; offset < group.payload.length; offset += 1) {
			const source = lines[group.start - 1 + offset] ?? "";
			const payload = group.payload[offset];
			if (source.trim() === "" || source.trimStart() !== payload.trimStart()) continue;
			const sourceIndent = leadingIndent(source);
			const payloadIndent = leadingIndent(payload);
			if (!sourceIndent.endsWith(payloadIndent)) {
				consistent = false;
				break;
			}
			const candidate = sourceIndent.slice(0, sourceIndent.length - payloadIndent.length);
			if (shift !== undefined && shift !== candidate) {
				consistent = false;
				break;
			}
			shift = candidate;
			matches += 1;
		}
		if (shift === undefined) continue;
		if (!consistent || shift === "" || matches < 2 || matches * 2 <= group.payload.length) continue;
		for (const index of group.insert_indices) {
			const edit = edits[index];
			if (edit.type === "insert" && edit.text.trim() !== "") {
				edit.text = shift + edit.text;
			}
		}
		repaired = true;
	}
	return repaired ? [REPLACEMENT_INDENT_AUTO_SHIFT_WARNING] : [];
}

function duplicateLeading(group: ReplacementGroup, lines: string[]): number {
	const max = Math.min(group.payload.length, group.start - 1);
	for (let count = max; count >= 1; count -= 1) {
		const sourceStart = group.start - 1 - count;
		const candidate = group.payload.slice(0, count);
		const ok = candidate.every((value, index) => value === lines[sourceStart + index]);
		if (ok && candidate.some((line) => hasContent(line))) return count;
	}
	return 0;
}

function duplicateTrailing(group: ReplacementGroup, lines: string[]): number {
	const max = Math.min(group.payload.length, lines.length - group.end);
	for (let count = max; count >= 1; count -= 1) {
		const payload = group.payload.slice(group.payload.length - count);
		const source = lines.slice(group.end, group.end + count);
		const ok = payload.every((value, index) => value === source[index]);
		if (ok && payload.some((line) => hasContent(line))) return count;
	}
	return 0;
}

function groupInserts(group: ReplacementGroup, edits: Edit[]): Edit[] {
	return group.insert_indices.map((i) => edits[i]);
}

function groupDeletes(group: ReplacementGroup, edits: Edit[]): Edit[] {
	return group.delete_indices.map((i) => edits[i]);
}

function annotationEcho(lines: string[], path: string | undefined, first: number, last: number): boolean {
	if (path === undefined) return false;
	for (let line = first; line <= last; line += 1) {
		const hasAnnotation = nodeChain(lines, path, line).some(
			(node) =>
				node.start_line === line &&
				node.end_line === line &&
				(node.kind === "attribute_item" ||
					node.kind === "inner_attribute_item" ||
					node.kind === "decorator" ||
					node.kind === "annotation" ||
					node.kind === "marker_annotation" ||
					node.kind === "attribute_list"),
		);
		if (!hasAnnotation) return false;
	}
	return true;
}

interface Ambiguity {
	start: number;
	end: number;
	side: BoundarySide;
	count: number;
}

function normalizeEchoes(
	edits: Edit[],
	lines: string[],
	path: string | undefined,
): { out: Edit[]; warnings: string[]; ambiguities: Ambiguity[] } {
	const out: Edit[] = [];
	const warnings: string[] = [];
	const ambiguities: Ambiguity[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = replacementGroup(edits, i);
		if (group === undefined) {
			out.push(withIndex(edits[i], i));
			i += 1;
			continue;
		}
		const leading = duplicateLeading(group, lines);
		const trailing = duplicateTrailing(group, lines);
		const rangeLen = group.delete_indices.length;
		let dropL = 0;
		let dropT = 0;
		if (leading > 0 && trailing > 0) {
			if (group.payload.length - (leading + trailing) === rangeLen) {
				dropL = leading;
				dropT = trailing;
			}
		} else if (leading > 0 && (rangeLen > 1 || annotationEcho(lines, path, group.start - leading, group.start - 1))) {
			if (group.payload.length - leading >= rangeLen) {
				dropL = leading;
			} else {
				ambiguities.push({ start: group.start, end: group.end, side: "leading", count: leading });
			}
		} else if (trailing > 0 && (rangeLen > 1 || annotationEcho(lines, path, group.end + 1, group.end + trailing))) {
			if (group.payload.length - trailing >= rangeLen) {
				dropT = trailing;
			} else {
				ambiguities.push({ start: group.start, end: group.end, side: "trailing", count: trailing });
			}
		}
		if (dropL > 0 || dropT > 0) {
			const inserts = groupInserts(group, edits);
			out.push(...inserts.slice(dropL, inserts.length - dropT));
			out.push(...groupDeletes(group, edits));
			warnings.push(textualBoundaryEchoWarning(group.start, dropL, dropT));
		} else {
			for (const index of [...group.insert_indices, ...group.delete_indices]) {
				out.push(withIndex(edits[index], index));
			}
		}
		i = group.delete_indices[group.delete_indices.length - 1] + 1;
	}
	return { out, warnings, ambiguities };
}

function indentColumns(line: string): number {
	let column = 0;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (ch === " ") column += 1;
		else if (ch === "\t") column += 4 - (column % 4);
		else break;
	}
	return column;
}

function nearestContent(lines: string[], start: number, step: number): string | undefined {
	let index = start;
	while (index >= 0 && index < lines.length) {
		if (hasContent(lines[index])) return lines[index];
		index += step;
	}
	return undefined;
}

function payloadEdge(payload: string[], leading: boolean): string | undefined {
	if (leading) return payload.find((line) => hasContent(line));
	for (let i = payload.length - 1; i >= 0; i -= 1) if (hasContent(payload[i])) return payload[i];
	return undefined;
}

function sourceDeleted(edits: Edit[], line: number): boolean {
	return edits.some((edit) => edit.type === "delete" && edit.anchor.line === line);
}

function effectiveTrailing(group: ReplacementGroup, edits: Edit[], lines: string[]): number {
	let line = group.end;
	let survivor = group.end + 1;
	while (
		line > group.start &&
		survivor <= lines.length &&
		!sourceDeleted(edits, survivor) &&
		lines[line - 1] === lines[survivor - 1]
	) {
		line -= 1;
		survivor += 1;
	}
	return line;
}

function essential(lines: string[], path: string, line: number, baseline: boolean): boolean {
	if (!baseline) return true;
	const without = [...lines.slice(0, line - 1), ...lines.slice(line)].join("\n");
	return !parsesCleanly(path, without);
}

interface Variant {
	edits: Edit[];
	kept: number;
	dropped: number;
}

function groupVariants(
	group: ReplacementGroup,
	edits: Edit[],
	lines: string[],
	path: string,
	baseline: boolean,
): { variants: Variant[]; ambiguous: boolean } {
	const inserts = groupInserts(group, edits);
	const deletes = groupDeletes(group, edits);
	const trailing = effectiveTrailing(group, edits, lines);
	const firstEssential = essential(lines, path, group.start, baseline);
	const lastEssential = trailing === group.start ? firstEssential : essential(lines, path, trailing, baseline);
	const innerStart = group.start + 1;
	const leadingStructure =
		baseline &&
		innerStart <= trailing &&
		enclosingBoundaries(lines, path, innerStart, trailing).includes(group.start);
	const dropJ = duplicateLeading(group, lines);
	const dropK = duplicateTrailing(group, lines);
	const leadingDrops = dropJ > 0 ? [0, dropJ] : [0];
	const trailingDrops = dropK > 0 ? [0, dropK] : [0];
	const variants: Variant[] = [];
	let ambiguous = false;
	for (const dropL of leadingDrops) {
		for (const dropT of trailingDrops) {
			const dropped = dropL + dropT;
			if (dropped >= inserts.length) continue;
			const payload = group.payload.slice(dropL, group.payload.length - dropT);
			const lead = payloadEdge(payload, true);
			const trail = payloadEdge(payload, false);
			if (lead === undefined || trail === undefined) continue;
			const first = lines[group.start - 1] ?? "";
			const last = lines[trailing - 1] ?? "";
			const plans: Array<{ before: number | undefined; after: number | undefined; kept: number }> = [
				{ before: undefined, after: undefined, kept: 0 },
			];
			if (group.start === trailing) {
				const previous = nearestContent(lines, group.start - 2, -1);
				const fits = previous === undefined || indentColumns(previous) === indentColumns(trail);
				if (firstEssential && fits && indentColumns(trail) > indentColumns(first)) {
					plans.push({ before: undefined, after: group.start, kept: 1 });
				} else if (
					baseline &&
					firstEssential &&
					indentColumns(trail) === indentColumns(first) &&
					!parsesCleanly(path, materialize(lines, [...inserts, ...deletes]).text)
				) {
					ambiguous = true;
				}
			} else {
				const next = nearestContent(lines, group.start, 1);
				const previous = nearestContent(lines, trailing - 2, -1);
				const beforeFirst = nearestContent(lines, group.start - 2, -1);
				const selectedBoundary = enclosingBoundaries(lines, path, group.start + 1, group.end).includes(group.start);
				const structuralEdge =
					STRUCTURAL_CLOSER_RE.test(first.trim()) &&
					indentColumns(first) === indentColumns(lead) &&
					indentColumns(first) === indentColumns(lines[group.end - 1] ?? "");
				const underfilled = trailing < group.end && payload.length < group.end - group.start + 1;
				const keepsLeading =
					firstEssential &&
					(leadingStructure || selectedBoundary || structuralEdge || underfilled) &&
					(next === undefined ||
						(structuralEdge
							? indentColumns(lead) >= indentColumns(first)
							: indentColumns(next) === indentColumns(lead)));
				const keepsTrailing =
					(lastEssential || underfilled) &&
					!keepsLeading &&
					indentColumns(trail) > indentColumns(last) &&
					(previous === undefined || indentColumns(previous) === indentColumns(trail));
				if (keepsLeading) plans.push({ before: group.start, after: undefined, kept: 1 });
				if (keepsTrailing) plans.push({ before: undefined, after: trailing, kept: 1 });
				if (
					baseline &&
					firstEssential &&
					beforeFirst !== undefined &&
					indentColumns(first) < indentColumns(beforeFirst) &&
					indentColumns(lead) > indentColumns(first)
				) {
					ambiguous = true;
				}
			}
			for (const plan of plans) {
				if (plan.kept === 0 && dropped === 0) continue;
				if (plan.kept > 0 && group.delete_indices.length > 1 && payload.length > group.delete_indices.length) {
					continue;
				}
				const keptInserts = inserts.slice(dropL, inserts.length - dropT).map((edit) => ({ ...edit }));
				if (plan.before !== undefined) {
					const cursor: Cursor =
						plan.before >= lines.length ? { kind: "eof" } : { kind: "before", anchor: { line: plan.before + 1 } };
					for (const edit of keptInserts) {
						if (edit.type === "insert") edit.cursor = cursor;
					}
				}
				const result = [...keptInserts];
				result.push(
					...deletes.filter(
						(edit) =>
							!(edit.type === "delete" && (edit.anchor.line === plan.before || edit.anchor.line === plan.after)),
					),
				);
				variants.push({ edits: result, kept: plan.kept, dropped });
			}
		}
	}
	variants.sort((a, b) => (a.kept !== b.kept ? a.kept - b.kept : a.dropped - b.dropped));
	return { variants, ambiguous };
}

function spliceVariants(
	edits: Edit[],
	groups: Array<{ group: ReplacementGroup; variants: Variant[] }>,
	choices: Array<number | undefined>,
): Edit[] {
	const chosen = new Map<number, Variant>();
	groups.forEach((entry, i) => {
		const choice = choices[i];
		if (choice !== undefined) chosen.set(entry.group.insert_indices[0], entry.variants[choice]);
	});
	const out: Edit[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = replacementGroup(edits, i);
		if (group === undefined) {
			out.push(withIndex(edits[i], i));
			i += 1;
			continue;
		}
		const variant = chosen.get(group.insert_indices[0]);
		if (variant !== undefined) {
			out.push(...variant.edits);
		} else {
			for (const index of [...group.insert_indices, ...group.delete_indices]) {
				out.push(withIndex(edits[index], index));
			}
		}
		i = group.delete_indices[group.delete_indices.length - 1] + 1;
	}
	return out;
}

function repairBoundaries(
	edits: Edit[],
	lines: string[],
	path: string | undefined,
	baseline: boolean,
): { edits: Edit[]; warnings: string[] } | undefined {
	if (path === undefined) return undefined;
	const groups: Array<{ group: ReplacementGroup; variants: Variant[] }> = [];
	let ambiguous: { start: number; end: number } | undefined;
	let i = 0;
	while (i < edits.length) {
		const group = replacementGroup(edits, i);
		if (group !== undefined) {
			const { variants, ambiguous: isAmbiguous } = groupVariants(group, edits, lines, path, baseline);
			if (isAmbiguous && ambiguous === undefined) ambiguous = { start: group.start, end: group.end };
			if (variants.length > 0) groups.push({ group, variants });
			i = group.delete_indices[group.delete_indices.length - 1] + 1;
		} else {
			i += 1;
		}
	}
	if (groups.length === 0) {
		if (ambiguous !== undefined) {
			throw new Error(ambiguousBoundaryPlacementMessage(ambiguous.start, ambiguous.end));
		}
		return undefined;
	}
	interface Combo {
		choices: Array<number | undefined>;
		touched: number;
		kept: number;
		dropped: number;
	}
	let combos: Combo[] = [{ choices: [], touched: 0, kept: 0, dropped: 0 }];
	for (const entry of groups) {
		const next: Combo[] = [];
		for (const combo of combos) {
			next.push({ ...combo, choices: [...combo.choices, undefined] });
			entry.variants.forEach((variant, index) => {
				next.push({
					choices: [...combo.choices, index],
					touched: combo.touched + 1,
					kept: combo.kept + variant.kept,
					dropped: combo.dropped + variant.dropped,
				});
			});
		}
		next.sort((a, b) => a.touched - b.touched || a.kept - b.kept || a.dropped - b.dropped);
		combos = next.slice(0, 512);
	}
	const authored = materialize(lines, edits).text;
	combos = combos.filter((combo) => combo.touched > 0);
	combos.sort((a, b) => a.touched - b.touched || a.kept - b.kept || a.dropped - b.dropped);
	let best: { combo: Combo; text: string } | undefined;
	for (const combo of combos) {
		if (
			best !== undefined &&
			(combo.touched > best.combo.touched ||
				(combo.touched === best.combo.touched && combo.kept > best.combo.kept) ||
				(combo.touched === best.combo.touched &&
					combo.kept === best.combo.kept &&
					combo.dropped > best.combo.dropped))
		) {
			break;
		}
		const candidate = spliceVariants(edits, groups, combo.choices);
		const text = materialize(lines, candidate).text;
		if (text === authored || !parsesCleanly(path, text)) continue;
		if (best !== undefined) {
			if (best.text !== text) {
				if (ambiguous !== undefined) {
					throw new Error(ambiguousBoundaryPlacementMessage(ambiguous.start, ambiguous.end));
				}
				return undefined;
			}
		} else {
			best = { combo, text };
		}
	}
	if (best === undefined) {
		if (ambiguous !== undefined) {
			throw new Error(ambiguousBoundaryPlacementMessage(ambiguous.start, ambiguous.end));
		}
		return undefined;
	}
	const warnings: string[] = [];
	groups.forEach((entry, i) => {
		const choice = best?.combo.choices[i];
		if (choice !== undefined) {
			const variant = entry.variants[choice];
			warnings.push(boundaryVariantRepairWarning(entry.group.start, variant.kept, variant.dropped));
		}
	});
	return { edits: spliceVariants(edits, groups, best.combo.choices), warnings };
}

interface InsertGroup {
	anchor: number;
	members: number[];
	block_start: number | undefined;
}

function bodyIndent(rows: string[]): string | undefined {
	const nonBlank = rows.filter((row) => hasContent(row));
	if (nonBlank.length === 0 || nonBlank.every((row) => STRUCTURAL_CLOSER_RE.test(row))) return undefined;
	let target = leadingIndent(nonBlank[0]);
	for (const row of nonBlank) {
		const indent = leadingIndent(row);
		if (indent.startsWith(target)) {
			// keep
		} else if (target.startsWith(indent)) {
			target = indent;
		} else {
			return undefined;
		}
	}
	return target;
}

function bodyRelocatable(rows: string[], path: string): boolean {
	let last = -1;
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		if (hasContent(rows[i])) {
			last = i + 1;
			break;
		}
	}
	if (last === -1) return false;
	let line = 1;
	while (line <= last) {
		if (!hasContent(rows[line - 1])) {
			line += 1;
			continue;
		}
		const end = nodeChain(rows, path, line)
			.filter((span) => span.start_line === line)
			.map((span) => span.end_line)
			.reduce((max, value) => Math.max(max, value), 0);
		if (end === 0) return false;
		if (end >= last) return end > line;
		line = end + 1;
	}
	return false;
}

function repairLandings(edits: Edit[], lines: string[], path: string | undefined): { out: Edit[]; warnings: string[] } {
	const groups: Array<InsertGroup & { key: string }> = [];
	edits.forEach((edit, index) => {
		if (edit.type === "insert" && edit.cursor.kind === "after" && !edit.replacement) {
			const key = `${edit.cursor.anchor.line}:${edit.line_num}`;
			const existing = groups.find((group) => group.key === key);
			if (existing !== undefined) {
				existing.members.push(index);
			} else {
				groups.push({ key, anchor: edit.cursor.anchor.line, members: [index], block_start: edit.block_start });
			}
		}
	});
	const targeted = new Set<number>();
	for (const edit of edits) for (const anchor of anchors(edit)) targeted.add(anchor.line);
	const out = edits.map((edit) => ({ ...edit }));
	const warnings: string[] = [];
	for (const group of groups) {
		const rows: string[] = [];
		for (const index of group.members) {
			const edit = edits[index];
			if (edit.type === "insert") rows.push(edit.text);
		}
		const target = bodyIndent(rows);
		if (target === undefined) continue;
		const anchorText = lines[group.anchor - 1] ?? "";
		let outward: { landing: number; crossed: number } | undefined;
		if (hasContent(anchorText) && indentDeeper(leadingIndent(anchorText), target)) {
			let landing = group.anchor;
			let crossed = 0;
			let blocked = false;
			for (let line = group.anchor + 1; line <= lines.length; line += 1) {
				const text = lines[line - 1];
				if (!hasContent(text)) continue;
				if (!STRUCTURAL_CLOSER_RE.test(text) || !leadingIndent(text).startsWith(target)) break;
				if (targeted.has(line)) {
					blocked = true;
					break;
				}
				landing = line;
				crossed += 1;
				if (leadingIndent(text).length === target.length) break;
			}
			if (!blocked && landing !== group.anchor) outward = { landing, crossed };
		}
		if (outward !== undefined && path !== undefined) {
			const trial = out.map((edit) => ({ ...edit }));
			for (const index of group.members) {
				const edit = trial[index];
				if (edit.type === "insert") {
					edit.cursor = { kind: "after", anchor: { line: outward.landing } };
				}
			}
			if (
				parsesCleanly(path, materialize(lines, out).text) &&
				!parsesCleanly(path, materialize(lines, trial).text)
			) {
				outward = undefined;
			}
		}
		if (outward !== undefined) {
			for (const index of group.members) {
				const edit = out[index];
				if (edit.type === "insert") {
					edit.cursor = { kind: "after", anchor: { line: outward.landing } };
				}
			}
			warnings.push(afterInsertLandingShiftWarning(group.anchor, outward.landing, outward.crossed));
			continue;
		}
		if (group.block_start !== undefined) {
			if (STRUCTURAL_CLOSER_RE.test(anchorText) && indentDeeper(target, leadingIndent(anchorText))) {
				let landing = group.anchor;
				let blocked = false;
				for (let line = group.anchor; line >= group.block_start + 1; line -= 1) {
					const text = lines[line - 1];
					if (!hasContent(text)) {
						landing = line - 1;
						continue;
					}
					if (!STRUCTURAL_CLOSER_RE.test(text) || !indentDeeper(target, leadingIndent(text))) break;
					if (line !== group.anchor && targeted.has(line)) {
						blocked = true;
						break;
					}
					landing = line - 1;
				}
				if (!blocked && landing !== group.anchor) {
					for (const index of group.members) {
						const edit = out[index];
						if (edit.type === "insert") {
							edit.cursor = { kind: "after", anchor: { line: landing } };
						}
					}
					warnings.push(blockInsertLandingShiftWarning(group.block_start, group.anchor, landing));
				}
			}
		} else if (path !== undefined) {
			const targetCols = indentColumns(target);
			if (targetCols < indentColumns(anchorText)) {
				const chain = nodeChain(lines, path, group.anchor);
				if (
					chain.some((node) => node.start_line === group.anchor && node.end_line > group.anchor) &&
					bodyRelocatable(rows, path)
				) {
					const candidates: number[] = [];
					for (const node of chain) {
						if (node.end_line > group.anchor && indentColumns(lines[node.start_line - 1] ?? "") <= targetCols) {
							candidates.push(node.end_line);
						}
					}
					candidates.sort((a, b) => a - b);
					for (const landing of candidates) {
						let blocked = false;
						for (const line of targeted) {
							if (line > group.anchor && line <= landing) {
								blocked = true;
								break;
							}
						}
						if (blocked) break;
						const trial = out.map((edit) => ({ ...edit }));
						for (const index of group.members) {
							const edit = trial[index];
							if (edit.type === "insert") {
								edit.cursor = { kind: "after", anchor: { line: landing } };
							}
						}
						if (parsesCleanly(path, materialize(lines, trial).text)) {
							for (let i = 0; i < out.length; i += 1) out[i] = trial[i];
							warnings.push(afterInsertOpenerEscapeWarning(group.anchor, landing));
							break;
						}
					}
				}
			}
		}
	}
	return { out, warnings };
}

export function materialize(original: string[], edits: Edit[]): { text: string; first: number | undefined } {
	let lines = [...original];
	let first: number | undefined;
	const bof: string[] = [];
	const eof: string[] = [];
	const buckets = new Map<number, Array<{ index: number; edit: Edit }>>();
	edits.forEach((edit, index) => {
		if (edit.type === "insert" && edit.cursor.kind === "bof") {
			bof.push(edit.text);
			return;
		}
		if (edit.type === "insert" && edit.cursor.kind === "eof") {
			eof.push(edit.text);
			return;
		}
		if (edit.type === "insert" && (edit.cursor.kind === "before" || edit.cursor.kind === "after")) {
			const bucket = buckets.get(edit.cursor.anchor.line) ?? [];
			bucket.push({ index, edit });
			buckets.set(edit.cursor.anchor.line, bucket);
			return;
		}
		if (edit.type === "delete") {
			const bucket = buckets.get(edit.anchor.line) ?? [];
			bucket.push({ index, edit });
			buckets.set(edit.anchor.line, bucket);
		}
	});
	for (const line of [...buckets.keys()].sort((a, b) => b - a)) {
		const bucket = (buckets.get(line) as Array<{ index: number; edit: Edit }>).sort((a, b) => a.index - b.index);
		const current = lines[line - 1] ?? "";
		const before: string[] = [];
		const replacements: string[] = [];
		const after: string[] = [];
		let deleteMark = false;
		for (const { edit } of bucket) {
			if (edit.type === "insert" && edit.cursor.kind === "after") after.push(edit.text);
			else if (edit.type === "insert" && edit.replacement) replacements.push(edit.text);
			else if (edit.type === "insert") before.push(edit.text);
			else if (edit.type === "delete") deleteMark = true;
		}
		if (before.length === 0 && replacements.length === 0 && after.length === 0 && !deleteMark) continue;
		const replacement = [...before, ...replacements];
		if (!deleteMark) replacement.push(current);
		replacement.push(...after);
		lines.splice(line - 1, 1, ...replacement);
		first = first === undefined ? line : Math.min(first, line);
	}
	if (bof.length > 0) {
		if (lines.length === 1 && lines[0] === "") lines = [...bof];
		else lines.splice(0, 0, ...bof);
		first = 1;
	}
	if (eof.length > 0) {
		let at: number;
		if (lines.length === 1 && lines[0] === "") {
			lines = [...eof];
			at = 1;
		} else {
			const index = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
			lines.splice(index, 0, ...eof);
			at = index + 1;
		}
		first = first === undefined ? at : Math.min(first, at);
	}
	return { text: lines.join("\n"), first };
}

/** Apply parsed edits to LF-normalized text. */
export function applyEdits(text: string, edits: Edit[], options: ApplyOptions): ApplyResult {
	if (edits.length === 0) {
		return { text, first_changed_line: undefined, warnings: [], block_resolutions: [] };
	}
	const lines = text.split("\n");
	const localClipboard: Clipboard = { lines: undefined, named: undefined, pending_anon_cuts: undefined };
	const clipboard = options.clipboard ?? localClipboard;
	const clipboardWarnings: string[] = [];
	const concrete = resolveClipboardEdits(edits, lines, clipboard, options.onEmptyPaste, (warning) =>
		clipboardWarnings.push(warning),
	);
	const target: Edit[] = [];
	for (const edit of concrete) {
		if (edit.type === "block") throw new Error(UNRESOLVED_BLOCK_INTERNAL);
		if (edit.type === "cut" || edit.type === "paste") throw new Error(UNRESOLVED_CLIPBOARD_INTERNAL);
		target.push(edit);
	}
	const phantom = phantomLine(lines);
	if (phantom !== undefined) {
		for (let i = target.length - 1; i >= 0; i -= 1) {
			const edit = target[i];
			if (edit.type === "delete" && edit.anchor.line === phantom) target.splice(i, 1);
		}
	}
	for (let index = 0; index < target.length; index += 1) {
		target[index] = withIndex(target[index], index);
	}
	validateBounds(target, lines);
	const indentationWarnings = repairIndentation(target, lines);
	const { out: landed, warnings: landingWarnings } = repairLandings(target, lines, options.path);
	const { out: normalized, warnings: echoWarnings, ambiguities } = normalizeEchoes(landed, lines, options.path);
	const leading = [...clipboardWarnings, ...indentationWarnings, ...landingWarnings, ...echoWarnings];
	const authored = materialize(lines, normalized);
	const baseline = parsesCleanly(options.path, text);
	const authoredParses = parsesCleanly(options.path, authored.text);
	const finish = (result: { text: string; first: number | undefined }, warnings: string[]): ApplyResult => {
		if (!parsesCleanly(options.path, result.text) && baseline) {
			warnings = [...warnings, editBrokeParseWarning(result.first)];
		}
		return { text: result.text, first_changed_line: result.first, warnings, block_resolutions: [] };
	};
	if (authoredParses) {
		if (ambiguities.length > 0) {
			const ambiguity = ambiguities[0];
			throw new Error(ambiguousBoundaryEchoMessage(ambiguity.start, ambiguity.end, ambiguity.side, ambiguity.count));
		}
		return finish(authored, leading);
	}
	const repaired = repairBoundaries(normalized, lines, options.path, baseline);
	if (repaired !== undefined) {
		const result = materialize(lines, repaired.edits);
		if (parsesCleanly(options.path, result.text)) {
			return finish(result, [...leading, ...repaired.warnings]);
		}
	}
	if (ambiguities.length > 0) {
		const ambiguity = ambiguities[0];
		throw new Error(ambiguousBoundaryEchoMessage(ambiguity.start, ambiguity.end, ambiguity.side, ambiguity.count));
	}
	return finish(authored, leading);
}

export type { BlockResolution };
