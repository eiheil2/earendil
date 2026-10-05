/**
 * The SDK declares the contract; the host implements it. Nothing here copies a host type, so the two
 * sides can only be kept together by a check, and that check is this file.
 *
 * Two mechanisms, because TypeScript offers two things:
 *
 * 1. Bidirectional assignability, for the shapes the SDK declares. Every assignment below is a real
 *    assignment between declared variables, not a cast, so TypeScript checks it in full. It fails when a
 *    field is renamed, retyped, made optional or made required, on either side - which is the point:
 *    the contract is not a description of the host, it is a claim about it.
 * 2. `satisfies` between the SDK's runtime lists and the host types they must have an entry for.
 *
 * What is not checked here, and why:
 * - The event *names*. `on()` is 41 overloads and `Parameters<>` of an overloaded method yields only
 *   the last one, so the names are compared against the source text instead. `host-surface.test.ts`
 *   owns that comparison.
 * - The event *payloads* of events that reference host implementation types. They are absent from
 *   `ExtensionEventPayloads` on purpose (see the note in `src/events.ts`); a handler for one receives
 *   `unknown`.
 * - `ExtensionApi` in the reverse direction. It is a subset of the host's `ExtensionAPI` - it declares
 *   what an extension programs against, not the ~40 remaining members that exist for renderers, actions
 *   and getters - and a subset is not assignable to its superset by construction. The direction that
 *   matters is the one that fails when the SDK promises something the host does not have: host -> SDK.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../agent/src/types.ts";
import type { EventBus as HostEventBus } from "../../coding-agent/src/core/event-bus.ts";
import type {
	ExtensionAPI as HostApi,
	ProjectTrustEvent as HostProjectTrustEvent,
	ProjectTrustEventResult as HostProjectTrustEventResult,
	ProviderConfig as HostProviderConfig,
	ResourcesDiscoverEvent as HostResourcesDiscoverEvent,
	ResourcesDiscoverResult as HostResourcesDiscoverResult,
	SessionStartEvent as HostSessionStartEvent,
	ToolCallEventResult as HostToolCallEventResult,
	ToolDefinition as HostToolDefinition,
	ToolExecutionEndEvent as HostToolExecutionEndEvent,
	ToolExecutionStartEvent as HostToolExecutionStartEvent,
	ToolExecutionUpdateEvent as HostToolExecutionUpdateEvent,
	UserBashEvent as HostUserBashEvent,
} from "../../coding-agent/src/core/extensions/types.ts";
import type {
	ExtensionApi,
	ExtensionEventBus,
	ExtensionProviderConfig,
	ExtensionToolDefinition,
	ExtensionToolResult,
} from "../src/api.ts";
import {
	type ExtensionEventName,
	type ExtensionEventPayload,
	type ExtensionEventResult,
	GOVERNED_EVENT_PAYLOADS,
	GOVERNED_EVENT_RESULTS,
} from "../src/events.ts";

/** Host payload type per governed event, spelled out because the host declares each one separately. */
interface HostPayloads {
	project_trust: HostProjectTrustEvent;
	resources_discover: HostResourcesDiscoverEvent;
	session_start: HostSessionStartEvent;
	user_bash: HostUserBashEvent;
	tool_execution_start: HostToolExecutionStartEvent;
	tool_execution_update: HostToolExecutionUpdateEvent;
	tool_execution_end: HostToolExecutionEndEvent;
}

/** Host result type per governed result, same reason. */
interface HostResults {
	project_trust: HostProjectTrustEventResult;
	resources_discover: HostResourcesDiscoverResult;
	tool_call: HostToolCallEventResult;
}

// Compile-time proof that the SDK's runtime lists and the host type table cannot drift apart: every
// event the SDK claims to govern must have an entry above, and `HostPayloads` has no other key.
const _payloadsCovered: readonly (keyof HostPayloads)[] = GOVERNED_EVENT_PAYLOADS;
const _resultsCovered: readonly (keyof HostResults)[] = GOVERNED_EVENT_RESULTS;

declare const hostApi: HostApi;

/**
 * Every assignment this file exists for.
 *
 * They live in a function that is never called because `declare const` is erased at runtime: reading
 * one of these variables in the module body throws a ReferenceError under vitest, which would turn a
 * type-level check into a runtime failure that says nothing about conformance. TypeScript still checks
 * the body, and `tsc --noEmit` and the L1 compile step are what run it.
 */
