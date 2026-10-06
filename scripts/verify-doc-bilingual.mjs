#!/usr/bin/env node
/**
 * Bilingual-pair consistency gate for `packages/coding-agent/docs/`.
 *
 * A pair is three sibling files: the English `<name>.md`, the Chinese
 * `<name>.zh.md`, and a `<name>.i18n.yaml` record holding, per heading section, the
 * hash of the English and the Chinese prose in it. The record is keyed by the
 * English heading-slug path and the two sides' sections correspond by position. The
 * gate proves a pair is complete, structurally mirrored, and re-recorded, so editing
 * one language without the other goes red.
 *
 * Checks, per declared pair:
 *   1. all three files exist;
 *   2. both sides carry their language switcher immediately after the H1;
 *   3. the structural signatures match in order - heading depths, code fences (info
 *      string and byte-exact body), table shapes, list kinds/starts/item counts, and
 *      link targets with the `.zh` locale suffix normalized away;
 *   4. a link into another declared pair uses that pair's own locale on each side;
 *   5. the record is canonical and equals the entries computed from the current text;
 *   6. a `.zh.md` or `.i18n.yaml` no manifest pair claims is rejected - scope is
 *      explicit, never implicit.
 *
 * Scope is deliberately narrower than DSH's all-or-nothing corpus: pi ships 40+
 * pages and the translated set is the three user-facing entry points. Link targets
 * are therefore compared locale-agnostically, and only targets that are themselves
 * declared pairs must use the source side's locale.
 *
 * `--list` prints every pair's state and never fails. `--write <pair...>` re-records
 * the named pairs, or `--all` for the corpus; recording is the act of confirming.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const DOCS_DIR = join(root, "packages", "coding-agent", "docs");
const MANIFEST_PATH = join(root, "scripts", "doc-bilingual.manifest.json");
const RECORD_HEADER = [
	"# Bilingual-pair consistency record: one entry per heading section, holding the hash of the",
	"# English and the Chinese prose in that section. Code fences are excluded because they must be",
	"# byte-identical on both sides. After editing either side, bring the other along and re-record:",
	"#   node scripts/verify-doc-bilingual.mjs --write <pair>",
].join("\n");

const hash16 = text => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const headingPattern = /^(#{1,6})\s+(\S.*?)\s*#*$/;
const bulletPattern = /^(\s*)([-*+]|\d+[.)])\s+/;
const delimiterRowPattern = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;
const linkPattern = /\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
const switcherPattern = /^(English \| )?\[[^\]]+\]\([^)]+\)( \| (中文|English))?$/;

/** The fence a line opens, or undefined when it is prose. */
function fenceMarker(line) {
	const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
	return match ? { char: match[1][0], length: match[1].length } : undefined;
}

/** Table cells in a row, ignoring the leading and trailing pipes. */
function countCells(line) {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).length;
}

/** Drop the `.zh` locale suffix so `x.zh.md` and `x.md` compare as the same target. */
function normalizeLinkTarget(target) {
	return target.replace(/\.zh(\.md)$/, "$1");
}

/**
 * Structural fingerprint of a page: everything that must match one to one across a
 * pair, in document order. Language-specific prose is deliberately absent.
 */
function structuralSignature(lines) {
	const entries = [];
	let listIndent;
	let listKind;
	let listStart = 0;
	let listCount = 0;
	const flushList = () => {
		if (listKind !== undefined) entries.push(`list:${listKind}:${listStart}:${listCount}`);
		listKind = undefined;
		listIndent = undefined;
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const marker = fenceMarker(line);
		if (marker) {
			flushList();
			entries.push(`fence:${line.trim().slice(marker.length).trim()}`);
			const body = [];
			for (index++; index < lines.length; index++) {
				const closing = fenceMarker(lines[index]);
				if (closing?.char === marker.char && closing.length >= marker.length) break;
				body.push(lines[index]);
			}
			entries.push(`fence-body:${hash16(body.join("\n"))}`);
			continue;
		}
		const heading = headingPattern.exec(line);
		if (heading) {
			flushList();
			entries.push(`heading:${heading[1].length}`);
			continue;
		}
		const bullet = bulletPattern.exec(line);
		if (bullet) {
			const ordered = /\d/.test(bullet[2]);
			if (listKind === undefined || bullet[1].length < listIndent || (listKind === "ol") !== ordered) {
				flushList();
				listKind = ordered ? "ol" : "ul";
				listStart = ordered ? Number.parseInt(bullet[2], 10) : 0;
				listIndent = bullet[1].length;
			}
			listCount++;
			continue;
		}
		if (line.includes("|") && index + 1 < lines.length && delimiterRowPattern.test(lines[index + 1])) {
			flushList();
			const rows = [countCells(line), countCells(lines[index + 1])];
			for (index += 2; index < lines.length && lines[index].includes("|"); index++) rows.push(countCells(lines[index]));
			index--;
			const columns = rows[0];
			entries.push(`table:${rows.length}x${rows.every(cells => cells === columns) ? columns : "ragged"}`);
			continue;
		}
		flushList();
		// Only the path of a link is compared: heading-derived anchors are per-language,
		// so `#provider-specific-config` and its Chinese translation cannot match textually.
		for (const match of line.matchAll(linkPattern)) {
			entries.push(`link:${normalizeLinkTarget(match[1].split("#")[0])}`);
		}
	}
	flushList();
	return entries;
}

