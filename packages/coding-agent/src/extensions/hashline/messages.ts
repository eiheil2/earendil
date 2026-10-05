/** Centralized error/warning text for the hashline parser, applier, and patcher. */

import type { BlockSpan } from "./types.ts";

const HL_FILE_PREFIX = "[";
const HL_FILE_SUFFIX = "]";
const HL_PAYLOAD_REPLACE = "+";
const HL_PUT_KEYWORD = "PUT";
const HL_CUT_KEYWORD = "CUT";
const HL_FILE_HASH_SEP = "#";
const HL_RANGE_SEP = ".=";
const HL_LINE_BODY_SEP = ":";

function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}${HL_LINE_BODY_SEP}${line}`;
}

/** Tiny JS-compatible `JSON.stringify(str)` that escapes `"`, `\`, and control characters. */
export function jsonQuote(s: string): string {
	let out = '"';
	for (const c of s) {
		switch (c) {
			case '"':
				out += '\\"';
				break;
			case "\\":
				out += "\\\\";
				break;
			case "\n":
				out += "\\n";
				break;
			case "\r":
				out += "\\r";
				break;
			case "\t":
				out += "\\t";
				break;
			case "\b":
				out += "\\b";
				break;
			case "\f":
				out += "\\f";
				break;
			default: {
				const code = c.codePointAt(0) as number;
				if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
				else out += c;
			}
		}
	}
	return `${out}"`;
}

/** Lines of context shown either side of a hash mismatch. */
export const MISMATCH_CONTEXT = 2;

/** Numbered `LINE:TEXT` rows around `anchor_lines` (+/- MISMATCH_CONTEXT), `*`-marking anchors. */
export function formatAnchoredContext(anchorLines: number[], fileLines: string[]): string[] {
	const displayLines = new Set<number>();
	for (const line of anchorLines) {
		if (line < 1 || line > fileLines.length) continue;
		const lo = Math.max(line - MISMATCH_CONTEXT, 1);
		const hi = Math.min(line + MISMATCH_CONTEXT, fileLines.length);
		for (let n = lo; n <= hi; n += 1) displayLines.add(n);
	}
	const anchorSet = new Set(anchorLines);
	const rows: string[] = [];
	let previous: number | undefined;
	for (const lineNum of [...displayLines].sort((a, b) => a - b)) {
		if (previous !== undefined && lineNum > previous + 1) rows.push("...");
		previous = lineNum;
		const marker = anchorSet.has(lineNum) ? "*" : " ";
		rows.push(`${marker}${formatNumberedLine(lineNum, fileLines[lineNum - 1] ?? "")}`);
	}
	return rows;
}

/** Concrete range operation rejected because its absolute end precedes its start. */
export type AbsoluteRangeOp = "replace" | "cut";

function regSuffix(register: string | undefined): string {
	return register === undefined ? "" : ` @${register}`;
}

function rangeOpSingle(op: AbsoluteRangeOp, line: number, register: string | undefined): string {
	const suffix = regSuffix(register);
	if (op === "replace")
		return register === undefined ? `${HL_PUT_KEYWORD} ${line}:` : `${HL_PUT_KEYWORD} ${line}${suffix}`;
	return `${HL_CUT_KEYWORD} ${line}${suffix}`;
}

function rangeOpRange(op: AbsoluteRangeOp, start: number, end: number, register: string | undefined): string {
	const suffix = regSuffix(register);
	if (op === "replace")
		return register === undefined
			? `${HL_PUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}:`
			: `${HL_PUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}${suffix}`;
	return `${HL_CUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}${suffix}`;
}

function blockFormAt(op: AbsoluteRangeOp, line: number, register: string | undefined): string {
	const suffix = regSuffix(register);
	if (op === "replace")
		return register === undefined ? `${HL_PUT_KEYWORD} ${line}*:` : `${HL_PUT_KEYWORD} ${line}*${suffix}`;
	return `${HL_CUT_KEYWORD} ${line}*${suffix}`;
}

