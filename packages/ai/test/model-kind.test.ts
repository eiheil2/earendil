import { describe, expect, it } from "vitest";
import { isModelKind } from "../src/models.ts";
import { builtinModels, getBuiltinModels } from "../src/providers/all.ts";
import type { KnownModelKind, Model, ModelKind } from "../src/types.ts";

function textModel(): Model<"openai-completions"> {
	return {
		id: "phase1-kind-model",
		name: "Phase 1 Kind Model",
		api: "openai-completions",
		provider: "phase1-kind",
		baseUrl: "https://phase1.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

describe("ModelKind axis", () => {
	it("accepts reserved known kinds and arbitrary strings", () => {
		const reserved: ModelKind = "cursor-agent";
		const reserved2: ModelKind = "devin-agent";
		const open: ModelKind = "phase1-anything-goes";
		expect([reserved, reserved2, open]).toEqual(["cursor-agent", "devin-agent", "phase1-anything-goes"]);

		// KnownModelKind stays a literal union for autocomplete.
		const known: KnownModelKind[] = ["cursor-agent", "devin-agent"];
		expect(known).toHaveLength(2);
	});

	it("reads the optional kind and defaults to unclassified", () => {
		const unclassified = textModel();
		expect(unclassified.kind).toBeUndefined();
		expect(isModelKind(unclassified, "cursor-agent")).toBe(false);

		const classified: Model<"openai-completions"> = { ...unclassified, kind: "cursor-agent" };
		expect(classified.kind).toBe("cursor-agent");
		expect(isModelKind(classified, "cursor-agent")).toBe(true);
		expect(isModelKind(classified, "devin-agent")).toBe(false);
	});

	it("leaves every existing builtin catalog entry unclassified", () => {
		const models = builtinModels();
		expect(models.getModels().length).toBeGreaterThan(0);
		// Sample across providers instead of iterating thousands of entries.
		const sample = ["anthropic", "cerebras", "nebius", "openai", "openrouter"] as const;
		for (const provider of sample) {
			const list = getBuiltinModels(provider);
			expect(list.length, `${provider} should have models`).toBeGreaterThan(0);
			for (const model of list) {
				expect(model.kind, `${provider}/${model.id} must stay unclassified in Phase 1`).toBeUndefined();
			}
		}
	});
});
