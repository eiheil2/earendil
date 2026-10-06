import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAssets, listProviders } from "../../src/core/discovery/index.ts";

let home: string;
let cwd: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-discovery-home-"));
	cwd = mkdtempSync(join(tmpdir(), "pi-discovery-cwd-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

function make(rel: string, base: "home" | "cwd" = "home"): string {
	const baseDir = base === "home" ? home : cwd;
	const target = join(baseDir, rel);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, "{}", "utf-8");
	return target;
}

describe("capability-provider registry", () => {
	it("registers at least 6 external formats (Claude/Cursor/Codex/Gemini/Copilot/Windsurf)", () => {
		const ids = listProviders().map((provider) => provider.id);
		for (const id of ["claude", "cursor", "codex", "gemini", "github", "windsurf", "vscode", "opencode", "cline"]) {
			expect(ids).toContain(id);
		}
	});
});

describe("discoverAssets", () => {
	it("finds Claude Code config in the user home", async () => {
		const expected = make(".claude.json");
		const items = await discoverAssets({ home, cwd });
		const hit = items.find((item) => item.provider === "claude");
		expect(hit?.path).toBe(expected);
		expect(hit?.providerName).toBe("Claude Code");
		expect(hit?.level).toBe("user");
	});

	it("finds Cursor rules in the project", async () => {
		const expected = make(".cursorrules", "cwd");
		const items = await discoverAssets({ home, cwd });
		expect(items.some((item) => item.provider === "cursor" && item.path === expected)).toBe(true);
	});

	it("finds Codex AGENTS.md", async () => {
		const expected = make(".codex/AGENTS.md");
		const items = await discoverAssets({ home, cwd });
		expect(items.some((item) => item.provider === "codex" && item.path === expected)).toBe(true);
	});

	it("finds Gemini settings", async () => {
		const expected = make(".gemini/settings.json");
		const items = await discoverAssets({ home, cwd });
		expect(items.some((item) => item.provider === "gemini" && item.path === expected)).toBe(true);
	});

	it("finds GitHub Copilot instructions", async () => {
		const expected = make(".github/copilot-instructions.md", "cwd");
		const items = await discoverAssets({ home, cwd });
		expect(items.some((item) => item.provider === "github" && item.path === expected)).toBe(true);
	});

	it("finds Windsurf rules", async () => {
		const expected = make(".windsurfrules", "cwd");
		const items = await discoverAssets({ home, cwd });
		expect(items.some((item) => item.provider === "windsurf" && item.path === expected)).toBe(true);
	});

	it("finds VS Code settings", async () => {
		const expected = make(".vscode/settings.json");
		const items = await discoverAssets({ home, cwd });
		expect(items.some((item) => item.provider === "vscode" && item.path === expected)).toBe(true);
	});

	it("finds OpenCode config", async () => {
		const expected = make("opencode.json", "cwd");
		const items = await discoverAssets({ home, cwd });
		expect(items.some((item) => item.provider === "opencode" && item.path === expected)).toBe(true);
	});

	it("finds Cline .clinerules by walking up from cwd", async () => {
		const expected = make(".clinerules", "cwd");
		const nested = join(cwd, "sub", "dir");
		mkdirSync(nested, { recursive: true });
		const items = await discoverAssets({ home, cwd: nested });
		expect(items.some((item) => item.provider === "cline" && item.path === expected)).toBe(true);
	});

	it("returns nothing and writes nothing when there are no fixtures", async () => {
		const items = await discoverAssets({ home, cwd });
		expect(items).toEqual([]);
	});

	it("reports every item with a source path and provider (AC-E03 来源)", async () => {
		make(".claude.json");
		make(".cursorrules", "cwd");
		const items = await discoverAssets({ home, cwd });
		expect(items.length).toBeGreaterThanOrEqual(2);
		for (const item of items) {
			expect(item.path.length).toBeGreaterThan(0);
			expect(item.provider.length).toBeGreaterThan(0);
			expect(item.id).toContain(item.provider);
		}
	});
});