/** Explain absolute range endpoints and provide safe, non-applying retry forms. */
export function invalidAbsoluteRangeMessage(
	patchLine: number,
	start: number,
	end: number,
	op: AbsoluteRangeOp,
	block: BlockSpan | undefined,
	register: string | undefined,
): string {
	const single = rangeOpSingle(op, start, register);
	const countedEnd = start + end - 1;
	const counted = countedEnd >= start ? rangeOpRange(op, start, countedEnd, register) : undefined;
	const blockForm = blockFormAt(op, start, register);
	let message = `line ${patchLine}: Invalid absolute range: start ${start}, end ${end}. The value after \`${HL_RANGE_SEP}\` is an absolute source line, not a line count or replacement length. For one line use \`${single}\`.`;
	if (counted !== undefined) message += ` For ${end} lines starting at ${start}, use \`${counted}\`.`;
	if (block !== undefined && block.start === start && block.end > start) {
		message += ` The syntactic block beginning at ${start} ends at ${block.end}, so \`${blockForm}\` is also valid.`;
	}
	return message;
}

/** Optional patch envelope start marker; silently consumed. */
export const BEGIN_PATCH_MARKER = "*** Begin Patch";
/** Optional patch envelope end marker; terminates parsing. */
export const END_PATCH_MARKER = "*** End Patch";
/** Truncation sentinel emitted by an agent loop mid-call. */
export const ABORT_MARKER = "*** Abort";

export const REPLACE_PAIR_COALESCED_WARNING =
	"Multiple hunks targeted the same exact range; kept only the last. Issue one `PUT` or `CUT` hunk per range.";
export const REPLACEMENT_INDENT_AUTO_SHIFT_WARNING =
	"Auto-indented a replacement body to match unchanged structural rows in its source range.";
export const BARE_BODY_AUTO_PIPED_WARNING =
	"Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";
export const SNAPSHOT_ROWS_AUTO_PUT_WARNING =
	"Recovered top-level `N:TEXT` snapshot row(s) as single-line `PUT N.=N:` replacements. Use explicit `PUT` headers for reliable edits.";

export function repeatedSnapshotRowMessage(line: number): string {
	return `two or more pasted \`${line}:TEXT\` read-output rows name line ${line}. Such rows are recovered as single-line \`PUT ${line}${HL_RANGE_SEP}${line}:\` replacements, so repeating a number would keep only the last row and drop the rest. Write the hunk explicitly: one \`PUT ${line}${HL_RANGE_SEP}M:\` header covering exactly the lines that change, followed by \`+TEXT\` body rows holding their complete final content.`;
}

export function literalOpRowWarning(line: number, text: string): string {
	return `line ${line}: body row \`${HL_PAYLOAD_REPLACE}${text}\` is itself a valid hunk header, so it was inserted into the file as literal text rather than executed. Ops are never \`${HL_PAYLOAD_REPLACE}\`-prefixed — drop the \`${HL_PAYLOAD_REPLACE}\` to run it, and re-issue if this line landed in the file by mistake.`;
}

export const BARE_RANGE_AUTO_PUT_WARNING =
	"Recovered a bare `N.=M:` header as `PUT N.=M:`. Prefix replacement ranges with `PUT`.";
export const READ_METADATA_IGNORED_WARNING =
	"Ignored copied read-output elision row(s). Re-read elided ranges before editing them.";
export const EMPTY_PUT_AUTO_CUT_WARNING =
	"Interpreted an empty `PUT` body as deletion. Use `CUT N.=M` or `CUT N*` for bodyless deletes.";
export const CUT_COLON_IGNORED_WARNING =
	"Ignored a trailing `:` on bodyless `CUT`. Prefer `CUT N.=M` / `CUT N*` without a colon.";
