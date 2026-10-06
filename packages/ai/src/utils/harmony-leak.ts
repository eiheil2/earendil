/**
 * GPT-5 Harmony-header leakage detection.
 *
 * Ported from oh-my-pi `packages/ai/src/utils/harmony-leak.ts` (see
 * `docs/ERRATA-GPT5-HARMONY.md` there). Only the detection half is ported: signal
 * fusion over assistant text/thinking, the fenced-code exemption, and the audit
 * signal label. The recovery half (truncate-and-resume for a tool DSL) lives in
 * the agent loop because it is loop behavior, not a wire concern.
 *
 * Not ported, deliberately: `escapeHarmonyControlTokens` /
 * `escapeHarmonyControlTokensInJson`. pi has no harmony-dialect transport that
 * rejects reserved control tokens in a request, so there is nothing to escape.
 */

// Single source of truth for the marker pattern (`M` in the errata).
// Use a fresh non-global instance for `.test()` to avoid lastIndex pitfalls.
const MARKER_RE = /\bto=functions\.[A-Za-z_]\w*/g;
const HARMONY_RE = /<\|(start|end|channel|message|call|return)\|>/g;

// Channel-word adjacency (`C`): channel/role name appearing immediately before the marker.
const CHANNEL_WORD_RE = /\b(?:analysis|commentary|assistant|user|system|developer|tool)\s+to=functions\./;

// Glitch-token adjacency (`G`). The Japgolly literal is escaped so this regex
// source itself does not trip detection if the file is scanned (e.g. when
// editing this module via the same agent that detects).
const GLITCH_RE = /\b(?:changedFiles|RTLU|Jsii(?:_commentary)?|\x4aapgolly)\b/;

// Body-channel cascade (`B`): marker followed by ` code` then another marker
// within 200 chars. Single regex; no manual slicing needed.
const BODY_CASCADE_RE = /to=functions\.\w+\s+code\b[\s\S]{0,200}?to=functions\./;

// Fake-result framing (`R`): marker followed within 80 chars by Cell N: framing.
const FAKE_RESULT_RE = /to=functions\.\w+[\s\S]{0,80}?code_output\s*\nCell\s+\d+:/;

