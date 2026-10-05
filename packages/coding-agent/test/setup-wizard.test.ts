import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { runSetupScene, type SetupSceneHost, writeLocalEndpointProvider } from "../src/cli/setup-scenes.ts";
import {
	CURRENT_SETUP_VERSION,
	readSetupState,
	SETUP_SCENES,
	type SetupSceneId,
	selectSetupScenes,
	setupSkipEnvEnabled,
} from "../src/cli/setup-wizard.ts";
import { shouldShowStartupSplash } from "../src/cli/startup-splash.ts";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR, getAuthPath, getModelsPath } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { restoreModelFromSession } from "../src/core/model-resolver.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	formatModelCandidateMeta,
	isSubscriptionBackedProvider,
} from "../src/modes/interactive/model-candidate-meta.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const KEYS = {
	down: "\x1b[B",
	enter: "\n",
	escape: "\x1b",
} as const;

function stubRuntime(overrides: Partial<ModelRuntime> = {}): ModelRuntime {
	return {
		getProviders: () => [],
		getAvailable: async () => [],
		getAvailableSnapshot: () => [],
		isUsingSubscription: () => false,
		hasConfiguredAuth: () => false,
		...overrides,
	} as unknown as ModelRuntime;
}

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

describe("setup wizard gates", () => {
	it("orders scenes credentials → model → appearance", () => {
		expect(
			selectSetupScenes({ version: 0, completedScenes: [] }, { isTTY: true, skipEnv: undefined }).map((s) => s.id),
		).toEqual(["credentials", "model", "appearance"]);
	});

	it("hides the wizard without a TTY (AC-B04)", () => {
		expect(selectSetupScenes({ version: 0, completedScenes: [] }, { isTTY: false })).toEqual([]);
	});

	it("hides the wizard while resuming a session (AC-B03)", () => {
		expect(selectSetupScenes({ version: 0, completedScenes: [] }, { isTTY: true, resuming: true })).toEqual([]);
	});

	it("honors PI_SKIP_SETUP, including its opt-out values", () => {
		const state = { version: 0, completedScenes: [] as SetupSceneId[] };
		expect(selectSetupScenes(state, { isTTY: true, skipEnv: "1" })).toEqual([]);
		expect(selectSetupScenes(state, { isTTY: true, skipEnv: "true" })).toEqual([]);
		expect(selectSetupScenes(state, { isTTY: true, skipEnv: "0" })).toHaveLength(3);
		expect(selectSetupScenes(state, { isTTY: true, skipEnv: "no" })).toHaveLength(3);
		expect(setupSkipEnvEnabled(undefined)).toBe(false);
	});

	it("only runs scenes newer than the stored version (AC-B02)", () => {
		const owed = selectSetupScenes(
			{ version: CURRENT_SETUP_VERSION, completedScenes: [] },
			{ isTTY: true, skipEnv: undefined },
		);
		expect(owed).toEqual([]);
	});

	it("skips scenes the user already recorded", () => {
		const owed = selectSetupScenes(
			{ version: 0, completedScenes: ["credentials"] },
			{ isTTY: true, skipEnv: undefined },
		);
		expect(owed.map((s) => s.id)).toEqual(["model", "appearance"]);
	});

	it("keeps CURRENT_SETUP_VERSION equal to the highest scene version", () => {
		expect(CURRENT_SETUP_VERSION).toBe(Math.max(...SETUP_SCENES.map((scene) => scene.minVersion)));
	});
});

describe("readSetupState", () => {
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-setup-state-"));
		settingsPath = join(tempDir, "settings.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("treats a missing file as a fresh install", () => {
		expect(readSetupState(settingsPath)).toEqual({ version: 0, completedScenes: [] });
	});

	it("treats a pre-wizard settings file as already set up", () => {
		writeFileSync(settingsPath, "{}", "utf-8");
		expect(readSetupState(settingsPath)).toEqual({ version: CURRENT_SETUP_VERSION, completedScenes: [] });
	});

	it("resumes an interrupted run at version 0 with its recorded scenes", () => {
		writeFileSync(settingsPath, JSON.stringify({ setupCompletedScenes: ["credentials"] }), "utf-8");
		expect(readSetupState(settingsPath)).toEqual({ version: 0, completedScenes: ["credentials"] });
	});

	it("reads a stamped version", () => {
		writeFileSync(settingsPath, JSON.stringify({ setupVersion: 0, setupCompletedScenes: [] }), "utf-8");
		expect(readSetupState(settingsPath)).toEqual({ version: 0, completedScenes: [] });
	});

	it("ignores corrupt settings instead of blocking startup", () => {
		writeFileSync(settingsPath, "not json", "utf-8");
		expect(readSetupState(settingsPath)).toEqual({ version: 0, completedScenes: [] });
	});
});

