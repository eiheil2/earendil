/**
 * Compatibility fixture: subscribes to events and nothing else.
 *
 * The point is the smallest useful plugin. It registers no tool, no command and no server, so every
 * entry in its recorded surface comes from `on()` - which makes it the fixture that notices if the event
 * subscription surface changes shape.
 *
 * Four of the seven events whose payloads the SDK declares are used, including two that return a result
 * (`tool_call` and `project_trust`). The remaining payload types reference host implementation types and
 * are not declared by the SDK yet, so a handler for one of those would receive `unknown`; the fixtures do
 * not pretend otherwise by using only the easy half.
 */
import type { ExtensionApi, ExtensionEventPayload, ExtensionEventResult } from "@earendil-works/pi-plugin-sdk";

export default function activate(pi: ExtensionApi): void {
	pi.on("session_start", async (event) => {
		describe("session_start", event);
	});

	pi.on("tool_call", async (event) => {
		// Block nothing; return an explicit empty result so the declared result shape is exercised.
		const result: ExtensionEventResult<"tool_call"> = {};
		void result;
		void describe("tool_call", event);
	});

	pi.on("tool_execution_end", async (event) => {
		describe("tool_execution_end", event);
	});

	pi.on("project_trust", async (event) => {
		describe("project_trust", event);
		// Decline: this fixture has no opinion about the project and must not register it as trusted.
		return { trusted: "no" } satisfies ExtensionEventResult<"project_trust">;
	});
}

/**
 * Record that a payload arrived.
 *
 * The parameter is typed and unused on purpose: that is the check. A fixture whose handler takes an
 * untyped parameter would still load - jiti strips types without checking them - so this is the only place
 * the compile layer proves the SDK's declared payload shape actually describes the host's event.
 */
function describe<E extends "session_start" | "tool_call" | "tool_execution_end" | "project_trust">(
	_event: E,
	payload: ExtensionEventPayload<E>,
): void {
	void payload;
}
