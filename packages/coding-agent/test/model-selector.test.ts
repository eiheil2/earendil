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

	it("reaches the full catalog by tab and filters it by facet, keeping the credential scopes reachable", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: false },
			],
		});
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-1")!,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const rendered = (): string => stripAnsi(selector.render(120).join("\n"));
		await vi.waitFor(() => {
			expect(rendered()).toContain("Model catalogs refreshed.");
		});

		// Tab cycles into the catalog scope, which browses models no credential covers.
		selector.handleInput("\t");
		const catalogView = rendered();
		expect(catalogView).toContain("catalog");
		expect(catalogView).toMatch(/\d+ models/);
		expect(catalogView).toContain("providers ·");

		// A provider facet narrows the whole catalog (thousands of rows) to the two models
		// the harness registered, and the header reports that narrow range.
		for (const char of "provider:faux") {
			selector.handleInput(char);
		}
		const faceted = rendered().replace(/[ \t]+\n/g, "\n");
		expect(faceted).toMatch(/2 models\n\s+1 providers · 1 apis · \$0\/M in/);

		// Tab returns to the credential-backed scope. The facet query does not leak into it,
		// because `provider:faux` means nothing to a plain fuzzy match.
		selector.handleInput("\t");
		expect(rendered()).toContain("alpha-1 [");
		expect(rendered()).not.toContain("No matching models");
		selector.dispose();
	});

	it("keeps a too-narrow catalog query from dead-ending on /login guidance", async () => {
		harness = await createHarness({
			models: [{ id: "alpha-1", name: "Alpha One", reasoning: true }],
		});
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-1")!,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const rendered = (): string => stripAnsi(selector.render(120).join("\n"));

		selector.handleInput("\t");
		for (const char of "ctx:99m") {
			selector.handleInput(char);
		}
		// No model in the catalog has a 99M window, so the list empties. The /login
		// guidance belongs to the credential-backed scopes; here it would be a wrong turn.
		expect(rendered()).toContain("No catalog models match this query");
		expect(rendered()).toContain("0 models");
		selector.dispose();
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