/** Split a page into heading sections; `headings[i]` is the title, or null for the preamble. */
function sectionsOf(lines) {
	const sections = [{ heading: null, lines: [] }];
	for (let index = 0; index < lines.length; index++) {
		const marker = fenceMarker(lines[index]);
		if (marker) {
			for (index++; index < lines.length; index++) {
				const closing = fenceMarker(lines[index]);
				if (closing?.char === marker.char && closing.length >= marker.length) break;
			}
			continue;
		}
		const heading = headingPattern.exec(lines[index]);
		if (heading) sections.push({ heading: heading[2], lines: [] });
		else sections[sections.length - 1].lines.push(lines[index]);
	}
	return sections;
}

const slugify = heading =>
	heading
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** A section's prose with code fences removed: what a translation has to cover. */
function sectionProse(lines) {
	return lines
		.filter(line => !fenceMarker(line))
		.join("\n")
		.replace(/\s+/g, " ")
		.trim();
}

/** Section-keyed hashes for both sides, keyed by the English heading-slug path. */
export function sectionEntries(englishLines, chineseLines) {
	const seen = new Map();
	const entries = {};
	sectionsOf(englishLines).forEach((section, index) => {
		const prose = sectionProse(section.lines);
		if (prose.length === 0) return;
		const path = section.heading === null ? "/" : `/${slugify(section.heading)}`;
		const count = seen.get(path) ?? 0;
		seen.set(path, count + 1);
		entries[count === 0 ? path : `${path}~${count + 1}`] = {
			en: hash16(prose),
			zh: hash16(sectionProse(sectionsOf(chineseLines)[index]?.lines ?? [])),
		};
	});
	return entries;
}

/** Canonical record text for a pair. */
export function renderRecord(entries) {
	const body = Object.entries(entries)
		.map(([key, value]) => `${key}:\n  en: ${value.en}\n  zh: ${value.zh}`)
		.join("\n");
	return `${RECORD_HEADER}\n${body}\n`;
}

/** Section keys in a record; a record with unparsable lines has no key for them. */
export function parseRecordKeys(text) {
	return text
		.split("\n")
		.filter(line => /^\/\S*:$/.test(line))
		.map(line => line.slice(0, -1));
}

function readManifest() {
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	if (!Array.isArray(manifest.pairs) || manifest.pairs.length === 0) {
		throw new Error(`${relative(root, MANIFEST_PATH)} must declare at least one pair`);
	}
	return manifest.pairs.map(pair => pair.replaceAll("\\", "/"));
}

function pairPaths(stem) {
	const english = join(root, stem);
	const name = stem.slice(stem.lastIndexOf("/") + 1);
	return { stem, name, english, chinese: english.replace(/\.md$/, ".zh.md"), record: english.replace(/\.md$/, ".i18n.yaml") };
}

/** Links whose target is another declared pair, with the doc name the locale suffix is built from. */
function pairedLinks(lines, stems) {
	const links = [];
	for (const line of lines) {
		if (switcherPattern.test(line)) continue;
		for (const match of line.matchAll(linkPattern)) {
			const raw = match[1].split("#")[0];
			const name = normalizeLinkTarget(raw).replace(/\.md$/, "");
			if (stems.includes(name)) links.push({ raw, name });
		}
	}
	return links;
}

/** The first non-blank line after the H1: where the language switcher has to be. */
function switcherAfterHeading(lines) {
	const headingIndex = lines.findIndex(line => headingPattern.test(line));
	if (headingIndex === -1) return undefined;
	return lines.slice(headingIndex + 1).find(line => line.trim().length > 0);
}

function firstDivergence(left, right) {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		if (left[index] !== right[index]) return `entry ${index}: ${left[index] ?? "<missing>"} vs ${right[index] ?? "<missing>"}`;
	}
	return undefined;
}