export const MINUS_BULLET_AUTO_PIPED_WARNING =
	"Auto-prefixed bare `- ` bullet row(s) as literal content. `-` rows never remove lines — the range does that; always prefix literal body rows with `+`: `+- item`.";
export const DIFF_OLD_ROWS_IGNORED_WARNING =
	"Ignored unified-diff `-old` row(s); the range already removes old content, so only `+new` rows were kept.";
export const MINUS_ROW_REJECTED =
	"`-` rows are not valid; the range already names the lines being changed. For Markdown bullets or other literal `-` lines, prefix the literal row with `+`: `+- item`.";

export interface BlockDiagnosticSuggestions {
	next_block: BlockSpan | undefined;
	enclosing_block: BlockSpan | undefined;
}

export function blockUnresolvedMessage(
	line: number,
	op: AbsoluteRangeOp,
	fileLines: string[] | undefined,
	suggestions: BlockDiagnosticSuggestions,
	register: string | undefined,
): string {
	const phrase = blockFormAt(op, line, register);
	const fallback =
		op === "replace"
			? register === undefined
				? `${HL_PUT_KEYWORD} ${line}${HL_RANGE_SEP}M:`
				: `${HL_PUT_KEYWORD} ${line}${HL_RANGE_SEP}M @${register}`
			: register === undefined
				? `${HL_CUT_KEYWORD} ${line}${HL_RANGE_SEP}M`
				: `${HL_CUT_KEYWORD} ${line}${HL_RANGE_SEP}M @${register}`;
	const anchorText = fileLines?.[line - 1];
	const nextBlock = suggestions.next_block;
	let message: string;
	if (anchorText !== undefined && anchorText.trim() === "" && nextBlock !== undefined) {
		const retry = blockFormAt(op, nextBlock.start, register);
		message = `Line ${line} is blank; no syntactic block can begin there. The next multi-line block begins at line ${nextBlock.start} and ends at line ${nextBlock.end}. Retry \`${retry}\`.`;
	} else {
		message = `\`${phrase}\` could not resolve a syntactic block beginning on line ${line} (unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`;
	}
	if (suggestions.enclosing_block !== undefined) {
		const retry = blockFormAt(op, suggestions.enclosing_block.start, register);
		message += ` The nearest enclosing multi-line block begins at line ${suggestions.enclosing_block.start} and ends at line ${suggestions.enclosing_block.end}; use \`${retry}\` to target it.`;
	}
	if (fileLines !== undefined) {
		const context = formatAnchoredContext([line], fileLines);
		if (context.length > 0) message += `\n\n${context.join("\n")}`;
	}
	return message;
}

export const BLOCK_RESOLVER_UNAVAILABLE =
	"Block locators (`N*` in `PUT N*:`, `PUT >N*`, `CUT N*`) are not available here (no block resolver configured). Use a concrete line range.";

function closerLoweredWarning(blockForm: string, plainForm: string): string {
	return `\`${blockForm}\` anchors on a closing delimiter, so it was applied as plain \`${plainForm}\`. Anchor on the line that OPENS the construct.`;
}

function unresolvedLoweredWarning(blockForm: string, line: number, plainForm: string): string {
	return `\`${blockForm}\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`${plainForm}\`. Verify the landing line; anchor on a line that OPENS a construct.`;
}

export function insertAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*:`, `PUT >${line}:`);
}
export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*:`, line, `PUT >${line}:`);
}
export function pasteAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*`, `PUT >${line}`);
}
export function pasteAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*`, line, `PUT >${line}`);
}

export type BoundarySide = "leading" | "trailing";

export function ambiguousBoundaryEchoMessage(
	startLine: number,
	endLine: number,
	side: BoundarySide,
	count: number,
): string {
	const whereClause =
		side === "leading"
			? `opens by restating the ${count} line(s) just above the range`
			: `ends by restating the ${count} line(s) just below the range`;
	return `\`PUT ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: the body ${whereClause}, but is too short to be the full final content of the selected range. Re-issue with the range covering exactly the lines that change and the body as their complete final content.`;
}