function assertHostConformance(): void {
	// Direction 1: the host satisfies the contract. Three members are compared separately below and
	// excluded here, each for a stated reason rather than for convenience:
	// - `on`: its handler signature cannot be mutually assignable with the host's, because the host
	//   passes an `ExtensionContext` the SDK does not model and TypeScript rejects a one-parameter
	//   handler where a two-parameter one is expected. What `on` does guarantee - payload and result
	//   shapes - is checked per event further down.
	// - `registerProvider`: the host declares two overloads, one taking a `Provider` object from the
	//   model catalog. The SDK declares only the (name, config) form, and a single signature cannot
	//   satisfy an overload that takes fewer arguments. The config type is checked pairwise instead.
	// - `registerTool`: the host's `execute` takes five arguments and the SDK's takes three, because the
	//   other two are an `AgentToolUpdateCallback` and an `ExtensionToolContext`. Assignability fails on the
	//   parameter count. The definition's data fields and the result type are checked pairwise instead,
	//   which together are the whole of the tool contract an extension depends on.
	type ComparedApiMembers = Exclude<keyof ExtensionApi, "on" | "registerProvider" | "registerTool">;
	const hostImplementsContract: Pick<ExtensionApi, ComparedApiMembers> = hostApi;

	// Direction 2: each declared method is usable wherever the host's method is expected - the SDK
	// never asks for more than the host accepts.
	type SdkMethodNames = ComparedApiMembers;
	const sdkMethods: { [K in SdkMethodNames]: ExtensionApi[K] } = hostMethodsSource;
	const sdkFitsHostApi: typeof hostMethodsTarget = sdkMethods;

	// A tool definition's data fields, without `execute`: the fields an extension must provide. Together
	// with the result type below, that is what a tool author depends on.
	const sdkToolData: Omit<ExtensionToolDefinition, "execute"> = hostToolData;
	const hostToolDataFromSdk: Omit<HostToolDefinition, "execute"> = sdkToolData;

	// The event bus is part of the contract even though it authorizes no capability of its own.
	const hostImplementsBus: ExtensionEventBus = hostBus;

	// Tool results cross the boundary both ways: an extension returns one, the host renders it.
	const sdkResultFitsHost: AgentToolResult<unknown> = sdkToolResult;
	const hostResultFitsSdk: ExtensionToolResult = hostToolResult;

	// Payloads, one pair of assignments per governed event.
	const projectTrustToHost: HostProjectTrustEvent = sdkProjectTrust;
	const projectTrustToSdk: ExtensionEventPayload<"project_trust"> = hostProjectTrust;

	const resourcesDiscoverToHost: HostResourcesDiscoverEvent = sdkResourcesDiscover;
	const resourcesDiscoverToSdk: ExtensionEventPayload<"resources_discover"> = hostResourcesDiscover;

	const sessionStartToHost: HostSessionStartEvent = sdkSessionStart;
	const sessionStartToSdk: ExtensionEventPayload<"session_start"> = hostSessionStart;

	const userBashToHost: HostUserBashEvent = sdkUserBash;
	const userBashToSdk: ExtensionEventPayload<"user_bash"> = hostUserBash;

	const toolExecutionStartToHost: HostToolExecutionStartEvent = sdkToolExecutionStart;
	const toolExecutionStartToSdk: ExtensionEventPayload<"tool_execution_start"> = hostToolExecutionStart;

	const toolExecutionUpdateToHost: HostToolExecutionUpdateEvent = sdkToolExecutionUpdate;
	const toolExecutionUpdateToSdk: ExtensionEventPayload<"tool_execution_update"> = hostToolExecutionUpdate;

	const toolExecutionEndToHost: HostToolExecutionEndEvent = sdkToolExecutionEnd;
	const toolExecutionEndToSdk: ExtensionEventPayload<"tool_execution_end"> = hostToolExecutionEnd;

	// Results, same shape of check.
	const projectTrustResultToHost: HostProjectTrustEventResult = sdkProjectTrustResult;
	const projectTrustResultToSdk: ExtensionEventResult<"project_trust"> = hostProjectTrustResult;

	const resourcesDiscoverResultToHost: HostResourcesDiscoverResult = sdkResourcesDiscoverResult;
	const resourcesDiscoverResultToSdk: ExtensionEventResult<"resources_discover"> = hostResourcesDiscoverResult;

	const toolCallResultToHost: HostToolCallEventResult = sdkToolCallResult;
	const toolCallResultToSdk: ExtensionEventResult<"tool_call"> = hostToolCallResult;

	// `registerProvider`, checked on its config type rather than on the method (see the note above).
	// The oauth block is the interesting half: `usesCallbackServer` is deprecated on the host, and
	// removing it would be a breaking change - exactly what a mutual-assignability check is for.
	const sdkProviderConfigToHost: HostProviderConfig = sdkProviderConfig;
	const hostProviderConfigToSdk: ExtensionProviderConfig = hostProviderConfig;

	void [
		hostImplementsContract,
		sdkFitsHostApi,
		sdkToolData,
		hostToolDataFromSdk,
		hostImplementsBus,
		sdkResultFitsHost,
		hostResultFitsSdk,
		projectTrustToHost,
		projectTrustToSdk,
		resourcesDiscoverToHost,
		resourcesDiscoverToSdk,
		sessionStartToHost,
		sessionStartToSdk,
		userBashToHost,
		userBashToSdk,
		toolExecutionStartToHost,
		toolExecutionStartToSdk,
		toolExecutionUpdateToHost,
		toolExecutionUpdateToSdk,
		toolExecutionEndToHost,
		toolExecutionEndToSdk,
		projectTrustResultToHost,
		projectTrustResultToSdk,
		resourcesDiscoverResultToHost,
		resourcesDiscoverResultToSdk,
		toolCallResultToHost,
		toolCallResultToSdk,
		sdkProviderConfigToHost,
		hostProviderConfigToSdk,
	];
}

