/**
 * The event names an extension can subscribe to with `pi.on(...)`.
 *
 * This list is part of the contract: an event is added here and in
 * `ExtensionAPI.on(...)` together, and neither side is allowed to change alone. What is *not* in the
 * contract yet is the payload shape of each event: the payloads reference host implementation types
 * (`AgentMessage`, `ReadonlySessionManager`, `Model`, ...), and copying ~1,200 lines of them into the
 * SDK would move the coupling instead of removing it. Until the host-conformance test pins the
 * payloads, a handler receives the host's own event and context types, and the guarantee this SDK
 * gives is "the event name exists and is never removed or renamed without a version bump".
 *
 * Additive evolution: new events do not bump `PLUGIN_API_VERSION`. An extension that exhaustively
 * switches over the union without a `default` branch silently stops handling the new event, which is
 * why the compatibility matrix pins that pattern with a pair of fixtures.
 */

/** Every event name accepted by `pi.on(...)`, in the order the host declares its overloads. */
export const EXTENSION_EVENT_NAMES = [
	"project_trust",
	"resources_discover",
	"session_start",
	"session_info_changed",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"session_shutdown",
	"mcp_servers_change",
	"session_before_tree",
	"session_tree",
	"context",
	"context_with_system",
	"cache_warming_decision",
	"before_provider_request",
	"before_provider_headers",
	"after_provider_response",
	"provider_stream_event",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"agent_before_settle",
	"agent_settled",
	"ui_prompt_start",
	"ui_prompt_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"model_select",
	"thinking_level_select",
	"tool_call",
	"tool_result",
	"user_bash",
	"input",
] as const;

export type ExtensionEventName = (typeof EXTENSION_EVENT_NAMES)[number];

export function isExtensionEventName(value: string): value is ExtensionEventName {
	return (EXTENSION_EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * Payload shapes for the events that carry no host implementation type.
 *
 * An event qualifies when every field of its payload is a primitive, a literal union, or a container
 * of those. Those payloads can be declared here exactly, which is what makes the bidirectional
 * assignability check in `test/host-conformance.test.ts` meaningful: it fails when a field is renamed,
 * retyped, made optional or made required on either side.
 *
 * The remaining events are not governed yet, deliberately and not for lack of trying. Their payloads
 * reference `AgentMessage`, `Model`, `SessionManager`, `ImageContent` and similar, and copying those
 * would put ~1,200 lines of host types into this package - the coupling the contract exists to remove.
 * For those events the guarantee is still "the name exists and is never removed or renamed", and a
 * handler receives `unknown`. Extending the map is the migration: add one entry, run the conformance
 * test, and the host either agrees or explains.
 */
export interface ExtensionEventPayloads {
	project_trust: { type: "project_trust"; cwd: string };
	resources_discover: { type: "resources_discover"; cwd: string; reason: "startup" | "reload" };
	session_start: {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	};
	user_bash: { type: "user_bash"; command: string; excludeFromContext: boolean; cwd: string };
	tool_execution_start: {
		type: "tool_execution_start";
		toolCallId: string;
		toolName: string;
		/** Unvalidated tool arguments. Typed as `unknown` here; the host declares `any`. */
		args: unknown;
		parentToolCallId?: string;
	};
	tool_execution_update: {
		type: "tool_execution_update";
		toolCallId: string;
		toolName: string;
		args: unknown;
		partialResult: unknown;
		parentToolCallId?: string;
	};
	tool_execution_end: {
		type: "tool_execution_end";
		toolCallId: string;
		toolName: string;
		result: unknown;
		isError: boolean;
		parentToolCallId?: string;
	};
}

/**
 * Result shapes a handler may return, for the events whose result is also plain data.
 *
 * `tool_call` is here although its payload is not: the payload is a union of per-tool shapes, while
 * the result (block / reason / terminate) is three optional primitives and is exactly the part an
 * extension branch acts on.
 */
export interface ExtensionEventResults {
	project_trust: { trusted: "yes" | "no" | "undecided"; remember?: boolean };
	resources_discover: { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] };
	tool_call: { block?: boolean; reason?: string; terminate?: boolean };
}

/** The events whose payload this SDK declares. Runtime form, for tests and for documentation. */
export const GOVERNED_EVENT_PAYLOADS = [
	"project_trust",
	"resources_discover",
	"session_start",
	"user_bash",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
] as const satisfies readonly (keyof ExtensionEventPayloads)[];

/** The events whose handler result this SDK declares. */
export const GOVERNED_EVENT_RESULTS = [
	"project_trust",
	"resources_discover",
	"tool_call",
] as const satisfies readonly (keyof ExtensionEventResults)[];

/** The payload an event handler receives: the declared shape, or `unknown` for an ungoverned event. */
export type ExtensionEventPayload<E extends ExtensionEventName> = E extends keyof ExtensionEventPayloads
	? ExtensionEventPayloads[E]
	: unknown;

/** What an event handler may return: the declared shape, or `unknown` for an ungoverned event. */
export type ExtensionEventResult<E extends ExtensionEventName> = E extends keyof ExtensionEventResults
	? ExtensionEventResults[E]
	: unknown;

/**
 * A handler for `pi.on(...)`.
 *
 * The host also passes an `ExtensionContext` as the second argument. It is not declared here: the
 * context exposes the session, the runtime and the UI, all of them host objects, and no hand-written
 * shape would stay assignable to it in both directions. The return type mirrors the host's
 * (`Promise<Result | void> | Result | void`) so the two handler types agree on results; the payload and
 * result shapes are checked for mutual assignability in `test/host-conformance.test.ts`, which is the
 * substantive guarantee. `host-surface.test.ts` pins the event names.
 */
export type ExtensionEventHandler<E extends ExtensionEventName> = (
	event: ExtensionEventPayload<E>,
	// biome-ignore lint/suspicious/noConfusingVoidType: bare `return` in a handler needs void, as in the host's own handler type
) => Promise<ExtensionEventResult<E> | void> | ExtensionEventResult<E> | void;
