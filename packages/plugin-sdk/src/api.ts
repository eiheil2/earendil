/**
 * The registration surface of `ExtensionAPI` that the contract governs.
 *
 * The host implements `ExtensionAPI`; an extension consumes it. This module pins two things about
 * that surface: which methods exist (a method the SDK names but the host lacks is a contract lie),
 * and which capability authorizes each of them. Payloads are deliberately not declared here: the tool
 * schema is a typebox schema, `ProviderConfig` and `McpServerConfig` are host types, and copying them
 * would make the SDK a second source of truth for structures the host already owns.
 *
 * What this does *not* cover: the renderer registrations (`registerMessageRenderer`,
 * `registerEntryRenderer`, `registerMarkdownTransformer`), the flag/model/level actions and the
 * getters. They are host surface, always available, and authorized by no capability. The complete
 * host signature set is checked against this file by the host-conformance test rather than being
 * duplicated here.
 */
import type { Static, TSchema } from "typebox";
import type { ExtensionCapability } from "./capabilities.ts";
import type { ExtensionEventHandler, ExtensionEventName } from "./events.ts";

/** Registration methods and the capability each one requires the extension to declare. */
export const EXTENSION_API_CAPABILITIES = {
	on: "event.subscribe",
	registerTool: "tool.register",
	registerCommand: "command.register",
	registerShortcut: "shortcut.register",
	registerFlag: "flag.register",
	registerProvider: "provider.register",
	unregisterProvider: "provider.register",
	registerMcpServer: "mcp.register",
	unregisterMcpServer: "mcp.register",
	registerVirtualModel: "virtualModel.register",
	unregisterVirtualModel: "virtualModel.register",
} as const satisfies Record<string, ExtensionCapability>;

/** The `pi.events` bus is a separate object on the API; publish and subscribe share one capability. */
export const EXTENSION_EVENT_BUS_CAPABILITIES = {
	emit: "eventbus.publish",
	on: "eventbus.publish",
} as const satisfies Record<string, ExtensionCapability>;

export type ExtensionApiContractMethod = keyof typeof EXTENSION_API_CAPABILITIES;
export type ExtensionApiContract = Record<ExtensionApiContractMethod, ExtensionCapability>;

/**
 * The registration surface an extension programs against.
 *
 * The host implements this interface; an extension consumes it. Every declaration below is written so
 * that it stays mutually assignable with the host's own declaration, and
 * `test/host-conformance.test.ts` is what proves it: the host must satisfy this interface, and each
 * method here must be usable wherever the host's method is expected. That is the whole mechanism -
 * there is no code generation and no duplicated host type.
 *
 * What it does not declare, and why:
 * - Renderers (`registerMessageRenderer`, `registerEntryRenderer`, `registerMarkdownTransformer`) and
 *   the getters. They return TUI components, so their signatures belong to `@earendil-works/pi-tui`.
 * - `registerVirtualModel` and `unregister*`. They are host surface with no capability declaration.
 * - Optional `ToolDefinition` fields (exposure, namespace, renderers). The contract covers the fields
 *   an extension must provide; the rest stay host-only and may grow.
 */

/** A typebox-compatible JSON schema, the shape `registerTool` validates arguments against. */
export type ExtensionToolParameters = TSchema;

/** A content block an extension can return from a tool. Mirrors the host's text and image blocks. */
export type ExtensionContentBlock =
	| { type: "text"; text: string; textSignature?: string }
	| { type: "image"; data: string; mimeType: string };

/** JSON-serializable data, for `structuredContent`. Mirrors the host's recursive JSON type. */
export type ExtensionJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly ExtensionJsonValue[]
	| { [key: string]: ExtensionJsonValue };

/** What a tool returns. `details` is required by the host, so it is required here. */
export interface ExtensionToolResult {
	content: ExtensionContentBlock[];
	details: unknown;
	structuredContent?: ExtensionJsonValue;
	isError?: boolean;
	terminate?: boolean;
}

