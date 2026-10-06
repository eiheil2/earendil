#!/usr/bin/env node
/**
 * Per-page size gate for `packages/coding-agent/docs/`.
 *
 * Ceilings live in `scripts/doc-budgets.manifest.json`. Every page is measured on
 * two axes because they fail differently: a page of prose trips the word ceiling,
 * and a page that is mostly pasted code or tables can stay under the word ceiling
 * while still being unreadable, so bytes get their own ceiling.
 *
 * Counting rule: CJK characters count one apiece and every other whitespace-
 * delimited token counts one, so the metric means "units of prose" for both the
 * English and the Chinese pages instead of undercounting Chinese by ~3x.
 *
 * `--list` reports current usage and never fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const DOCS_DIR = join(root, "packages", "coding-agent", "docs");
const MANIFEST_PATH = join(root, "scripts", "doc-budgets.manifest.json");

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** CJK characters one apiece, every other whitespace-delimited token one. */
export function countWords(text) {
	let words = 0;
	let run = "";
	let inCjk = false;
	const flush = () => {
		words += run.split(/\s+/).filter(Boolean).length;
		run = "";
	};
	for (const char of text) {
		const cjk = CJK.test(char);
		if (cjk !== inCjk) {
			flush();
			inCjk = cjk;
		}
		if (cjk) words++;
		else run += char;
	}
	flush();
	return words;
}

function collectPages(directory) {
	const pages = [];
	const walk = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".md")) {
				pages.push({
					path: relative(root, full).replaceAll("\\", "/"),
					words: countWords(readFileSync(full, "utf8")),
					bytes: statSync(full).size,
				});
			}
		}
	};
	walk(directory);
	return pages.sort((left, right) => (left.path < right.path ? -1 : 1));
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
for (const key of ["defaultWordCeiling", "defaultByteCeiling"]) {
	if (!Number.isInteger(manifest[key]) || manifest[key] <= 0) {
		console.error(`${relative(root, MANIFEST_PATH)}: ${key} must be a positive integer, got ${manifest[key]}`);
		process.exit(1);
	}
}
const overrides = manifest.overrides ?? {};
for (const [path, override] of Object.entries(overrides)) {
	for (const key of ["words", "bytes"]) {
		if (!Number.isInteger(override[key]) || override[key] <= 0) {
			console.error(`${relative(root, MANIFEST_PATH)}: ${path} override ${key} must be a positive integer, got ${override[key]}`);
			process.exit(1);
		}
	}
}

const pages = collectPages(DOCS_DIR);
if (pages.length === 0) {
	console.error(`No Markdown pages found under ${relative(root, DOCS_DIR)}`);
	process.exit(1);
}

const list = process.argv.includes("--list");
const rows = [];
const failures = [];
for (const page of pages) {
	const override = overrides[page.path] ?? {};
	const wordCeiling = override.words ?? manifest.defaultWordCeiling;
	const byteCeiling = override.bytes ?? manifest.defaultByteCeiling;
	const over = page.words > wordCeiling || page.bytes > byteCeiling;
	rows.push(
		`${over ? "OVER" : "ok  "}  ${String(page.words).padStart(6)}/${String(wordCeiling).padEnd(6)} words  ${String(page.bytes).padStart(6)}/${String(byteCeiling).padEnd(6)} bytes  ${page.path}`,
	);
	if (page.words > wordCeiling) failures.push(`${page.path}: ${page.words} words exceeds the ${wordCeiling}-word ceiling`);
	if (page.bytes > byteCeiling) failures.push(`${page.path}: ${page.bytes} bytes exceeds the ${byteCeiling}-byte ceiling`);
}

if (list) {
	for (const row of rows) console.log(row);
	process.exit(0);
}

if (failures.length > 0) {
	console.error("verify-doc-budgets failed:\n");
	for (const failure of failures) console.error(`  ${failure}`);
	console.error("\nRelocate or condense the page, or raise the ceiling for that page in scripts/doc-budgets.manifest.json with a reason.");
	process.exit(1);
}
const worstWords = Math.max(...pages.map(page => page.words));
const worstBytes = Math.max(...pages.map(page => page.bytes));
console.log(
	`verify-doc-budgets: ${pages.length} pages within ceiling (worst ${worstWords}/${manifest.defaultWordCeiling} words, ${worstBytes}/${manifest.defaultByteCeiling} bytes).`,
);