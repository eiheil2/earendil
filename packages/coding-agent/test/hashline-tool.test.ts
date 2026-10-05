/** TAG/stale-snapshot semantics and the hashline-edit tool shell. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileHash } from "../src/extensions/hashline/hash.ts";
import { createHashlineToolDefinition } from "../src/extensions/hashline/index.ts";
import { Patch } from "../src/extensions/hashline/input.ts";
import { stagePatch } from "../src/extensions/hashline/patcher.ts";
import { EditStore } from "../src/extensions/hashline/store.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "hashline-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("stale TAG rejection", () => {
	it("rejects a stale snapshot tag with a re-read prompt and leaves the file unchanged", () => {
		const file = path.join(dir, "a.ts");
		writeFileSync(file, "one\ntwo\n");
		const store = new EditStore();
		store.record(file, "one\ntwo\n", undefined);
		writeFileSync(file, "one\n2\nthree\n"); // file changed out-of-band
		const tag = fileHash("one\ntwo\n");
		const patch = Patch.parse(`[a.ts#${tag}]\nPUT 2.=2:\n+TWO`, { cwd: dir, path: undefined });
		expect(() => stagePatch(patch, store, dir, `[a.ts#${tag}]\nPUT 2.=2:\n+TWO`, false)).toThrowError(
			/[Rr]e-read the file/,
		);
		expect(readFileSync(file, "utf8")).toBe("one\n2\nthree\n");
	});

	it("rejects an unknown tag ('not from this session')", () => {
		const file = path.join(dir, "b.ts");
		writeFileSync(file, "one\n");
		const store = new EditStore();
		const patch = Patch.parse("[b.ts#DEAD]\nPUT 1.=1:\n+ONE", { cwd: dir, path: undefined });
		expect(() => stagePatch(patch, store, dir, "x", false)).toThrowError(/not from this session/);
	});

	it("applies when the tag matches the live content", () => {
		const file = path.join(dir, "c.ts");
		writeFileSync(file, "one\ntwo\n");
		const store = new EditStore();
		const tag = fileHash("one\ntwo\n");
		const input = `[c.ts#${tag}]\nPUT 2.=2:\n+TWO`;
		const patch = Patch.parse(input, { cwd: dir, path: undefined });
		const { staged } = stagePatch(patch, store, dir, input, false);
		expect(staged[0].op).toBe("update");
		expect(staged[0].text).toBe("one\nTWO\n");
	});
});

describe("hashline-edit tool", () => {
	it("updates a file end-to-end and records a fresh snapshot", async () => {
		const file = path.join(dir, "d.ts");
		writeFileSync(file, "a\nb\nc\n");
		const store = new EditStore();
		const tag = fileHash("a\nb\nc\n");
		const tool = createHashlineToolDefinition(store);
		const result = await tool.execute("call-1", { input: `[d.ts#${tag}]\nPUT 2.=2:\n+B` }, undefined, undefined, {
			cwd: dir,
		} as never);
		expect(readFileSync(file, "utf8")).toBe("a\nB\nc\n");
		expect(result.content[0].type).toBe("text");
		expect(String((result.content[0] as { text: string }).text)).toContain("Updated d.ts");
		expect(store.head(file)?.text).toBe("a\nB\nc\n");
	});

	it("surfaces stale-tag rejection through the tool", async () => {
		const file = path.join(dir, "e.ts");
		writeFileSync(file, "x\n");
		const store = new EditStore();
		const tool = createHashlineToolDefinition(store);
		await expect(
			tool.execute("call-2", { input: "[e.ts#0000]\nPUT 1.=1:\n+Y" }, undefined, undefined, {
				cwd: dir,
			} as never),
		).rejects.toThrow(/not from this session|Re-read/);
		expect(readFileSync(file, "utf8")).toBe("x\n");
	});
});
