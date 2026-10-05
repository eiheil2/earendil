/**
 * R8 fixture: an extension that switches over every event name it knows, with no `default` branch.
 *
 * This is the shape the pin exists for. It compiles today because the switch covers the union exactly.
 * The moment a new event is added to the union, the function falls off the end of the switch and
 * TypeScript reports a missing return - which is the *good* outcome: the extension author finds out that
 * they silently stopped handling an event, at their editor, before the extension ships.
 *
 * The comparison is `packages/plugin-sdk/test/r8-exhaustive-switch/r8-exhaustive-switch.test.ts`, which
 * compiles this file against a union with one extra member and requires a failure. Its sibling in this
 * directory is the control case.
 *
 * What this fixture does not do: hide the runtime hazard. An unmatched event falls through to "do
 * nothing", and a compile error only appears for this one coding style. An extension that switches with a
 * `default` is safe by construction, which is what the sibling is for - and a gate that turned both files
 * red would obstruct legitimate additive evolution until somebody disabled it.
 */
import type { ExtensionApi, ExtensionEventName } from "@earendil-works/pi-plugin-sdk";

/**
 * Classify an event by name.
 *
 * No `default` branch, and the return type does not include `undefined`: that pair is what turns
 * exhaustiveness into a compile error rather than a convention.
 */
export function classify(event: ExtensionEventName): string {
	switch (event) {
		case "project_trust":
			return "startup: project trust";
		case "resources_discover":
			return "startup: resource discovery";
		case "session_start":
			return "session lifecycle";
		case "session_info_changed":
			return "session lifecycle";
		case "session_before_switch":
			return "session lifecycle";
		case "session_before_fork":
			return "session lifecycle";
		case "session_before_compact":
			return "session lifecycle";
		case "session_compact":
			return "session lifecycle";
		case "session_compact_failed":
			return "session lifecycle";
		case "session_shutdown":
			return "session lifecycle";
		case "mcp_servers_change":
			return "runtime: mcp servers";
		case "session_before_tree":
			return "session lifecycle";
		case "session_tree":
			return "session lifecycle";
		case "context":
			return "prompt assembly";
		case "context_with_system":
			return "prompt assembly";
		case "cache_warming_decision":
			return "runtime: cache";
		case "before_provider_request":
			return "provider";
		case "before_provider_headers":
			return "provider";
		case "after_provider_response":
			return "provider";
		case "provider_stream_event":
			return "provider";
		case "before_agent_start":
			return "agent";
		case "agent_start":
			return "agent";
		case "agent_end":
			return "agent";
		case "agent_before_settle":
			return "agent";
		case "agent_settled":
			return "agent";
		case "ui_prompt_start":
			return "ui";
		case "ui_prompt_end":
			return "ui";
		case "turn_start":
			return "turn";
		case "turn_end":
			return "turn";
		case "message_start":
			return "streaming";
		case "message_update":
			return "streaming";
		case "message_end":
			return "streaming";
		case "tool_execution_start":
			return "tool execution";
		case "tool_execution_update":
			return "tool execution";
		case "tool_execution_end":
			return "tool execution";
		case "model_select":
			return "model";
		case "thinking_level_select":
			return "model";
		case "tool_call":
			return "tool call";
		case "tool_result":
			return "tool call";
		case "user_bash":
			return "user input";
		case "input":
			return "user input";
	}
}

/** Registered so this fixture has a non-empty recorded surface and loads as a plugin. */
export default function activate(pi: ExtensionApi): void {
	pi.on("session_start", async (event) => {
		void classify(event.type as ExtensionEventName);
	});
	pi.registerCommand("fixture-exhaustive-switch", {
		description: "Compatibility fixture: an exhaustive switch over the event union.",
		handler: async () => {},
	});
}