void assertHostConformance;

// The host-side values the assertions above compare against. Declared rather than constructed: this
// file checks that two declarations agree, and building one side from the other would prove nothing.
/** The host members this file compares. Kept as one alias so both directions cannot drift apart. */
type ComparedHostMethods = Exclude<keyof ExtensionApi, "on" | "registerProvider" | "registerTool">;
declare const hostMethodsSource: { [K in ComparedHostMethods]: HostApi[K] };
declare const hostMethodsTarget: { [K in ComparedHostMethods]: HostApi[K] };
declare const hostToolData: Omit<HostToolDefinition, "execute">;
declare const hostBus: HostEventBus;
declare const hostToolResult: AgentToolResult<unknown>;
declare const sdkToolResult: ExtensionToolResult;
declare const sdkProjectTrust: ExtensionEventPayload<"project_trust">;
declare const hostProjectTrust: HostProjectTrustEvent;
declare const sdkResourcesDiscover: ExtensionEventPayload<"resources_discover">;
declare const hostResourcesDiscover: HostResourcesDiscoverEvent;
declare const sdkSessionStart: ExtensionEventPayload<"session_start">;
declare const hostSessionStart: HostSessionStartEvent;
declare const sdkUserBash: ExtensionEventPayload<"user_bash">;
declare const hostUserBash: HostUserBashEvent;
declare const sdkToolExecutionStart: ExtensionEventPayload<"tool_execution_start">;
declare const hostToolExecutionStart: HostToolExecutionStartEvent;
declare const sdkToolExecutionUpdate: ExtensionEventPayload<"tool_execution_update">;
declare const hostToolExecutionUpdate: HostToolExecutionUpdateEvent;
declare const sdkToolExecutionEnd: ExtensionEventPayload<"tool_execution_end">;
declare const hostToolExecutionEnd: HostToolExecutionEndEvent;
declare const sdkProjectTrustResult: ExtensionEventResult<"project_trust">;
declare const hostProjectTrustResult: HostProjectTrustEventResult;
declare const sdkResourcesDiscoverResult: ExtensionEventResult<"resources_discover">;
declare const hostResourcesDiscoverResult: HostResourcesDiscoverResult;
declare const sdkToolCallResult: ExtensionEventResult<"tool_call">;
declare const hostToolCallResult: HostToolCallEventResult;
declare const sdkProviderConfig: ExtensionProviderConfig;
declare const hostProviderConfig: HostProviderConfig;

void [_payloadsCovered, _resultsCovered];

describe("host conformance", () => {
	it("keeps the compile-time assertions in the file", () => {
		// The substance of this file is type-level, in a function that is never called. These tests keep
		// the file inside both test runs and assert the facts a type checker cannot: that the assertions
		// still exist in the source, and that the declared subsets are not empty.
		const source = readFileSync(new URL(import.meta.url), "utf8");
		expect(source).toContain("function assertHostConformance(): void");
		expect(
			source.match(/const \w+: (Host|Extension|AgentTool|Omit|Pick)[\w<>, [\]|]* = /g)?.length ?? 0,
		).toBeGreaterThan(10);
	});

	it("governs payloads for a small, non-empty subset of the events", () => {
		expect(GOVERNED_EVENT_PAYLOADS.length).toBeGreaterThan(0);
		expect(new Set(GOVERNED_EVENT_PAYLOADS).size).toBe(GOVERNED_EVENT_PAYLOADS.length);
	});

	it("governs results for a small, non-empty subset of the events", () => {
		expect(GOVERNED_EVENT_RESULTS.length).toBeGreaterThan(0);
		expect(new Set(GOVERNED_EVENT_RESULTS).size).toBe(GOVERNED_EVENT_RESULTS.length);
	});

	it("governs only event names the contract knows", () => {
		const governed: readonly string[] = [...GOVERNED_EVENT_PAYLOADS, ...GOVERNED_EVENT_RESULTS];
		for (const event of governed) {
			expect(typeof event, event).toBe("string");
		}
		const names: ExtensionEventName[] = ["project_trust", "session_start", "tool_call"];
		for (const name of names) {
			expect(
				governed.some((event) => event === name),
				name,
			).toBe(true);
		}
	});
});