/** The fields `registerTool` requires. Everything else in the host's `ToolDefinition` is optional. */
export interface ExtensionToolDefinition<TParams extends TSchema = TSchema> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	/**
	 * Execute the tool.
	 *
	 * Three parameters, where the host calls with five: a streaming callback and an `ExtensionToolContext`
	 * that this package does not model. An extension that ignores them is unaffected - a function with
	 * fewer parameters is assignable to one with more - and the SDK cannot declare the other two without
	 * declaring two host types. `test/host-conformance.test.ts` checks what is checkable instead: the
	 * definition's data fields and the result type, each in both directions.
	 */
	execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined): Promise<ExtensionToolResult>;
}

/** The fields `registerCommand` requires. */
export interface ExtensionCommandOptions {
	description?: string;
	handler: (args: string) => Promise<void>;
}

/** The fields `registerFlag` accepts: a boolean flag or a string flag, never both. */
export type ExtensionFlagOptions =
	| { description?: string; type: "boolean"; default?: boolean }
	| { description?: string; type: "string"; default?: string };

/** OAuth credentials as the host stores them after a login flow. */
export interface ExtensionOAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

/** The prompt surface a login flow drives. */
export interface ExtensionOAuthLoginCallbacks {
	onAuth(info: { url: string; instructions?: string }): void;
	onDeviceCode(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
	signal?: AbortSignal;
}

/** `/login` support for a provider registered by an extension. */
export interface ExtensionProviderOauth {
	name: string;
	isSubscription?: boolean;
	/** @deprecated Retained for source compatibility; canonical auth flows ignore it. */
	usesCallbackServer?: boolean;
	login(callbacks: ExtensionOAuthLoginCallbacks): Promise<ExtensionOAuthCredentials>;
	refreshToken(credentials: ExtensionOAuthCredentials, signal: AbortSignal): Promise<ExtensionOAuthCredentials>;
	getApiKey(credentials: ExtensionOAuthCredentials): string;
}

/**
 * The plain-data fields of a provider registration.
 *
 * Provider routing (`api`, `streamSimple`, `models`, `refreshModels`) stays host surface: those types
 * belong to the model catalog, and declaring them here would make this package a second source of
 * truth for provider configuration.
 */
export interface ExtensionProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	oauth?: ExtensionProviderOauth;
}

/** How an MCP server's tools are exposed to the model. */
export type ExtensionMcpExposure = "codemode" | "deferred" | "direct" | "hidden";

/** Fields shared by both MCP transports. */
export interface ExtensionMcpServerConfigBase {
	exposure?: ExtensionMcpExposure;
	description?: string;
	toolExposure?: Record<string, ExtensionMcpExposure>;
	enabled?: boolean;
	timeout?: number;
}

/** An MCP server started as a child process. */
export interface ExtensionMcpStdioServerConfig extends ExtensionMcpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

/** OAuth client settings for servers that do not support dynamic client registration. */
export interface ExtensionMcpOauthConfig {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	authServerMetadataUrl?: string;
}

/** An MCP server reached over HTTP. */
export interface ExtensionMcpHttpServerConfig extends ExtensionMcpServerConfigBase {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: ExtensionMcpOauthConfig;
	auth?: { provider: string };
}

export type ExtensionMcpServerConfig = ExtensionMcpStdioServerConfig | ExtensionMcpHttpServerConfig;

/** The shared bus extensions use to talk to each other. */
export interface ExtensionEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ExtensionApi {
	/** Subscribe to an event. Returns an unsubscribe function. */
	on<E extends ExtensionEventName>(event: E, handler: ExtensionEventHandler<E>): () => void;
	/** Register a slash command. */
	registerCommand(name: string, options: ExtensionCommandOptions): void;
	/** Register a CLI flag. */
	registerFlag(name: string, options: ExtensionFlagOptions): void;
	/** Register a tool the model can call. */
	registerTool<TParams extends TSchema>(tool: ExtensionToolDefinition<TParams>): void;
	/** Register an MCP server for this session. Not persisted; register again on every load. */
	registerMcpServer(name: string, config: ExtensionMcpServerConfig): void;
	/** Register a provider, optionally with `/login` support. */
	registerProvider(name: string, config: ExtensionProviderConfig): void;
	/** The shared event bus. */
	events: ExtensionEventBus;
}