describe("shouldRunFirstTimeSetup", () => {
	let tempDir: string;
	let settingsPath: string;
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-setup-gate-"));
		settingsPath = join(tempDir, "settings.json");
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
	});

	it("runs without any experimental flag (AC-B01)", () => {
		delete process.env.PI_EXPERIMENTAL;
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("does not run once the wizard stamped its version (AC-B02)", () => {
		writeFileSync(settingsPath, JSON.stringify({ setupVersion: CURRENT_SETUP_VERSION }), "utf-8");
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("does not run for a legacy install that predates the wizard", () => {
		writeFileSync(settingsPath, "{}", "utf-8");
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});

describe("setup completion persistence", () => {
	it("stamps the version and clears partial scene progress", async () => {
		const settingsManager = SettingsManager.inMemory();

		settingsManager.markSetupSceneCompleted("credentials");
		settingsManager.markSetupSceneCompleted("model");
		expect(settingsManager.getSetupCompletedScenes()).toEqual(["credentials", "model"]);
		expect(settingsManager.getSetupVersion()).toBeUndefined();

		settingsManager.completeSetup(CURRENT_SETUP_VERSION);
		expect(settingsManager.getSetupVersion()).toBe(CURRENT_SETUP_VERSION);
		expect(settingsManager.getSetupCompletedScenes()).toEqual([]);
		await settingsManager.flush();
	});
});

describe("shouldShowStartupSplash", () => {
	const base = {
		configured: true,
		isInteractive: true,
		resuming: false,
		quiet: false,
		timing: false,
		stdinIsTTY: true as boolean | undefined,
		stdoutIsTTY: true as boolean | undefined,
	};

	it("runs for an enabled interactive TTY startup (AC-B06)", () => {
		expect(shouldShowStartupSplash(base)).toBe(true);
	});

	it("never runs when disabled, resuming, quiet, benchmarked, or non-interactive", () => {
		expect(shouldShowStartupSplash({ ...base, configured: false })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, isInteractive: false })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, resuming: true })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, quiet: true })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, timing: true })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, stdinIsTTY: undefined })).toBe(false);
		expect(shouldShowStartupSplash({ ...base, stdoutIsTTY: false })).toBe(false);
	});
});

describe("model candidate annotations (AC-C05)", () => {
	const model = {
		id: "test-model",
		provider: "test",
		name: "Test",
		contextWindow: 128_000,
		input: ["text", "image"],
		cost: { input: 0, output: 0 },
	} as unknown as Model<Api>;

	it("labels context window, image support, and billing", () => {
		expect(formatModelCandidateMeta(model, { subscription: false })).toBe("128k ctx · images · free");
		expect(formatModelCandidateMeta(model, { subscription: true })).toBe("128k ctx · images · subscription");
	});

	it("falls back to text-only and per-token pricing", () => {
		const textOnly = { ...model, input: ["text"], cost: { input: 3, output: 15 } } as unknown as Model<Api>;
		expect(formatModelCandidateMeta(textOnly, { subscription: false })).toBe("128k ctx · text only · $3/$15");
	});

	it("treats kimi-coding as subscription-backed", () => {
		expect(isSubscriptionBackedProvider(stubRuntime(), "kimi-coding")).toBe(true);
		expect(isSubscriptionBackedProvider(stubRuntime(), "anthropic")).toBe(false);
	});
});

describe("model fallback reporting (AC-C07)", () => {
	const fallbackModel = { provider: "openai", id: "gpt-4o" } as unknown as Model<Api>;

	it("names the reason and the final model when the saved model is gone", async () => {
		const runtime = stubRuntime({
			getModel: () => undefined,
			hasConfiguredAuth: () => false,
			getAvailableSnapshot: () => [fallbackModel],
		});

		const result = await restoreModelFromSession("anthropic", "claude-x", undefined, false, runtime);

		expect(result.model).toBe(fallbackModel);
		expect(result.fallbackMessage).toBe(
			"Could not restore model anthropic/claude-x (model no longer exists). Using openai/gpt-4o.",
		);
	});

	it("reports missing credentials apart from a missing model", async () => {
		const runtime = stubRuntime({
			getModel: () => fallbackModel,
			hasConfiguredAuth: () => false,
			getAvailableSnapshot: () => [fallbackModel],
		});

		const result = await restoreModelFromSession("openai", "gpt-4o", undefined, false, runtime);

		expect(result.fallbackMessage).toBe(
			"Could not restore model openai/gpt-4o (no auth configured). Using openai/gpt-4o.",
		);
	});
});

