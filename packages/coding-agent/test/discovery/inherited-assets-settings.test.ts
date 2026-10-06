import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

let agentDir: string;
let cwd: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-inherit-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "pi-inherit-cwd-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const sample = [
	{
		id: "claude:C:\\fake\\.claude.json",
		provider: "claude",
		providerName: "Claude Code",
		kind: "settings",
		path: "C:\\fake\\.claude.json",
		level: "user" as const,
		enabled: true,
	},
];

describe("inherited asset persistence", () => {
	it("defaults to an empty list (no silent import, AC-E02)", () => {
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getInheritedAssets()).toEqual([]);
	});

	it("persists adopted items across a reload", async () => {
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setInheritedAssets(sample);
		await manager.flush();

		const reloaded = SettingsManager.create(cwd, agentDir);
		expect(reloaded.getInheritedAssets()).toEqual(sample);
	});

	it("persists the per-item disable switch (AC-E03)", async () => {
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setInheritedAssets(sample);
		manager.setInheritedAssetEnabled(sample[0].id, false);
		await manager.flush();

		const reloaded = SettingsManager.create(cwd, agentDir);
		expect(reloaded.getInheritedAssets()[0]?.enabled).toBe(false);
		expect(reloaded.getInheritedAssets()[0]?.path).toBe(sample[0].path);
	});

	it("ignores disable toggles for unknown ids", () => {
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setInheritedAssets(sample);
		manager.setInheritedAssetEnabled("claude:C:\\nope", false);
		expect(manager.getInheritedAssets()[0]?.enabled).toBe(true);
	});
});