export function ambiguousBoundaryPlacementMessage(startLine: number, endLine: number): string {
	return `\`PUT ${startLine}${HL_RANGE_SEP}${endLine}:\` rejected: a selected boundary row is required for the file to parse, but the body indentation does not establish whether it belongs before or after that row. Re-read the region and re-issue with a range that excludes every unchanged boundary row.`;
}

export function textualBoundaryEchoWarning(startLine: number, leading: number, trailing: number): string {
	const parts: string[] = [];
	if (leading > 0) parts.push(`${leading} leading`);
	if (trailing > 0) parts.push(`${trailing} trailing`);
	return `Auto-repaired a replacement boundary echo at line ${startLine}: dropped ${parts.join(" and ")} body line(s) already present outside the range. Issue the body as final content for the selected range only.`;
}

export function boundaryVariantRepairWarning(startLine: number, kept: number, dropped: number): string {
	const actions: string[] = [];
	if (kept > 0) actions.push(`retained ${kept} syntax-essential source boundary row(s) selected by the range`);
	if (dropped > 0) actions.push(`dropped ${dropped} body row(s) duplicated just outside the range`);
	return `Auto-repaired replacement boundaries at line ${startLine}: ${actions.join(" and ")}. The result was verified by the syntax probe — re-issue with the range covering exactly the changed lines and the body as their complete final content.`;
}

export function editBrokeParseWarning(firstChangedLine: number | undefined): string {
	const at = firstChangedLine === undefined ? "" : ` near line ${firstChangedLine}`;
	return `This edit introduced a syntax error${at}: the file parsed before the patch and no longer does. It was applied exactly as written, so a line number or range endpoint is likely wrong — re-read the touched region and re-issue a correcting edit.`;
}

export const UNRESOLVED_BLOCK_INTERNAL =
	"internal error: unresolved block edit reached the applier (resolveBlockEdits was not run).";
export const UNRESOLVED_CLIPBOARD_INTERNAL =
	"internal error: unresolved clipboard edit reached the applier (resolveClipboardEdits was not run).";
export const REM_TAKES_NO_BODY =
	"`REM` deletes the whole file and takes no body rows or line ops. Issue it alone under the header.";
export const MOVE_TAKES_NO_BODY =
	"`MV DEST` does not take body rows. Put line edits above the `MV` row; the destination path follows `MV` on the same line.";
export const CUT_TAKES_NO_BODY =
	"`CUT` deletes (and captures) the named lines and takes no body rows. To write new content, use `PUT N.=M:` with `+TEXT` rows.";
export const COLON_ON_REGISTER_PUT =
	"`PUT … @name` pastes the register and never takes `:` — the colon promises body rows. Drop the colon (`PUT >40 @name`), or drop `@name` and write `+TEXT` body rows.";
export const REGISTER_PUT_TAKES_NO_BODY =
	"A register `PUT` pastes captured lines and takes no `+` body rows. To write literal text, drop the `@name` and use `PUT …:` with body rows.";
export const COLONLESS_PUT_TAKES_NO_BODY =
	"`PUT` without `:` is clipboard-backed and takes no body rows. Add `:` after the locator to write literal content (`PUT >40:` then `+TEXT` rows).";
export const COLONLESS_SPAN_PUT =
	"Colonless `PUT` is clipboard-backed, and span targets need a named register (`PUT 5.=9 @name`); the anonymous register pastes only at gaps (`PUT >40`). To write literal content, add `:` and `+TEXT` body rows.";
export const EMPTY_PASTE =
	"Nothing to paste: no unlabeled `CUT` precedes this `PUT` in this call, and the anonymous register never carries across calls. Put `CUT N.=M` / `CUT N*` above it, or use named registers (`CUT … @name` → `PUT … @name`) for cross-call moves.";

