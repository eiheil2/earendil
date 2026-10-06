import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent, type StreamFn } from "../src/index.ts";

// All streams below are local stubs: no provider API is contacted.

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A GPT-5 codex response whose prose leaked the Harmony protocol mid-turn. */
const LEAKED_TEXT = "analysis to=functions.read\ncode\n<|channel|> still open";

function assistantMessage(provider: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		provider: provider as AssistantMessage["provider"],
		model: "mock",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Stream stub that replays a fixed script of response texts, one per request, so a
 * test can assert exactly how many times the loop re-requested a leaked response.
 */
interface ScriptedStream {
	streamFn: StreamFn;
	/** How many times the loop requested a response. */
	calls: () => number;
}

function createScriptedStreamFn(provider: string, responses: readonly string[]): ScriptedStream {
	let calls = 0;
	const streamFn: StreamFn = () => {
		const text = responses[Math.min(calls, responses.length - 1)];
		calls++;
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const message = assistantMessage(provider, text);
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return { streamFn, calls: () => calls };
}

/**
 * The mitigation gate keys on the configured model, so a test must start the agent on
 * a model whose provider declares the axis. `openai-codex` does; `openai` does not.
 */
function testModel(provider: string): Model<any> {
	return {
		id: "mock",
		name: "Mock",
		api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	} as Model<any>;
}

async function run(provider: string, responses: readonly string[]): Promise<{ calls: number; agent: Agent }> {
	const scripted = createScriptedStreamFn(provider, responses);
	const agent = new Agent({ streamFn: scripted.streamFn, initialState: { model: testModel(provider) } });
	await agent.prompt("hello");
	return { calls: scripted.calls(), agent };
}

function lastAssistant(agent: Agent): AssistantMessage {
	const last = agent.state.messages[agent.state.messages.length - 1];
	if (!last || last.role !== "assistant") throw new Error("expected a trailing assistant message");
	return last;
}

function lastAssistantText(agent: Agent): string | undefined {
	const last = agent.state.messages[agent.state.messages.length - 1];
	if (!last || last.role !== "assistant") return undefined;
	return last.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("Harmony leak recovery", () => {
	it("discards a leaked response and re-requests the turn", async () => {
		const { calls, agent } = await run("openai-codex", [LEAKED_TEXT, "clean answer"]);

		// One leaked attempt, then the retry that answered.
		expect(calls).toBe(2);
		expect(agent.state.errorMessage).toBeUndefined();
		expect(lastAssistantText(agent)).toBe("clean answer");
	});

	it("keeps the leaked text out of the transcript and context", async () => {
		const { agent } = await run("openai-codex", [LEAKED_TEXT, "clean answer"]);
		const serialized = JSON.stringify(agent.state.messages);
		expect(serialized).not.toContain("to=functions.read");
		// The discarded attempt left no assistant message behind either.
		expect(agent.state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	});

	it("escalates to a terminal error once the retry budget is spent", async () => {
		// Two retries means three attempts; leaking every time must not loop forever.
		const { calls, agent } = await run("openai-codex", [LEAKED_TEXT]);

		expect(calls).toBe(3);
		const last = lastAssistant(agent);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("gave up after 3 attempts");
		expect(agent.state.errorMessage).toContain("Harmony protocol leakage");
	});

	it("reports each discarded attempt through onHarmonyLeak", async () => {
		const scripted = createScriptedStreamFn("openai-codex", [LEAKED_TEXT, "clean answer"]);
		const attempts: number[] = [];
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: testModel("openai-codex") },
			onHarmonyLeak: ({ attempt }) => {
				attempts.push(attempt);
			},
		});
		await agent.prompt("hello");

		expect(attempts).toEqual([0]);
	});

	it("never fires the hook or retries for a non-mitigation provider", async () => {
		const scripted = createScriptedStreamFn("openai", [LEAKED_TEXT]);
		const attempts: number[] = [];
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: testModel("openai") },
			onHarmonyLeak: ({ attempt }) => {
				attempts.push(attempt);
			},
		});
		await agent.prompt("hello");

		// Same leaked-looking text, but only openai-codex declares the mitigation axis.
		expect(attempts).toEqual([]);
		expect(scripted.calls()).toBe(1);
		expect(lastAssistantText(agent)).toBe(LEAKED_TEXT);
	});
});