describe("local endpoint registration (AC-C03 exit 3)", () => {
	let tempDir: string;
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-setup-endpoint-"));
		process.env[ENV_AGENT_DIR] = tempDir;
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
	});

	it("merges a provider into models.json and keeps existing entries", () => {
		writeFileSync(
			getModelsPath(),
			JSON.stringify({ providers: { existing: { baseUrl: "https://example.test/v1", models: [{ id: "keep" }] } } }),
			"utf-8",
		);

		writeLocalEndpointProvider({
			baseUrl: "http://localhost:11434/v1",
			providerId: "ollama",
			modelId: "qwen2.5-coder:7b",
			apiKey: "",
		});

		const written = JSON.parse(readFileSync(getModelsPath(), "utf-8")) as {
			providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: Array<{ id: string }> }>;
		};
		expect(written.providers.existing?.baseUrl).toBe("https://example.test/v1");
		expect(written.providers.ollama).toEqual({
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			apiKey: "local",
			models: [{ id: "qwen2.5-coder:7b" }],
		});
	});

	it("replaces a provider entry with the same model id instead of duplicating it", () => {
		writeLocalEndpointProvider({ baseUrl: "http://a.test/v1", providerId: "p", modelId: "m", apiKey: "k" });
		writeLocalEndpointProvider({ baseUrl: "http://b.test/v1", providerId: "p", modelId: "m", apiKey: "k2" });

		const written = JSON.parse(readFileSync(getModelsPath(), "utf-8")) as {
			providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }>;
		};
		expect(written.providers.p?.baseUrl).toBe("http://b.test/v1");
		expect(written.providers.p?.models).toHaveLength(1);
	});
});

describe("setup scenes on a headless TTY", () => {
	let terminal: VirtualTerminal;
	let ui: TUI;
	let settingsManager: SettingsManager;
	let host: SetupSceneHost;

	beforeEach(() => {
		process.env.PI_OFFLINE = "1";
		setKeybindings(KeybindingsManager.create());
		initTheme("dark");
		terminal = new VirtualTerminal(120, 40);
		ui = new TuiMainScreen(terminal);
		ui.start();
		settingsManager = SettingsManager.inMemory();
		const runtime = stubRuntime();
		host = {
			ui,
			settingsManager,
			createModelRuntime: async () => runtime,
		};
	});

	afterEach(() => {
		ui.stop();
		delete process.env.PI_OFFLINE;
	});

	it('records the credentials scene when the user picks "Set up later" (AC-C03 exit 4)', async () => {
		const run = runSetupScene("credentials", host);
		await tick();
		terminal.sendInput(KEYS.down);
		terminal.sendInput(KEYS.down);
		terminal.sendInput(KEYS.down);
		await tick();
		terminal.sendInput(KEYS.enter);

		expect(await withTimeout(run, "credentials scene")).toBe("recorded");
	});

	it("defers the credentials scene when the menu is cancelled (AC-B03)", async () => {
		const run = runSetupScene("credentials", host);
		await tick();
		terminal.sendInput(KEYS.escape);
		await tick(300);

		expect(await withTimeout(run, "credentials cancel")).toBe("deferred");
	});

	it("continues the model scene without a model when no credentials are configured (AC-C05)", async () => {
		const run = runSetupScene("model", host);
		await tick();
		terminal.sendInput(KEYS.enter);

		expect(await withTimeout(run, "model scene")).toBe("recorded");
		expect(settingsManager.getDefaultModel()).toBeUndefined();
	});

	it("discloses where an API key is stored and with which modes (AC-C04)", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-setup-apikey-"));
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		let releaseLogin: (() => void) | undefined;
		const loginFinished = new Promise<void>((resolve) => {
			releaseLogin = resolve;
		});
		const provider = {
			id: "acme",
			name: "Acme",
			auth: { apiKey: { name: "Acme API key", login: async () => ({ key: "sk-test" }) } },
		} as unknown as Provider<Api>;
		const runtime = stubRuntime({
			getProviders: () => [provider],
			getProviderAuthStatus: () => ({ configured: false }),
			login: async () => {
				await loginFinished;
				return { type: "api_key", key: "sk-test" };
			},
		});

		try {
			const run = runSetupScene("credentials", { ...host, createModelRuntime: async () => runtime });
			await tick();
			terminal.sendInput(KEYS.down); // "Use an API key"
			terminal.sendInput(KEYS.enter);
			await terminal.waitForRender();
			terminal.sendInput(KEYS.enter); // the only provider
			await terminal.waitForRender();

			const screen = terminal.getScrollBuffer().join("\n");
			expect(screen).toContain(`Stored in: ${getAuthPath()}`);
			expect(screen).toContain("File mode 600, directory mode 700 (owner only).");
			expect(screen).toContain("Never written to environment variables.");

			releaseLogin?.();
			expect(await withTimeout(run, "api key login")).toBe("recorded");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("records the appearance scene on submit (AC-B05 order, scene 3)", async () => {
		const run = runSetupScene("appearance", host);
		await tick();
		terminal.sendInput(KEYS.enter); // theme step → analytics step
		await tick();
		terminal.sendInput(KEYS.enter); // finish

		expect(await withTimeout(run, "appearance scene")).toBe("recorded");
		expect(settingsManager.getThemeSetting()).toBe("system");
		// The dialog's default selection is "Share anonymous usage data".
		expect(settingsManager.getEnableAnalytics()).toBe(true);
	});
});
