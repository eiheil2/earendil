/** Normalization of line prefixes copied from read/search output. */

const HL_PREFIX_RE = /^\s*(?:(?:>>>|>>)\s*)?(?:[+*-]\s*)?\d+[:|]/;
const HL_PREFIX_PLUS_RE = /^\s*(?:(?:>>>|>>)\s*)?\+\s*\d+:/;
const HL_HEADER_RE = /^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$/;
const READ_RANGE_ELISION_RE = /^\s*[1-9]\d*\s*-\s*[1-9]\d*:.*(?:…|\.\.\.).*$/;
const READ_SINGLE_ELISION_RE = /^\s*(?:…|\.\.\.)\s*$/;

const HL_PREFIX_RE_G = new RegExp(HL_PREFIX_RE.source);

/** Whether a row is a truncation notice emitted by `read`. */
export function isReadTruncationNotice(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
	const body = trimmed.slice(1, -1);
	const showingNotice =
		body.startsWith("Showing ") &&
		(body.includes(" line") || body.includes("lines ") || body.includes("bytes ")) &&
		(body.includes(" of ") || body.includes(" elided"));
	const morePrefix = body.split(" more line", 2)[0];
	const moreNotice =
		(body.startsWith("More lines in ") || (body.includes(" more line") && /^\d+$/.test(morePrefix))) &&
		body.includes(" in ") &&
		body.includes(". Use ") &&
		body.endsWith(" to continue");
	const elidedNotice =
		(body.startsWith("…") || body.startsWith("...")) &&
		body.includes("ln elided;") &&
		body.includes("re-read needed ranges");
	const oversizedLineNotice = body.startsWith("Line ") && body.includes(" exceeds ") && body.includes(" limit.");
	return showingNotice || moreNotice || elidedNotice || oversizedLineNotice;
}

/** Whether a row is display-only metadata emitted by `read`. */
export function isReadMetadataLine(line: string): boolean {
	return isReadTruncationNotice(line) || READ_RANGE_ELISION_RE.test(line) || READ_SINGLE_ELISION_RE.test(line);
}

function stripLeadingHashlinePrefixes(line: string): string {
	let result = line;
	for (;;) {
		const next = result.replace(HL_PREFIX_RE_G, "");
		if (next === result) return result;
		result = next;
	}
}

/** Strip at most one leading read/search line-number prefix. */
export function stripOneLeadingHashlinePrefix(line: string): string {
	return line.replace(HL_PREFIX_RE_G, "");
}

interface LinePrefixStats {
	nonEmpty: number;
	headerCount: number;
	hashPrefixCount: number;
	diffPlusHashPrefixCount: number;
	diffPlusCount: number;
}

function collectLinePrefixStats(lines: string[]): LinePrefixStats {
	const stats: LinePrefixStats = {
		nonEmpty: 0,
		headerCount: 0,
		hashPrefixCount: 0,
		diffPlusHashPrefixCount: 0,
		diffPlusCount: 0,
	};
	for (const line of lines) {
		if (line === "" || isReadMetadataLine(line)) continue;
		stats.nonEmpty += 1;
		if (HL_HEADER_RE.test(line)) {
			stats.headerCount += 1;
			continue;
		}
		if (HL_PREFIX_RE.test(line)) stats.hashPrefixCount += 1;
		if (HL_PREFIX_PLUS_RE.test(line)) stats.diffPlusHashPrefixCount += 1;
		if (line.startsWith("+") && !line.startsWith("++")) stats.diffPlusCount += 1;
	}
	return stats;
}

/** Opportunistically strip a consistent numbered or diff prefix scheme. */
export function stripNewLinePrefixes(lines: string[]): string[] {
	const stats = collectLinePrefixStats(lines);
	if (stats.nonEmpty === 0) return [...lines];
	const contentLineCount = stats.nonEmpty - stats.headerCount;
	const stripHash = contentLineCount > 0 && stats.hashPrefixCount === contentLineCount;
	const stripPlus =
		!stripHash &&
		stats.diffPlusHashPrefixCount === 0 &&
		stats.diffPlusCount > 0 &&
		stats.diffPlusCount >= stats.nonEmpty * 0.5;
	if (!stripHash && !stripPlus && stats.diffPlusHashPrefixCount === 0) return [...lines];
	const out: string[] = [];
	for (const line of lines) {
		if (isReadMetadataLine(line) || (stripHash && HL_HEADER_RE.test(line))) continue;
		if (stripHash) {
			out.push(stripLeadingHashlinePrefixes(line));
		} else if (stripPlus && line.startsWith("+") && !line.startsWith("++")) {
			out.push(line.slice(1));
		} else if (stats.diffPlusHashPrefixCount > 0 && HL_PREFIX_PLUS_RE.test(line)) {
			out.push(stripOneLeadingHashlinePrefix(line));
		} else {
			out.push(line);
		}
	}
	return out;
}

/** Strip numbered prefixes only when every content row carries one. */
export function stripHashlinePrefixes(lines: string[]): string[] {
	const stats = collectLinePrefixStats(lines);
	if (stats.nonEmpty === 0) return [...lines];
	const contentLineCount = stats.nonEmpty - stats.headerCount;
	if (contentLineCount === 0 || stats.hashPrefixCount !== contentLineCount) return [...lines];
	return lines
		.filter((line) => !isReadMetadataLine(line) && !HL_HEADER_RE.test(line))
		.map((line) => stripLeadingHashlinePrefixes(line));
}

/** Normalize a multiline text payload into unprefixed rows. */
export function hashlineParseText(edit: string | undefined): string[] {
	if (edit === undefined) return [];
	const trimmed = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
	return stripNewLinePrefixes(trimmed.replace(/\r/g, "").split("\n"));
}

/** Normalize an existing row slice into unprefixed rows. */
export function hashlineParseLines(edit: string[] | undefined): string[] {
	return edit === undefined ? [] : stripNewLinePrefixes(edit);
}
