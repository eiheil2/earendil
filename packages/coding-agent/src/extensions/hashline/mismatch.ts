/** Snapshot-tag mismatch diagnostics. */

import { HL_FILE_HASH_EXAMPLES } from "./format.ts";
import { formatAnchoredContext, jsonQuote } from "./messages.ts";

export interface MismatchDetails {
	path: string | undefined;
	expected_file_hash: string;
	actual_file_hash: string;
	file_lines: string[];
	anchor_lines: number[];
	hash_recognized: boolean;
	/** Absolute paths this session has already issued `expected_file_hash` for. */
	tag_origin_paths: string[];
}

/** Format the required shape of a tagged line anchor. */
export function formatFullAnchorRequirement(raw: string | undefined): string {
	const received = raw === undefined ? "" : ` Received ${jsonQuote(raw)}.`;
	return `a bare line number from read/search output plus the section header content-hash tag (for example [src/foo.ts#${HL_FILE_HASH_EXAMPLES[0]}] and line "160")${received}`;
}

/** Parse a decorated bare line-number reference. */
export function parseTag(reference: string): number {
	const match = /^\s*[>+\-*]*\s*(\d+)(?::.*)?\s*$/.exec(reference);
	if (match === null) {
		throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(reference)}.`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${reference}".`);
	return line;
}

/** Validate that a line reference exists in the target. */
export function validateLineRef(line: number, fileLines: string[]): void {
	if (line < 1 || line > fileLines.length) {
		throw new Error(`Line ${line} does not exist (file has ${fileLines.length} lines)`);
	}
}

/** Format the complete model-facing snapshot mismatch diagnostic. */
export function formatMismatchMessage(details: MismatchDetails): string {
	const path = details.path === undefined ? "" : ` for ${details.path}`;
	let lines: string[];
	if (details.hash_recognized) {
		lines = [
			`Edit rejected${path}: file changed between read and edit.`,
			`Section is bound to #${details.expected_file_hash}, but the current file hashes to #${details.actual_file_hash}. If a prior edit in this session modified this file, copy the [path#newhash] header from that edit's response; otherwise re-read the file with \`read\` to refresh the tag before retrying.`,
		];
	} else {
		lines = [`Edit rejected${path}: hash #${details.expected_file_hash} is not from this session.`];
		for (const origin of details.tag_origin_paths) {
			lines.push(`Hash #${details.expected_file_hash} was issued in this session for ${origin}.`);
		}
		lines.push(
			`The current file hashes to #${details.actual_file_hash}. Re-read the file with \`read\` to copy a current [path#tag] header — never invent the tag and never reuse one from a prior session.`,
		);
	}
	const context = formatAnchoredContext(details.anchor_lines, details.file_lines);
	if (context.length > 0) {
		lines.push("");
		lines.push(...context);
	}
	return lines.join("\n");
}

/** Construct a match failure from mismatch details. */
export function mismatchError(details: MismatchDetails): Error {
	return new Error(formatMismatchMessage(details));
}
