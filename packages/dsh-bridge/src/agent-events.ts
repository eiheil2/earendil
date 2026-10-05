/**
 * Agent-events mapping: forwards cordis-style agent lifecycle events to pi's
 * ExtensionAPI event bus.
 *
 * Mapped cordis → pi event names (subset of EXTENSION_EVENT_NAMES):
 *   'agent/start'        -> 'agent_start'
 *   'agent/end'          -> 'agent_end'
 *   'tool/call'          -> 'tool_call'
 *   'tool/result'        -> 'tool_result'
 *   'compaction/complete'-> 'session_compact'
 *
 * Known limitation (honest scope): the minimal bridge registers subscribers on
 * the host bus but does not yet translate host payloads into cordis payload
 * shapes; handlers receive host payloads unchanged. Event delivery degrades to
 * silence when the host lacks the event (fail-soft).
 *
 * Constraint: chord facet path is CLOSED; subscriptions go only through the
 * ExtensionAPI narrow path (plan-plugin-contract §5, MERGE-FINAL §3 R4).
 */

import type { ExtensionApi } from "./cordis-context.ts";

/** Cordis → pi event name mapping; `undefined` marks unmapped cordis names. */
export const CORDIS_TO_PI_EVENT_MAP: Readonly<Record<string, string | undefined>> = {
	"agent/start": "agent_start",
	"agent/end": "agent_end",
	"tool/call": "tool_call",
	"tool/result": "tool_result",
	"compaction/complete": "session_compact",
} as const;

export type CordisToPiEventMap = typeof CORDIS_TO_PI_EVENT_MAP;

/**
 * Subscribe the mapped cordis event names on the pi ExtensionAPI.
 * @param ext - host ExtensionAPI; missing `on` degrades to silence (fail-soft).
 * @returns an unsubscribe function aggregating all registered subscriptions.
 */
export function mapCordisAgentEvents(ext: ExtensionApi): { unsubscribe: () => void } {
	const subs: Array<() => void> = [];

	for (const [cordisName, piName] of Object.entries(CORDIS_TO_PI_EVENT_MAP)) {
		if (piName === undefined) continue;
		if (typeof ext.on !== "function") {
			console.warn(`dsh-bridge: cordis event "${cordisName}" dropped; host has no event bus (fail-soft)`);
			break;
		}
		try {
			subs.push(ext.on(piName, () => {}));
		} catch (error) {
			// Host refused this event name; skip it, keep the rest alive.
			console.warn(`dsh-bridge: cordis event "${cordisName}" not subscribable: ${String(error)} (fail-soft)`);
		}
	}

	return {
		unsubscribe: () => {
			for (const s of subs) s();
		},
	};
}
