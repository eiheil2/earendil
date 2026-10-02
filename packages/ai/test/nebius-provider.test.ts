import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "../src/models.ts";
import { builtinModels, getBuiltinModels } from "../src/providers/all.ts";
import { nebiusProvider } from "../src/providers/nebius.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

function nebiusModel(): Model<"openai-completions"> {
	const models = getBuiltinModels("nebius");
	if (models.length === 0) throw new Error("nebius catalog is empty");
	const model = models[0];
	if (model.api !== "openai-completions") throw new Error(`unexpected api: ${model.api}`);
	return model;
}

function openAiCompletionsSse(modelId: string, text: string): string {
	const chunks = [
		{
			id: "chatcmpl-phase1",
			object: "chat.completion.chunk",
			created: 1,
			model: modelId,
			choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
		},
		{
			id: "chatcmpl-phase1",
			object: "chat.completion.chunk",
			created: 1,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 4,
				completion_tokens: 3,
				total_tokens: 7,
				prompt_tokens_details: { cached_tokens: 0 },
				completion_tokens_details: { reasoning_tokens: 0 },
			},
		},
	];
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function callUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("nebius provider end-to-end call (offline)", () => {
	it("streams a builtin nebius model through an injected fetch", async () => {
		const fallback = vi.fn<FetchFunction>(async () => {
			throw new Error("ambient fetch must not be called");
		});
		vi.stubGlobal("fetch", fallback);

		const model = nebiusModel();
		const payloadBodies: unknown[] = [];
		const responseStatuses: number[] = [];
		const custom = vi.fn<FetchFunction>(async () => {
			return new Response(openAiCompletionsSse(model.id, "hello from nebius"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const models = builtinModels();
		expect(
			models.getProviders().map((provider) => provider.id),
			"nebius must be registered in builtinModels()",
		).toContain("nebius");

		const resolved = models.getModel("nebius", model.id);
		if (!resolved) throw new Error(`nebius model ${model.id} not resolvable`);
		expect(resolved.provider).toBe("nebius");
		expect(resolved.api).toBe("openai-completions");

		const submission = models.streamSimple(resolved, context, {
			apiKey: "phase1-test-key",
			fetch: custom,
			maxRetries: 0,
			onPayload: (payload) => {
				payloadBodies.push(payload);
			},
			onResponse: (response) => {
				responseStatuses.push(response.status);
			},
		});

		const eventTypes: string[] = [];
		for await (const event of submission) eventTypes.push(event.type);
		const message = await submission.result();

		expect(eventTypes[0]).toBe("start");
		expect(eventTypes).toContain("text_delta");
		expect(eventTypes.at(-1)).toBe("done");
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "hello from nebius" }]);
		expect(message.usage.totalTokens).toBeGreaterThan(0);

		expect(custom).toHaveBeenCalledOnce();
		expect(fallback).not.toHaveBeenCalled();

		const [input, init] = custom.mock.calls[0];
		expect(callUrl(input)).toBe(`${resolved.baseUrl}/chat/completions`);
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer phase1-test-key");

		expect(payloadBodies).toHaveLength(1);
		expect(payloadBodies[0]).toMatchObject({ model: model.id, stream: true });
		expect(responseStatuses).toEqual([200]);
	});

	it("registers, re-registers, and isolates the provider", () => {
		const isolated = createModels();
		isolated.setProvider(nebiusProvider());
		expect(isolated.getProviders().map((provider) => provider.id)).toEqual(["nebius"]);
		expect(isolated.getModels().length).toBeGreaterThan(0);
		expect(isolated.getModels().every((model) => model.provider === "nebius")).toBe(true);

		// Re-registration replaces instead of duplicating.
		isolated.setProvider(nebiusProvider());
		expect(isolated.getProviders().map((provider) => provider.id)).toEqual(["nebius"]);

		// A collection built from the builtin set still carries every pre-existing provider.
		const builtin = builtinModels()
			.getProviders()
			.map((provider) => provider.id);
		expect(builtin).toContain("anthropic");
		expect(builtin).toContain("cerebras");
		expect(builtin.filter((id) => id === "nebius")).toHaveLength(1);
	});
});
