/**
 * R8 control fixture: the same exhaustive switch, plus a `default` branch.
 *
 * This is the shape the pin must *not* break. Adding an event to the union sends the new member down the
 * `default` branch, the return type stays satisfied without a source edit, and the extension keeps
 * compiling and loading. The distinction between this file and its sibling is the entire point of the R8
 * mechanism: a gate that made both files red would obstruct legitimate additive evolution, and a team that
 * hits that obstruction stops running the gate.
 *
 * The switch body is byte-for-byte the sibling's apart from the `default` branch, which is asserted by the
 * meta-test - otherwise "the control differs only in its default branch" would be a claim rather than a
 * property, and the two files could drift into testing two different things.
 */
import type { ExtensionApi, ExtensionEventName } from "@earendil-works/pi-plugin-sdk";

/**
 * Classify an event by name, defensively.
 *
 * The `default` branch is what makes this version forward compatible. It reports the unmatched name rather
 * than swallowing it, because an event that arrived without a branch is exactly the thing worth seeing.
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
		default:
			// A new event lands here. Say which one instead of doing nothing. The cast is needed because
			// TypeScript narrows `event` to `never` in the default branch of an exhaustive switch, and a
			// `never` has nothing to interpolate.
			return `unclassified: ${event as string}`;
	}
}

/** Registered so this fixture has a non-empty recorded surface and loads as a plugin. */
export default function activate(pi: ExtensionApi): void {
	pi.on("session_start", async (event) => {
		void classify(event.type as ExtensionEventName);
	});
	pi.registerCommand("fixture-exhaustive-switch-with-default", {
		description: "Compatibility fixture: the defensive form of the exhaustive switch.",
		handler: async () => {},
	});
}
