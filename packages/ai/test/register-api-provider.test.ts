import { afterEach, describe, expect, it } from "vitest";
import { getApiProvider, registerApiProvider, streamSimple, unregisterApiProviders } from "../src/compat.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Api, Model, TranscriptContext } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// The whole point of this test: the api id is not a KnownApi member, so the
// additive path must work without touching types.ts:17-27 or ApiOptionsMap.
const DEMO_API = "phase1-demo-api" as Api;
const SOURCE_ID = "phase1-demo-source";
const context: TranscriptContext = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function demoModel(): Model<Api> {
	return {
		id: "phase1-demo-model",
		name: "Phase 1 Demo Model",
		api: DEMO_API,
		provider: "phase1-demo",
		baseUrl: "https://phase1.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function respond(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = fauxAssistantMessage("phase1 demo ok");
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

afterEach(() => {
	unregisterApiProviders(SOURCE_ID);
});

describe("registerApiProvider without a KnownApi member", () => {
	it("dispatches streamSimple by model.api", async () => {
		registerApiProvider({ api: DEMO_API, stream: respond, streamSimple: respond }, SOURCE_ID);
		expect(getApiProvider(DEMO_API)).toBeDefined();

		const result = await streamSimple(demoModel(), context).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "phase1 demo ok" }]);
	});

	it("unloads by sourceId and then refuses to dispatch", () => {
		registerApiProvider({ api: DEMO_API, stream: respond, streamSimple: respond }, SOURCE_ID);
		unregisterApiProviders(SOURCE_ID);

		expect(getApiProvider(DEMO_API)).toBeUndefined();
		expect(() => streamSimple(demoModel(), context)).toThrow("No API provider registered for api: phase1-demo-api");
	});
});
