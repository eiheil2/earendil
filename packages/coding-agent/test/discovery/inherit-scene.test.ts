import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { runSetupScene, type SetupSceneHost } from "../../src/cli/setup-scenes.ts";
import { selectSetupScenes } from "../../src/cli/setup-wizard.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const KEYS = {
	down: "\x1b[B",
	enter: "\n",
	escape: "\x1b",
} as const;

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function stubRuntime(): ModelRuntime {
	return {
		getProviders: () => [],
		getAvailable: async () => [],
		getAvailableSnapshot: () => [],
		isUsingSubscription: () => false,
		hasConfiguredAuth: () => false,
	} as unknown as ModelRuntime;
}

describe("inherit scene (AC-E01/E02/E03)", () => {
	let terminal: VirtualTerminal;
	let ui: TUI;
	let settingsManager: SettingsManager;
	let host: SetupSceneHost;
	let home: string;
	let cwd: string;

	beforeEach(() => {
		process.env.PI_OFFLINE = "1";
		setKeybindings(KeybindingsManager.create());
		initTheme("dark");
		terminal = new VirtualTerminal(120, 40);
		ui = new TuiMainScreen(terminal);
		ui.start();
		settingsManager = SettingsManager.inMemory();
		home = mkdtempSync(join(tmpdir(), "pi-inherit-home-"));
		cwd = mkdtempSync(join(tmpdir(), "pi-inherit-cwd-"));
		host = {
			ui,
			settingsManager,
			createModelRuntime: async () => stubRuntime(),
			discoveryContext: { home, cwd },
		};
	});

	afterEach(() => {
		ui.stop();
		delete process.env.PI_OFFLINE;
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("records nothing when the user cancels (no silent import)", async () => {
		writeFileSync(join(home, ".claude.json"), "{}", "utf-8");
		const run = runSetupScene("inherit", host);
		await tick(300);
		terminal.sendInput(KEYS.escape);
		await tick(300);

		expect(await withTimeout(run, "inherit cancel")).toBe("deferred");
		expect(settingsManager.getInheritedAssets()).toEqual([]);
	});

	it("adopts only what the user confirms, with the source path (来源)", async () => {
		writeFileSync(join(home, ".claude.json"), "{}", "utf-8");
		writeFileSync(join(cwd, ".cursorrules"), "rules", "utf-8");
		const run = runSetupScene("inherit", host);
		await tick(300);
		terminal.sendInput(KEYS.enter); // Adopt the Claude item
		await tick(300);
		terminal.sendInput(KEYS.down);
		terminal.sendInput(KEYS.enter); // Skip the Cursor item
		await tick(300);
		terminal.sendInput(KEYS.enter); // Dismiss the summary notice

		expect(await withTimeout(run, "inherit adopt/skip")).toBe("recorded");
		const adopted = settingsManager.getInheritedAssets();
		expect(adopted).toHaveLength(1);
		expect(adopted[0]?.provider).toBe("claude");
		expect(adopted[0]?.enabled).toBe(true);
		expect(adopted[0]?.path).toContain(".claude.json");
	});

	it("supports 采纳 / 跳过 / 全部采纳 per item", async () => {
		writeFileSync(join(home, ".claude.json"), "{}", "utf-8");
		writeFileSync(join(cwd, ".cursorrules"), "rules", "utf-8");
		const run = runSetupScene("inherit", host);
		await tick(300);
		terminal.sendInput(KEYS.down);
		terminal.sendInput(KEYS.down);
		terminal.sendInput(KEYS.enter); // "Adopt all remaining"
		await tick(300);
		terminal.sendInput(KEYS.enter); // Dismiss the summary notice

		expect(await withTimeout(run, "inherit adopt all")).toBe("recorded");
		expect(settingsManager.getInheritedAssets()).toHaveLength(2);
	});

	it("labels each chooser with 来源：<path>", async () => {
		writeFileSync(join(home, ".claude.json"), "{}", "utf-8");
		const run = runSetupScene("inherit", host);
		await tick(300);
		const screen = terminal.getScrollBuffer().join("\n");
		expect(screen).toContain("来源：");
		expect(screen).toContain(".claude.json");
		terminal.sendInput(KEYS.escape);
		await tick(300);
		expect(await withTimeout(run, "inherit cancel after label check")).toBe("deferred");
	});

	it("records itself when there is nothing to import", async () => {
		const run = runSetupScene("inherit", host);

		expect(await withTimeout(run, "inherit empty")).toBe("recorded");
		expect(settingsManager.getInheritedAssets()).toEqual([]);
	});

	it("is gated like every other scene: no TTY means no inherit scene", () => {
		expect(selectSetupScenes({ version: 1, completedScenes: [] }, { isTTY: false })).toEqual([]);
		expect(
			selectSetupScenes({ version: 1, completedScenes: [] }, { isTTY: true, skipEnv: undefined }).map((s) => s.id),
		).toEqual(["inherit"]);
	});
});