export function emptyRegisterPasteWarning(name: string, known: string[]): string {
	const base = `\`@${name}\` was empty — no \`CUT … @${name}\` precedes this op in this call and no persisted register has that name — so nothing was pasted.`;
	if (known.length === 0) return base;
	return `${base} Available registers: ${known.map((k) => `\`@${k}\``).join(", ")}.`;
}

export function emptyRegisterSpanPasteMessage(name: string, known: string[]): string {
	const base = `\`@${name}\` is empty — no \`CUT … @${name}\` precedes this op in this call and no persisted register has that name — so pasting it over a range would delete those lines and write nothing back. Capture the register first (\`CUT … @${name}\`), or use \`CUT\` if deleting the range is what you meant.`;
	if (known.length === 0) return base;
	return `${base} Available registers: ${known.map((k) => `\`@${k}\``).join(", ")}.`;
}

export function ambiguousAnonymousPasteMessage(pending: string[]): string {
	return `${pending.length} unlabeled \`CUT\`s are pending (${pending.join(", ")}) — an unlabeled paste cannot tell which one you meant. Label the moves (\`CUT … @name\` → \`PUT … @name\`), or keep at most one unlabeled \`CUT\` before each unlabeled paste.`;
}

export const CLIPBOARD_INTERLEAVED_SECTIONS =
	"`CUT`/register-`PUT` ops cannot be used in a file whose sections are interleaved with another file's: same-path sections merge into the first occurrence, which would reorder the register sequence. Keep each file's ops under ONE `[path#TAG]` header.";
export const EMPTY_INSERT =
	"`PUT <N:` / `PUT >N:` promises body rows and got none. Write `+TEXT` rows, or drop the `:` to paste a register (`PUT >N` = anonymous, `PUT >N @name` = named).";

export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
	const s = crossed === 1 ? "" : "s";
	return `PUT >${anchorLine}: body indented shallower than the anchor, so the landing moved past ${crossed} closing line${s} to after line ${landingLine}. For the deeper position inside the block, re-issue with the body indented to match.`;
}

export function blockInsertLandingShiftWarning(blockStart: number, closerLine: number, landingLine: number): string {
	return `PUT >${blockStart}*: body indented deeper than closing line ${closerLine}, so it was placed inside the block, after line ${landingLine}. \`PUT >N*\` lands AFTER the block at sibling depth — if inside was intended, use plain \`PUT >${closerLine}:\`.`;
}

export function afterInsertOpenerEscapeWarning(anchorLine: number, landingLine: number): string {
	return `PUT >${anchorLine}: line ${anchorLine} opens a block, and the body's indentation claims a position outside it, so the body was landed after line ${landingLine} (verified by the syntax probe). To insert after a whole construct, anchor on its closing line or use \`PUT >N*:\`.`;
}

export const RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";
export const RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";
export const RECOVERY_LINE_REMAP_WARNING =
	"Recovered by remapping stale line anchors to unchanged current lines (file changed since the tagged read). Verify the diff matches your intent.";
export const HEADTAIL_DRIFT_WARNING =
	"Applied the `PUT <1:`/`PUT >$:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

export function writeDriftWarning(path: string): string {
	return `${path}: the file on disk after this write differs from what was sent — the client (editor/IDE) likely reformatted it on save (e.g. format-on-save, tab/space settings). The returned snapshot reflects the actual file; re-read before further edits if the extra changes were unexpected.`;
}

export function missingSnapshotTagMessage(sectionPath: string): string {
	return `Missing hashline snapshot tag for ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}\` from your latest read/search output. To create a new file, use the write tool.`;
}

export function pathRecoveredFromTagMessage(authoredPath: string, resolvedPath: string, tag: string): string {
	return `Path "${authoredPath}" does not exist; matched its filename and snapshot tag ${HL_FILE_HASH_SEP}${tag} to ${resolvedPath} (read earlier this session). Anchor future edits on ${HL_FILE_PREFIX}${resolvedPath}${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX}.`;
}

