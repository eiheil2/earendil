import { describe, expect, it } from "vitest";
import {
	detectHarmonyLeak,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	isHarmonyLeakMitigationTarget,
	signalListLabel,
} from "../src/utils/harmony-leak.ts";

// Fixtures carry the marker in fenced blocks, in documentation prose, and in the
// leaked-tool-call shapes the errata describes. Each one defends a decision the
// agent loop makes: whether to discard a response and re-request it.

/** A response that leaked its Harmony protocol into prose, with a channel-word co-signal. */
const LEAKED_TEXT = "analysis to=functions.read\ncode\n<|channel|> still open";

/** Documentation that mentions the marker without leaking: no co-signal. */
const DOCUMENTATION_TEXT = "The detector matches the literal to=functions.read in this file.";

describe("detectHarmonyLeak", () => {
	it("trips on a marker paired with a channel-word co-signal", () => {
		const detection = detectHarmonyLeak(LEAKED_TEXT, "assistant_text");
		expect(detection).toBeDefined();
		expect(detection?.signals.length).toBeGreaterThan(0);
		expect(detection?.signals[0].classes).toContain("M");
		expect(detection?.signals[0].classes).toContain("C");
	});

	it("trips on a reserved harmony control token alone", () => {
		// `H` is a class in its own right, so a control token needs no co-signal.
		const detection = detectHarmonyLeak("prefix <|channel|> suffix", "assistant_text");
		expect(detection).toBeDefined();
		expect(detection?.signals[0].classes).toEqual(["H"]);
	});

	it("does not trip on the bare marker, which docs and tests legitimately carry", () => {
		expect(detectHarmonyLeak(DOCUMENTATION_TEXT, "assistant_text")).toBeUndefined();
	});

	it("does not trip on markers inside a fenced code block", () => {
		const fenced = ["```ts", "to=functions.read to=functions.write", "```"].join("\n");
		expect(detectHarmonyLeak(fenced, "assistant_text")).toBeUndefined();
	});

	it("ignores a fenced marker but still trips on the prose after the fence", () => {
		const mixed = ["```", "to=functions.read to=functions.write", "```", LEAKED_TEXT].join("\n");
		const detection = detectHarmonyLeak(mixed, "assistant_text");
		expect(detection).toBeDefined();
		const fenceEnd = mixed.indexOf("```", 3);
		// No signal points into the fenced block; the tripping one is past the closing fence.
		expect(detection?.signals.every((signal) => signal.start > fenceEnd)).toBe(true);
	});

	it("does not trip a tool argument without a trailing-marker co-signal", () => {
		// Tool arguments are file content; only content past the structured parse ends is
		// trustworthy. Without `parsedEnd` there is no boundary, so the surface is inert.
		const detection = detectHarmonyLeak(LEAKED_TEXT, "tool_arg");
		expect(detection).toBeUndefined();
	});

	it("trips a tool argument once the marker trails the structured parse", () => {
		const detection = detectHarmonyLeak(LEAKED_TEXT, "tool_arg", { parsedEnd: 0 });
		expect(detection).toBeDefined();
		expect(detection?.signals.some((signal) => signal.classes.includes("T"))).toBe(true);
	});
});

describe("detectHarmonyLeakInAssistantMessage", () => {
	it("reports which content block leaked so the removed text can be sliced", () => {
		const detection = detectHarmonyLeakInAssistantMessage({
			content: [
				{ type: "text", text: "clean preamble" },
				{ type: "text", text: LEAKED_TEXT },
			],
		});
		expect(detection?.contentIndex).toBe(1);
		expect(
			extractHarmonyRemoved(
				{
					content: [
						{ type: "text", text: "clean preamble" },
						{ type: "text", text: LEAKED_TEXT },
					],
				},
				detection!,
			),
		).toBe(LEAKED_TEXT.slice(detection!.signals[0].start));
	});

	it("scans thinking blocks, not just visible text", () => {
		const detection = detectHarmonyLeakInAssistantMessage({
			content: [{ type: "thinking", thinking: LEAKED_TEXT }],
		});
		expect(detection?.surface).toBe("assistant_thinking");
	});

	it("stays inert on a clean response", () => {
		expect(detectHarmonyLeakInAssistantMessage({ content: [{ type: "text", text: "all good" }] })).toBeUndefined();
	});

	it("leaves tool arguments inert, because the loop cannot bound a streamed tool DSL", () => {
		// Both a free-form `input` string and a JSON-shaped argument carry the marker, but
		// without a structured-parse boundary there is no trustworthy leak signal, so the
		// agent loop must not abort on a legitimate tool call.
		const freeForm = detectHarmonyLeakInAssistantMessage({
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { input: LEAKED_TEXT } }],
		});
		expect(freeForm).toBeUndefined();
		const jsonShaped = detectHarmonyLeakInAssistantMessage({
			content: [{ type: "toolCall", id: "call-2", name: "grep", arguments: { pattern: LEAKED_TEXT } }],
		});
		expect(jsonShaped).toBeUndefined();
	});
});

describe("isHarmonyLeakMitigationTarget", () => {
	it("covers only the provider whose vendored rules declare the mitigation axis", () => {
		expect(isHarmonyLeakMitigationTarget({ provider: "openai-codex" })).toBe(true);
		// gpt-oss models leak on the same dialect but are served by many other providers,
		// none of which declares the axis in the rule tree pi carries.
		expect(isHarmonyLeakMitigationTarget({ provider: "groq" })).toBe(false);
		expect(isHarmonyLeakMitigationTarget({ provider: "openai" })).toBe(false);
		expect(isHarmonyLeakMitigationTarget({})).toBe(false);
	});
});

describe("signalListLabel", () => {
	it("joins distinct class sets and reports none for an empty signal list", () => {
		expect(signalListLabel([{ classes: ["M", "C"], start: 0, end: 1, text: "" }])).toBe("M+C");
		expect(signalListLabel([])).toBe("none");
	});
});
