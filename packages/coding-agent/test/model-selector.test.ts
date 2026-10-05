import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

/**
 * The harness lists every model whose provider has ambient credentials, so a developer shell with
 * `*_API_KEY` set changes the candidate list (and therefore the row order) these tests assert on.
 * Keys are hidden for the duration of the suite and restored afterwards.
 */
const CREDENTIAL_ENV_PATTERN = /(API_?KEY|TOKEN|OAUTH|CREDENTIAL|SECRET|PASSWORD)/i;

describe("model selector", () => {
	let harness: Harness | undefined;
	let savedCredentialEnv: Record<string, string>;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		savedCredentialEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && CREDENTIAL_ENV_PATTERN.test(key)) {
				savedCredentialEnv[key] = value;
				delete process.env[key];
			}
		}
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		for (const [key, value] of Object.entries(savedCredentialEnv)) process.env[key] = value;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		// Every row now ends with its context/image/billing annotation (AC-C05), so the marker
		// assertions compare the row without that suffix instead of the whole line.
		const annotation = / · \d+[kM]? ctx · (?:images|text only) · \S+$/;
		const expectRow = (id: string, marker: string): void => {
			const row = getModelRow(id) ?? "";
			expect(row).toMatch(annotation);
			expect(row.replace(annotation, "")).toBe(marker);
		};

		expectRow("current-model", `→ ✓ current-model [${currentModel.provider}]`);
		selector.handleInput("\x1b[B");
		expectRow("current-model", `  ✓ current-model [${currentModel.provider}]`);
		expectRow("browsed-model", `→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
