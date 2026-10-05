/**
 * Parity replay: run OMP `crates/pi-edit/tests/fixtures/hashline/parity_*.json`
 * cases through the TS port and compare byte-for-byte with the Rust engine's
 * expected outputs (line-ending normalized).
 *
 * Cases that require the tree-sitter syntax probe (pi_ast) or the Rust
 * session driver are skipped; see PHASE2-HASHLINE.md for the exact list.
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { type ApplyOptions, applyEdits } from "../src/extensions/hashline/apply.ts";
import type { EmptyPaste } from "../src/extensions/hashline/clipboard.ts";
import { parsePatch } from "../src/extensions/hashline/parser.ts";
import type { Clipboard, FileOp } from "../src/extensions/hashline/types.ts";

const FIXTURE_DIR = path.join(__dirname, "hashline");

// Fixtures whose expected outputs were produced with the tree-sitter syntax
// probe (pi_ast). Unified pi has no tree-sitter runtime; those cases are
// covered by the gap report instead of byte-parity.
const SYNTAX_PROBE_FIXTURES = new Set(["parity_boundary_repair.json", "parity_landing_shift.json"]);

interface ParseCall {
	input: string;
	expect?: { editCount: number; fileOp?: unknown; warnings?: string[] };
	error?: string;
}

interface ApplyCall {
	text: string;
	input: string;
	path?: string;
	clipboard?: { lines?: string[]; named?: Record<string, string[]>; pendingAnonCuts?: string[] };
	onEmptyPaste?: "drop";
	expect?: { text: string; firstChangedLine?: number; warnings?: string[] };
	error?: string;
}

interface FixtureCase {
	name: string;
	parse?: ParseCall[];
	apply?: ApplyCall[];
}

interface Fixture {
	source: string;
	cases: FixtureCase[];
}

function legacyError(message: string): string {
	return message.replace(/^InvalidAbsoluteRangeError: /, "").replace(/^Error: /, "");
}

function fileOpValue(op: FileOp | undefined): unknown {
	if (op === undefined) return null;
	if (op.kind === "rem") return { kind: "rem" };
	return { kind: "move", dest: op.dest };
}

function normalize(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

const files = readdirSync(FIXTURE_DIR).filter((file) => file.startsWith("parity_") && file.endsWith(".json"));

describe("hashline parity fixtures", () => {
	for (const file of files) {
		const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")) as Fixture;
		describe(file, () => {
			const actionable = fixture.cases.some(
				(testCase) => (testCase.parse?.length ?? 0) > 0 || (testCase.apply?.length ?? 0) > 0,
			);
			if (!actionable) {
				it.skip("driver-only cases (see report)", () => {});
				return;
			}
			for (const testCase of fixture.cases) {
				for (const call of testCase.parse ?? []) {
					it(`parse: ${testCase.name}`, () => {
						let error: Error | undefined;
						let parsed: ReturnType<typeof parsePatch> | undefined;
						try {
							parsed = parsePatch(call.input);
						} catch (err) {
							error = err as Error;
						}
						if (call.error !== undefined) {
							expect(error, `expected parse error for ${call.input}`).toBeDefined();
							expect((error as Error).message).toBe(legacyError(call.error));
							return;
						}
						expect(error).toBeUndefined();
						const expected = call.expect as NonNullable<ParseCall["expect"]>;
						expect(parsed?.edits.length).toBe(expected.editCount);
						expect(fileOpValue(parsed?.file_op)).toEqual(expected.fileOp ?? null);
						expect(parsed?.warnings).toEqual(expected.warnings ?? []);
					});
				}
				for (const call of testCase.apply ?? []) {
					if (SYNTAX_PROBE_FIXTURES.has(file)) {
						it.skip(`apply (syntax-probe fixture): ${testCase.name}`, () => {});
						continue;
					}
					it(`apply: ${testCase.name}`, () => {
						const parsed = parsePatch(call.input);
						let clipboard: Clipboard | undefined;
						if (call.clipboard !== undefined) {
							clipboard = {
								lines: call.clipboard.lines ? [...call.clipboard.lines] : undefined,
								named: call.clipboard.named
									? new Map(Object.entries(call.clipboard.named).map(([key, value]) => [key, [...value]]))
									: undefined,
								pending_anon_cuts: call.clipboard.pendingAnonCuts
									? [...call.clipboard.pendingAnonCuts]
									: undefined,
							};
						}
						const onEmptyPaste: EmptyPaste = call.onEmptyPaste === "drop" ? "drop" : "throw";
						const options: ApplyOptions = { clipboard, path: call.path, onEmptyPaste };
						let error: Error | undefined;
						let result: ReturnType<typeof applyEdits> | undefined;
						try {
							result = applyEdits(call.text, parsed.edits, options);
						} catch (err) {
							error = err as Error;
						}
						if (call.error !== undefined) {
							expect(error, `expected apply error for ${call.input}`).toBeDefined();
							expect((error as Error).message).toBe(legacyError(call.error));
							return;
						}
						expect(error).toBeUndefined();
						const expected = call.expect as NonNullable<ApplyCall["expect"]>;
						expect(normalize(result?.text ?? "")).toBe(normalize(expected.text));
						expect(result?.first_changed_line).toBe(expected.firstChangedLine ?? undefined);
						expect(result?.warnings ?? []).toEqual(expected.warnings ?? []);
					});
				}
			}
		});
	}
});