/** Compress a line list into a sorted `1-4, 7, 10-12` range string. */
function formatLineRanges(lines: number[]): string {
	const set = new Set(lines);
	if (set.size === 0) return "";
	const sorted = [...set].sort((a, b) => a - b);
	const parts: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let i = 1; i < sorted.length; i += 1) {
		const current = sorted[i];
		if (current === prev + 1) {
			prev = current;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = current;
		prev = current;
	}
	parts.push(start === prev ? `${start}` : `${start}-${prev}`);
	return parts.join(", ");
}

export interface RevealedLine {
	line: number;
	text: string;
}

export interface UnseenLinesReveal {
	lines: RevealedLine[];
	truncated: boolean;
}

export function unseenLinesMessage(
	sectionPath: string,
	unseenLines: number[],
	tag: string,
	reveal: UnseenLinesReveal,
): string {
	const ranges = formatLineRanges(unseenLines);
	const selector = ranges.replace(/, /g, ",");
	const header = `This edit anchors to lines ${ranges} of ${sectionPath} that ${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX} never displayed (it showed a partial range, a search hit, or a folded summary).`;
	if (reveal.lines.length === 0) {
		return `${header} Re-read them in full first with a ranged read like \`${sectionPath}:${selector}\` — it skips summarization and mints a fresh tag (a plain re-read just re-folds them) — then re-issue the edit.`;
	}
	const preview = reveal.lines.map((r) => `  ${formatNumberedLine(r.line, r.text)}`).join("\n");
	if (reveal.truncated) {
		return `${header} Preview of the actual file content at the first ${reveal.lines.length} unseen line(s):\n${preview}\nThe range exceeds the inline preview cap — re-read the remainder with \`${sectionPath}:${selector}\` before re-issuing the edit.`;
	}
	return `${header} Actual file content at those lines:\n${preview}\nVerify the content matches what you intend to touch, then re-issue the edit with the same ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX} header — a straight retry now succeeds without a re-read. If the content does NOT match, fix your line numbers.`;
}

export type BlockOp = "replace" | "insertAfter" | "cut" | "pasteAfter";

function blockOpForm(op: BlockOp, line: number): string {
	switch (op) {
		case "replace":
			return `${HL_PUT_KEYWORD} ${line}*:`;
		case "insertAfter":
			return `${HL_PUT_KEYWORD} >${line}*:`;
		case "cut":
			return `${HL_CUT_KEYWORD} ${line}*`;
		case "pasteAfter":
			return `${HL_PUT_KEYWORD} >${line}*`;
	}
}

function blockOpPlain(op: BlockOp, line: number): string {
	switch (op) {
		case "replace":
			return `${HL_PUT_KEYWORD} ${line}:`;
		case "insertAfter":
			return `${HL_PUT_KEYWORD} >${line}:`;
		case "cut":
			return `${HL_CUT_KEYWORD} ${line}`;
		case "pasteAfter":
			return `${HL_PUT_KEYWORD} >${line}`;
	}
}

export function blockSingleLineMessage(line: number, op: BlockOp, enclosingBlock: BlockSpan | undefined): string {
	const form = blockOpForm(op, line);
	const plainForm = blockOpPlain(op, line);
	let message = `\`${form}\` resolved a single-line block — line ${line} is a bare statement, not the opening line of a multi-line construct. For only this statement use \`${plainForm}\`.`;
	if (enclosingBlock !== undefined) {
		const enclosingForm = blockOpForm(op, enclosingBlock.start);
		message += ` The nearest enclosing multi-line block begins at line ${enclosingBlock.start} and ends at line ${enclosingBlock.end}; use \`${enclosingForm}\` to target it.`;
	}
	return message;
}
