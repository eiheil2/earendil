import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONFIRM_SETTING_HINT,
	confirmationMechanismNotice,
	DEFAULT_PERMISSION_PRESET,
	isDestructiveCommand,
	PERMISSION_PRESETS,
	permissionBoundaryLines,
	requiresConfirmation,
	resolvePermissionPreset,
} from "../src/core/permission-gate.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const PRESET_NAMES = PERMISSION_PRESETS.map((preset) => preset.name);

describe("permission presets (AC-D06 three tiers)", () => {
	it("ships read-only, workspace-write and danger-full-access, defaulting to workspace-write", () => {
		expect(PRESET_NAMES).toEqual(["read-only", "workspace-write", "danger-full-access"]);
		expect(DEFAULT_PERMISSION_PRESET).toBe("workspace-write");
		expect(resolvePermissionPreset("danger-full-access").name).toBe("danger-full-access");
		// An unknown stored value must not throw; it falls back to the default tier.
		expect(resolvePermissionPreset("no-such-preset").name).toBe("workspace-write");
		expect(resolvePermissionPreset(undefined).name).toBe("workspace-write");
	});

	it("keeps the DSH description strings for the two presets DSH ships", () => {
		expect(resolvePermissionPreset("workspace-write").description).toBe(
			"Write inside the working directory and permitted temporary directories; destructive commands require approval.",
		);
		expect(resolvePermissionPreset("danger-full-access").description).toBe(
			"Full file access without approval prompts.",
		);
	});

	it("differs by approval scope: every command / destructive commands / never", () => {
		expect(resolvePermissionPreset("read-only").confirm).toBe("all");
		expect(resolvePermissionPreset("workspace-write").confirm).toBe("destructive");
		expect(resolvePermissionPreset("danger-full-access").confirm).toBe("none");
		expect(resolvePermissionPreset("danger-full-access").approval).toBe("never");
	});
});

