import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
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

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createAbortedMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: EMPTY_USAGE,
		stopReason: "aborted",
		errorMessage,
		timestamp: Date.now(),
	};
}

type DeadlineProbe = {
	/** Signal handed to each stream call. */
	signals: (AbortSignal | undefined)[];
	/** Whether the signal was already aborted when the stream function was called. */
	abortedAtCall: boolean[];
	/** `signal.reason` captured when the signal aborted. */
	abortReasons: unknown[];
};

/**
 * Stream stub that honors the run signal the way a provider stream does: it records the signal
 * it received, and ends with an aborted assistant message as soon as that signal aborts.
 */
function createProbeStreamFn(probe: DeadlineProbe): StreamFn {
	return (_model, _context, options) => {
		const signal = options?.signal;
		probe.signals.push(signal);
		probe.abortedAtCall.push(signal?.aborted === true);
		const stream = new MockAssistantStream();
		const settleOnAbort = () => {
			probe.abortReasons.push(signal?.reason);
			const reason = signal?.reason as Error | undefined;
			stream.push({ type: "error", reason: "aborted", error: createAbortedMessage(reason?.message ?? "") });
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: createAssistantMessage("") });
			if (signal?.aborted) {
				settleOnAbort();
			} else {
				signal?.addEventListener("abort", settleOnAbort, { once: true });
			}
		});
		return stream;
	};
}

function createProbe(): DeadlineProbe {
	return { signals: [], abortedAtCall: [], abortReasons: [] };
}

function lastMessage(agent: Agent): AssistantMessage {
	const message = agent.state.messages[agent.state.messages.length - 1];
	return message as AssistantMessage;
}

describe("Agent deadline", () => {
	it("aborts immediately with TimeoutError when the deadline already passed", async () => {
		const probe = createProbe();
		const agent = new Agent({ deadline: Date.now() - 1000, streamFn: createProbeStreamFn(probe) });

		// Resolves only because the run is aborted before the first stream call settles.
		await agent.prompt("hello");

		expect(probe.abortedAtCall).toEqual([true]);
		const reason = probe.signals[0]?.reason as Error;
		expect(reason.name).toBe("TimeoutError");
		expect(reason.message).toBe("Deadline exceeded");
		expect(probe.abortReasons).toEqual([reason]);
		expect(lastMessage(agent).stopReason).toBe("aborted");
		expect(agent.state.errorMessage).toBe("Deadline exceeded");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("aborts a live run when a future deadline passes, with error.name TimeoutError", async () => {
		const probe = createProbe();
		const agent = new Agent({ deadline: Date.now() + 50, streamFn: createProbeStreamFn(probe) });

		const startedAt = Date.now();
		await agent.prompt("hello");
		const elapsed = Date.now() - startedAt;

		// The run started before the deadline and was cut off when it passed.
		expect(probe.abortedAtCall).toEqual([false]);
		const error = probe.abortReasons[0] as Error;
		expect(error.name).toBe("TimeoutError");
		expect(elapsed).toBeGreaterThanOrEqual(40);
		expect(probe.signals[0]?.aborted).toBe(true);
		expect(lastMessage(agent).stopReason).toBe("aborted");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("lets an external abort() win when it fires before the deadline", async () => {
		const probe = createProbe();
		const agent = new Agent({ deadline: Date.now() + 200, streamFn: createProbeStreamFn(probe) });

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 20));
		agent.abort();
		await promptPromise;

		expect((probe.abortReasons[0] as Error).name).toBe("AbortError");
		expect(lastMessage(agent).stopReason).toBe("aborted");

		// Waiting past the deadline proves the folded timeout cannot overwrite the first abort.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((probe.signals[0]?.reason as Error).name).toBe("AbortError");
		expect(probe.abortReasons).toHaveLength(1);
	});

	it("keeps the TimeoutError reason when abort() follows the deadline", async () => {
		const probe = createProbe();
		const agent = new Agent({ deadline: Date.now() + 50, streamFn: createProbeStreamFn(probe) });

		await agent.prompt("hello");
		expect((probe.abortReasons[0] as Error).name).toBe("TimeoutError");

		// A late external abort must not replace the reason the deadline already produced.
		agent.abort();
		expect((probe.signals[0]?.reason as Error).name).toBe("TimeoutError");
		expect(probe.abortReasons).toHaveLength(1);
		expect(lastMessage(agent).stopReason).toBe("aborted");
	});
});