const FENCE_RE = /^\s*(?:```+|~~~+)/;

// Non-Latin scripts seen in the corpus: CJK + ext, Cyrillic, Thai, Georgian,
// Armenian, Kannada, Telugu, Devanagari, Arabic, Malayalam.
const SCRIPT_CLASS =
	"\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u0400-\\u04FF\\u0E00-\\u0E7F\\u10A0-\\u10FF" +
	"\\u0530-\\u058F\\u0C80-\\u0CFF\\u0C00-\\u0C7F\\u0900-\\u097F\\u0600-\\u06FF\\u0D00-\\u0D7F";
const SCRIPT_RUN_RE = new RegExp(`[${SCRIPT_CLASS}]{2,}`, "u");

const SIGNAL_ORDER = ["M", "C", "G", "S", "B", "R", "T"] as const;

export type HarmonySignalClass = "H" | (typeof SIGNAL_ORDER)[number];

export type HarmonySurface = "assistant_text" | "assistant_thinking" | "tool_arg";

export interface HarmonySignal {
	classes: HarmonySignalClass[];
	start: number;
	end: number;
	text: string;
}

export interface HarmonyDetection {
	surface: HarmonySurface;
	contentIndex?: number;
	toolName?: string;
	toolCallId?: string;
	signals: HarmonySignal[];
}

/** Contaminated substring of the message, from the first signal to end of block. */
export interface HarmonyRemoved {
	removed: string;
}

interface AssistantContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
}

interface AssistantLikeMessage {
	content: AssistantContentBlock[];
}

/**
 * Whether leak detection should run on responses from this model.
 *
 * oh-my-pi reads a `wire.harmonyLeakMitigation` axis from its KDL provider rules. The
 * vendored tree pi already carries declares exactly one such axis, scoped to provider
 * `openai-codex` with no model selector (`providers/openai-codex.kdl:3`), so provider
 * identity reproduces it exactly. This deliberately does not read the 411 KB rule
 * tree: doing so would drag it into pi's core barrel for one boolean.
 */
export function isHarmonyLeakMitigationTarget(model: { provider?: string }): boolean {
	return model.provider === "openai-codex";
}

/**
 * Detect harmony-protocol leakage in `text`. Returns undefined if clean.
 *
 * Trip rule: `H` alone, or `M` paired with at least one co-signal
 * (`C`/`G`/`S`/`B`/`R`/`T`). Bare `M` does not trip — documentation and tests
 * legitimately carry the marker.
 *
 * `parsedEnd`, when supplied, marks the byte at which a structurally valid
 * tool-argument parse ends; markers at or past it set the `T` co-signal.
 */
export function detectHarmonyLeak(
	text: string,
	surface: HarmonySurface,
	options: {
		parsedEnd?: number;
		contentIndex?: number;
		toolName?: string;
		toolCallId?: string;
	} = {},
): HarmonyDetection | undefined {
	const fences = computeFenceRanges(text);
	const signals: HarmonySignal[] = [];

	for (const match of text.matchAll(HARMONY_RE)) {
		const start = match.index ?? 0;
		if (isInsideFence(fences, start)) continue;
		signals.push(makeSignal(["H"], start, start + match[0].length, match[0]));
	}

	for (const match of text.matchAll(MARKER_RE)) {
		const start = match.index ?? 0;
		if (isInsideFence(fences, start)) continue;
		const end = start + match[0].length;
		const classes: HarmonySignalClass[] = ["M"];

		const adjacent = text.slice(Math.max(0, start - 64), Math.min(text.length, end + 16));
		const near = text.slice(Math.max(0, start - 16), Math.min(text.length, end + 16));
		const forward = text.slice(start, Math.min(text.length, start + 240));

		if (CHANNEL_WORD_RE.test(adjacent)) classes.push("C");
		if (GLITCH_RE.test(near)) classes.push("G");
		if (hasScriptMismatchNear(text, start, end)) classes.push("S");
		if (BODY_CASCADE_RE.test(forward)) classes.push("B");
		if (FAKE_RESULT_RE.test(forward)) classes.push("R");
		if (options.parsedEnd !== undefined && start >= options.parsedEnd) classes.push("T");

		// `M` alone never trips: legitimate documentation/tests carry it.
		if (classes.length > 1) {
			signals.push(makeSignal(classes, start, end, match[0]));
		}
	}

	if (signals.length === 0) return undefined;
	// Tool arguments are data: they can legitimately embed the marker, a channel
	// word, harmony control tokens, or a non-Latin script run. Only a marker
	// trailing the structurally-valid parse (`T`) is a reliable leak signal, so
	// refuse to trip a `tool_arg` detection without it.
	if (surface === "tool_arg" && !signals.some((s) => s.classes.includes("T"))) return undefined;
	signals.sort((a, b) => a.start - b.start || a.end - b.end);
	return {
		surface,
		contentIndex: options.contentIndex,
		toolName: options.toolName,
		toolCallId: options.toolCallId,
		signals,
	};
}

/**
 * Scan an assistant message's content blocks; return the first detection.
 *
 * The loop cannot bound a streamed tool DSL, so it calls this without
 * `toolArgParseEnd` and the `tool_arg` surface stays inert.
 */
export function detectHarmonyLeakInAssistantMessage(message: AssistantLikeMessage): HarmonyDetection | undefined {
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block.type === "text" && block.text !== undefined) {
			const d = detectHarmonyLeak(block.text, "assistant_text", { contentIndex: i });
			if (d) return d;
		} else if (block.type === "thinking" && block.thinking !== undefined) {
			const d = detectHarmonyLeak(block.thinking, "assistant_thinking", { contentIndex: i });
			if (d) return d;
		} else if (block.type === "toolCall") {
			const argText = getToolArgumentText(block);
			if (argText !== undefined) {
				const d = detectHarmonyLeak(argText, "tool_arg", {
					contentIndex: i,
					toolName: block.name,
					toolCallId: block.id,
				});
				if (d) return d;
			}
		}
	}
	return undefined;
}

/**
 * Return the contaminated substring of `message` for audit purposes. Walks from
 * the first detected signal to end-of-content within the relevant block. Returns
 * an empty string when the detection cannot be resolved against the message.
 */
export function extractHarmonyRemoved(message: AssistantLikeMessage, detection: HarmonyDetection): string {
	if (detection.contentIndex === undefined) return "";
	const block = message.content[detection.contentIndex];
	if (!block) return "";
	const start = detection.signals[0]?.start ?? 0;
	if (block.type === "text") return (block.text ?? "").slice(start);
	if (block.type === "thinking") return (block.thinking ?? "").slice(start);
	if (block.type === "toolCall") {
		const text = getToolArgumentText(block);
		return text ? text.slice(start) : "";
	}
	return "";
}

export function signalListLabel(signals: readonly HarmonySignal[]): string {
	const seen: string[] = [];
	for (const signal of signals) {
		const label = signal.classes.join("+");
		if (!seen.includes(label)) seen.push(label);
	}
	return seen.join(",") || "none";
}

// ─── internals ──────────────────────────────────────────────────────────────

function makeSignal(classes: HarmonySignalClass[], start: number, end: number, text: string): HarmonySignal {
	if (classes[0] === "H") return { classes: ["H"], start, end, text };
	const sorted: HarmonySignalClass[] = [];
	for (const cls of SIGNAL_ORDER) {
		if (classes.includes(cls)) sorted.push(cls);
	}
	return { classes: sorted, start, end, text };
}

/**
 * Precompute fenced-code-block ranges once per text. Each range is a
 * [start, end) span of bytes inside any ```/~~~ fence.
 */
function computeFenceRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let inFence = false;
	let fenceStart = 0;
	let lineStart = 0;
	while (lineStart <= text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? text.length : newline;
		const line = text.slice(lineStart, lineEnd);
		if (FENCE_RE.test(line)) {
			if (inFence) {
				ranges.push([fenceStart, lineEnd]);
				inFence = false;
			} else {
				fenceStart = lineStart;
				inFence = true;
			}
		}
		if (newline === -1) break;
		lineStart = newline + 1;
	}
	if (inFence) ranges.push([fenceStart, text.length]);
	return ranges;
}