describe("destructive detection (ported from omp permission-gate)", () => {
	it("matches recursive delete, privilege escalation and permissive modes", () => {
		expect(isDestructiveCommand("rm -rf build")).toBe(true);
		expect(isDestructiveCommand("rm -fr build")).toBe(true);
		expect(isDestructiveCommand("rm -r --recursive node_modules")).toBe(true);
		expect(isDestructiveCommand("sudo apt remove git")).toBe(true);
		expect(isDestructiveCommand("chmod 777 /etc/passwd")).toBe(true);
	});

	it("matches the destructive git and Windows shell equivalents", () => {
		expect(isDestructiveCommand("git reset --hard HEAD~3")).toBe(true);
		expect(isDestructiveCommand("git clean -fd")).toBe(true);
		expect(isDestructiveCommand("git push --force origin main")).toBe(true);
		expect(isDestructiveCommand("Remove-Item -Recurse -Force build")).toBe(true);
		expect(isDestructiveCommand("del /f /s /q C:\\temp")).toBe(true);
		expect(isDestructiveCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
	});

	it("leaves ordinary commands alone", () => {
		expect(isDestructiveCommand("ls -la")).toBe(false);
		expect(isDestructiveCommand("npm run check")).toBe(false);
		expect(isDestructiveCommand("git status")).toBe(false);
		expect(isDestructiveCommand("")).toBe(false);
		expect(isDestructiveCommand("   ")).toBe(false);
		// "redistribute" must not trip the \bsudo\b pattern.
		expect(isDestructiveCommand("echo redistribute")).toBe(false);
	});
});

describe("requiresConfirmation", () => {
	const destructive = "rm -rf dist";
	const harmless = "npm run check";

	it("confirms destructive commands by default and lets harmless ones through", () => {
		expect(requiresConfirmation(destructive, { confirmDestructive: true })).toBe(true);
		expect(requiresConfirmation(harmless, { confirmDestructive: true })).toBe(false);
	});

	it("is the one-click off switch: the setting wins over every preset", () => {
		for (const preset of PRESET_NAMES) {
			expect(requiresConfirmation(destructive, { confirmDestructive: false, preset })).toBe(false);
		}
	});

	it("never confirms under danger-full-access (DSH approval: never)", () => {
		expect(requiresConfirmation(destructive, { confirmDestructive: true, preset: "danger-full-access" })).toBe(false);
		expect(requiresConfirmation(harmless, { confirmDestructive: true, preset: "danger-full-access" })).toBe(false);
	});

	it("confirms every command under read-only and only destructive ones under workspace-write", () => {
		expect(requiresConfirmation(harmless, { confirmDestructive: true, preset: "read-only" })).toBe(true);
		expect(requiresConfirmation(harmless, { confirmDestructive: true, preset: "workspace-write" })).toBe(false);
		expect(requiresConfirmation(destructive, { confirmDestructive: true, preset: "workspace-write" })).toBe(true);
	});
});

describe("confirmation notice (AC-D06: explained before it first runs)", () => {
	it("explains the mechanism, the answer keys and the off switch on first use", () => {
		const notice = confirmationMechanismNotice({ firstTime: true, preset: "workspace-write" });
		expect(notice).toContain("Permission preset: workspace-write.");
		expect(notice).toContain("confirmed before they run");
		expect(notice).toContain('"Yes"');
		expect(notice).toContain("first confirmation");
		expect(notice).toContain(CONFIRM_SETTING_HINT);
		expect(notice).toContain("danger-full-access");
	});

	it("keeps the off switch visible after the first time", () => {
		const notice = confirmationMechanismNotice({ firstTime: false, preset: "read-only" });
		expect(notice).toContain(CONFIRM_SETTING_HINT);
		expect(notice).not.toContain("first confirmation");
	});
});

describe("permission boundary on the first screen (AC-D07)", () => {
	it("states the no-OS-sandbox boundary instead of leaving it in the README", () => {
		const lines = permissionBoundaryLines({
			preset: "workspace-write",
			confirmDestructive: true,
			cwd: "/home/dev/project",
		});

		expect(lines[0]).toContain('preset "workspace-write"');
		expect(lines[0]).toContain("confirmation on");
		expect(lines[1]).toContain("no built-in OS sandbox");
		expect(lines[1]).toContain("/home/dev/project");
		expect(lines[1]).toContain("Permissions & Containerization");
		expect(lines.join("\n")).toContain("confirmed");
		expect(lines.join("\n")).toContain("project-local skills, prompts and extensions stay unloaded");
	});

	it("reports confirmation off when the switch or the preset turns it off", () => {
		const switchedOff = permissionBoundaryLines({
			preset: "workspace-write",
			confirmDestructive: false,
			cwd: "C:\\work",
		});
		expect(switchedOff[0]).toContain("confirmation off");

		const presetOff = permissionBoundaryLines({
			preset: "danger-full-access",
			confirmDestructive: true,
			cwd: "C:\\work",
		});
		expect(presetOff[0]).toContain('preset "danger-full-access"');
		expect(presetOff[0]).toContain("confirmation off");
		expect(presetOff[0]).toContain("Full file access without approval prompts.");
	});
});

describe("settings persistence for the confirmation switch", () => {
	const testDir = join(tmpdir(), `pi-permission-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("defaults to confirmation on, workspace-write and an unseen notice", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getConfirmDestructive()).toBe(true);
		expect(manager.getPermissionPreset()).toBe("workspace-write");
		expect(manager.getDestructiveConfirmNoticeSeen()).toBe(false);
	});

	it("persists the one-click off switch and the preset to settings.json", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setConfirmDestructive(false);
		manager.setPermissionPreset("danger-full-access");
		manager.markDestructiveConfirmNoticeSeen();
		await manager.flush();

		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(saved.confirmDestructive).toBe(false);
		expect(saved.permissionPreset).toBe("danger-full-access");
		expect(saved.destructiveConfirmNoticeSeen).toBe(true);

		const restarted = SettingsManager.create(projectDir, agentDir);
		expect(restarted.getConfirmDestructive()).toBe(false);
		expect(restarted.getPermissionPreset()).toBe("danger-full-access");
		expect(restarted.getDestructiveConfirmNoticeSeen()).toBe(true);
	});

	it("keeps the default when nothing was written", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		await manager.flush();

		// flush() only writes settings that were modified, so no file appears at all;
		// a restart therefore reads back the defaults.
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		const restarted = SettingsManager.create(projectDir, agentDir);
		expect(restarted.getConfirmDestructive()).toBe(true);
		expect(restarted.getPermissionPreset()).toBe("workspace-write");
	});
});
