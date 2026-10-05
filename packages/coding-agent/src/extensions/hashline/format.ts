/** Hashline syntax constants and display helpers. */

import type { Cursor } from "./types.ts";

export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";
export const HL_PAYLOAD_REPLACE = "+";
export const HL_PUT_KEYWORD = "PUT";
export const HL_CUT_KEYWORD = "CUT";
export const HL_REM_KEYWORD = "REM";
export const HL_MOVE_KEYWORD = "MV";
export const HL_HEADER_COLON = ":";
export const HL_GAP_BEFORE = "<";
export const HL_GAP_AFTER = ">";
export const HL_BLOCK_SUFFIX = "*";
export const HL_EOF_ANCHOR = "$";
export const HL_REGISTER_SIGIL = "@";
export const HL_FILE_HASH_SEP = "#";
export const HL_RANGE_SEP = ".=";
export const HL_LINE_BODY_SEP = ":";
export const HL_FILE_HASH_LENGTH = 4;
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"];

/** Format a concrete replacement hunk header. */
export function formatReplaceHeader(start: number, end: number): string {
	return `PUT ${start}.=${end}:`;
}
/** Format a concrete cut hunk header. */
export function formatCutHeader(start: number, end: number): string {
	return `CUT ${start}.=${end}`;
}
/** Format a gap locator. */
export function formatGapLocator(cursor: Cursor): string {
	switch (cursor.kind) {
		case "bof":
			return "<1";
		case "eof":
			return ">$";
		case "before":
			return `<${cursor.anchor.line}`;
		case "after":
			return `>${cursor.anchor.line}`;
	}
}
/** Format an insertion hunk header. */
export function formatInsertHeader(cursor: Cursor): string {
	return `PUT ${formatGapLocator(cursor)}:`;
}
/** Format a named clipboard register. */
export function formatRegister(name: string): string {
	return `@${name}`;
}
/** Format representative line anchors for a diagnostic. */
export function describeAnchorExamples(linePrefix: string): string {
	const examples =
		linePrefix === ""
			? ["160", "42", "7"]
			: (() => {
					const shortened = linePrefix.slice(0, Math.max(linePrefix.length - 1, 0));
					return [linePrefix, `${shortened === "" ? "4" : shortened}2`, "7"];
				})();
	return examples.map((example) => `"${example}"`).join(", ");
}
/** Format a file section header. */
export function formatHashlineHeader(path: string, tag: string): string {
	return `[${path}#${tag}]`;
}
/** Format one numbered source line. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}
/** Split text into lines addressable by hashline anchors. */
export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}
/** Format every LF-delimited row, including a terminal blank sentinel. */
export function formatNumberedLines(text: string, startLine: number): string {
	return text
		.split("\n")
		.map((line, index) => formatNumberedLine(startLine + index, line))
		.join("\n");
}