/** Every problem with one pair; an empty array means the pair is consistent. */
export function checkPair(paths, stems) {
	const missingSides = ["english", "chinese"].filter(key => !existsSync(paths[key]));
	if (missingSides.length > 0) {
		return missingSides.map(key => `${key} file is missing: ${relative(root, paths[key]).replaceAll("\\", "/")}`);
	}

	const issues = [];
	if (!existsSync(paths.record)) {
		issues.push(`record file is missing: ${relative(root, paths.record).replaceAll("\\", "/")}`);
	}

	const englishLines = readFileSync(paths.english, "utf8").split("\n");
	const chineseLines = readFileSync(paths.chinese, "utf8").split("\n");
	const englishSwitcher = switcherAfterHeading(englishLines);
	const chineseSwitcher = switcherAfterHeading(chineseLines);
	if (!switcherPattern.test(englishSwitcher ?? "") || !englishSwitcher.includes(`](${paths.name.replace(/\.md$/, ".zh.md")})`)) {
		issues.push("English page has no language switcher immediately after its H1");
	}
	if (!switcherPattern.test(chineseSwitcher ?? "")) {
		issues.push("Chinese page has no language switcher immediately after its H1");
	}

	const divergence = firstDivergence(structuralSignature(englishLines), structuralSignature(chineseLines));
	if (divergence) issues.push(`structural signatures diverge at ${divergence}`);

	for (const [side, lines] of [
		["English", englishLines],
		["Chinese", chineseLines],
	]) {
		for (const link of pairedLinks(lines, stems)) {
			const expected = side === "Chinese" ? `${link.name}.zh.md` : `${link.name}.md`;
			if (link.raw !== expected) issues.push(`${side} page links to ${link.raw}, expected ${expected}`);
		}
	}

	const record = existsSync(paths.record) ? readFileSync(paths.record, "utf8") : undefined;
	const expected = renderRecord(sectionEntries(englishLines, chineseLines));
	if (record !== undefined && record !== expected) {
		issues.push(
			`record is out of sync with the current text (recorded sections ${parseRecordKeys(record).length}, computed ${parseRecordKeys(expected).length})`,
		);
	}
	return issues;
}

/** Locale and record files under docs/ that no manifest pair claims. */
function unclaimedLocaleFiles(pairs) {
	const claimed = new Set(pairs.map(pair => pairPaths(pair).chinese.replaceAll("\\", "/")));
	for (const pair of pairs) claimed.add(pairPaths(pair).record.replaceAll("\\", "/"));
	const found = [];
	const walk = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(zh\.md|i18n\.yaml)$/.test(entry.name) && !claimed.has(full.replaceAll("\\", "/"))) {
				found.push(relative(root, full).replaceAll("\\", "/"));
			}
		}
	};
	walk(DOCS_DIR);
	return found.sort();
}

const pairs = readManifest();
// Doc names are matched by basename: links inside docs/ are relative to docs/.
const stems = pairs.map(pair => pair.slice(pair.lastIndexOf("/") + 1).replace(/\.md$/, ""));
const args = process.argv.slice(2);
const flags = args.filter(arg => arg.startsWith("--"));
const selected = args.filter(arg => !arg.startsWith("--")).map(arg => `${arg.replaceAll("\\", "/").replace(/\.md$/, "")}.md`);
const targets = selected.length > 0 ? selected : pairs;

if (flags.includes("--list")) {
	for (const pair of pairs) {
		const issues = checkPair(pairPaths(pair), stems);
		console.log(`${issues.length === 0 ? "ok      " : "PROBLEM "} ${pair}${issues.length > 0 ? ` - ${issues[0]}` : ""}`);
	}
	process.exit(0);
}

if (flags.includes("--write")) {
	if (selected.length === 0 && !flags.includes("--all")) {
		console.error("--write needs the pairs you confirmed, or --all for the whole corpus.");
		process.exit(1);
	}
	const unknown = targets.filter(target => !pairs.includes(target));
	if (unknown.length > 0) {
		console.error(`Not declared in ${relative(root, MANIFEST_PATH)}: ${unknown.join(", ")}`);
		process.exit(1);
	}
	for (const target of targets) {
		const paths = pairPaths(target);
		const absent = ["english", "chinese"].filter(key => !existsSync(paths[key]));
		if (absent.length > 0) {
			console.error(`${target}: cannot record, missing ${absent.join(" and ")} file.`);
			process.exit(1);
		}
		const entries = sectionEntries(
			readFileSync(paths.english, "utf8").split("\n"),
			readFileSync(paths.chinese, "utf8").split("\n"),
		);
		writeFileSync(paths.record, renderRecord(entries));
		console.log(`recorded ${target} (${Object.keys(entries).length} sections)`);
	}
	process.exit(0);
}

const failures = [];
for (const pair of pairs) {
	for (const issue of checkPair(pairPaths(pair), stems)) failures.push(`${pair}: ${issue}`);
}
for (const stray of unclaimedLocaleFiles(pairs)) {
	failures.push(`${stray}: locale or record file not declared in ${relative(root, MANIFEST_PATH)}`);
}

if (failures.length > 0) {
	console.error("verify-doc-bilingual failed:\n");
	for (const failure of failures) console.error(`  ${failure}`);
	console.error("\nUpdate the other language in the same change, then re-record with --write <pair>.");
	process.exit(1);
}
console.log(`verify-doc-bilingual: ${pairs.length} declared pair(s) complete and consistent.`);