function isInsideFence(ranges: Array<[number, number]>, position: number): boolean {
	for (const [start, end] of ranges) {
		if (position >= start && position < end) return true;
		if (start > position) break;
	}
	return false;
}

function hasScriptMismatchNear(text: string, start: number, end: number): boolean {
	const near = text.slice(Math.max(0, start - 32), Math.min(text.length, end + 32));
	if (!SCRIPT_RUN_RE.test(near)) return false;
	const surrounding = text.slice(Math.max(0, start - 200), Math.min(text.length, end + 200));
	if (surrounding.length === 0) return false;
	let ascii = 0;
	for (let i = 0; i < surrounding.length; i++) {
		if (surrounding.charCodeAt(i) < 128) ascii++;
	}
	return ascii / surrounding.length >= 0.85;
}

/**
 * Tool-call argument text used for detection scanning. For tools whose args
 * include a free-form `input` string we scan that directly so reported byte
 * offsets line up with the original. For everything else we fall back to a
 * JSON-stringified blob so detection still fires; that path's offsets are NOT
 * meaningful for slicing the original args.
 */
function getToolArgumentText(block: AssistantContentBlock): string | undefined {
	if (typeof block.arguments?.input === "string") return block.arguments.input;
	if (block.arguments === undefined) return undefined;
	try {
		return JSON.stringify(block.arguments);
	} catch {
		return undefined;
	}
}
