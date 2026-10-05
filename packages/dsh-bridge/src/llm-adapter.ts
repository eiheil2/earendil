/**
 * LLM adapter: registers minimal cordis-style LLM event hooks on the pi
 * ExtensionAPI.
 *
 * For command-compact (inject = ['commands', 'compaction']) this adapter is a
 * no-op fallback; for LLM-facing plugins (llm-retry, hooks-codex) it provides
 * the minimal event surface. Fail-soft: a host without the event bus or a
 * refusing subscription degrades to silence; plugin startup survives.
 *
 * Constraint: chord facet path is CLOSED; event registration goes only through
 * ExtensionAPI `on()` (plan-plugin-contract §5, MERGE-FINAL §3 R4).
 */

import type { ExtensionApi } from "./cordis-context.ts";

/** Minimal event names the bridge may forward (subset of EXTENSION_EVENT_NAMES). */
export const MINIMUM_LLM_EVENT_NAMES = [
	"before_provider_request",
	"after_provider_response",
	"provider_stream_event",
	"agent_start",
	"agent_end",
	"tool_call",
	"tool_result",
] as const;

export type MinimumLlmEventName = (typeof MINIMUM_LLM_EVENT_NAMES)[number];

/**
 * Register no-op handlers for the minimal LLM event set.
 *
 * The handlers intentionally do not forward payloads to any provider; their
 * presence proves the subscription path. Each failure is contained per event.
 *
 * @param ext - host ExtensionAPI; missing `on` degrades to silence (fail-soft).
 * @returns an unsubscribe function aggregating all registrations.
 */
export function registerLlmEvents(ext: ExtensionApi): { unsubscribe: () => void } {
	const handlers: Array<() => void> = [];

	for (const eventName of MINIMUM_LLM_EVENT_NAMES) {
		if (typeof ext.on !== "function") {
			console.warn(`dsh-bridge: LLM events dropped; host has no event bus (fail-soft)`);
			break;
		}
		try {
			handlers.push(ext.on(eventName, () => {}));
		} catch (error) {
			console.warn(`dsh-bridge: LLM event "${eventName}" not subscribable: ${String(error)} (fail-soft)`);
		}
	}

	return {
		unsubscribe: () => {
			for (const h of handlers) h();
		},
	};
}

/**
 * Exported for plugin authors importing a configure entry; intentionally a
 * no-op: the minimal bridge has no runtime dependency on provider APIs.
 * @param _config - unused by design.
 */
export function configureLLm(_config: Readonly<Record<string, never>>): void {
	// Fail-soft: plugin starts, no LLM runtime.
}
