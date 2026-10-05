/**
 * DSH `mcp-client` as a built-in pi extension.
 *
 * Declares MCP servers in the shape of DSH's `StdioConfig` and registers each one with
 * `pi.registerMcpServer()`, so the built-in `mcp` extension connects it and publishes its tools as
 * `mcp__<server>__<tool>`. DSH options pi's registration surface has no field for stay private to
 * this extension; nothing but `registerMcpServer` reaches the ExtensionAPI.
 *
 * Startup keeps DSH's rules. Every entry is validated before the first one registers, so a
 * misconfigured entry fails the extension before any registration is applied. A rejected
 * registration fails the whole extension when the entry sets `failOnStartupError`; otherwise that
 * server is left out and reported on `session_start`. The loader discards a factory that throws as
 * one failed extension, so a bad entry never blocks the host.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { McpExposure, McpStdioServerConfig } from "../../core/mcp-servers.ts";

/** One MCP server declared in the shape of DSH `mcp-client`'s `StdioConfig`. */
export interface DshMcpServerConfig {
	/** DSH `serverName`: namespace of the server's tools, `mcp__<serverName>__<tool>`. */
	serverName: string;
	/** Executable spawned for the server, as DSH's `command`. */
	command: string;
	args?: string[];
	/** Extra environment variables for the child process. */
	env?: Record<string, string>;
	cwd?: string;
	/** DSH `toolCallTimeoutMs`. pi's `timeout` counts whole seconds, rounded up. Default: 60. */
	toolCallTimeoutMs?: number;
	/**
	 * DSH `failOnStartupError`: a rejected registration fails this extension instead of skipping
	 * the server and reporting it on `session_start`. Default: the extension's option.
	 */
	failOnStartupError?: boolean;
	/** How the server's tools are reachable. pi's default is `codemode`. */
	exposure?: McpExposure;
	/** One sentence about the server, listed with it in the `mcp_servers` prompt section. */
	description?: string;
	/** Register the entry without connecting. Default: true. */
	enabled?: boolean;
}

export interface McpDshExtensionOptions {
	/** Servers to register, each in DSH `StdioConfig` shape. Default: none. */
	servers?: readonly DshMcpServerConfig[];
	/** `failOnStartupError` of the servers that do not set one. Default: false, DSH's default. */
	failOnStartupError?: boolean;
}

/** DSH keeps `serverName` short enough to stay below the public tool-name budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** One entry after validation, in pi's registration shape. */
interface ResolvedServer {
	name: string;
	config: McpStdioServerConfig;
	failOnStartupError: boolean;
}

/**
 * Validate one entry and turn it into pi's stdio server config. Misconfiguration throws at load,
 * before anything registers, the way DSH's config schema rejects the whole plugin instance.
 *
 * @param entry - Server in DSH `StdioConfig` shape.
 * @param defaultFailOnStartupError - Value used when the entry has no `failOnStartupError`.
 * @returns The resolved registration.
 */
function resolveServer(entry: DshMcpServerConfig, defaultFailOnStartupError: boolean): ResolvedServer {
	const { serverName, command, toolCallTimeoutMs } = entry;
	if (!SERVER_NAME_PATTERN.test(serverName)) {
		throw new Error(`mcp-dsh: serverName ${JSON.stringify(serverName)} must match [A-Za-z0-9_-]{1,32}`);
	}
	if (typeof command !== "string" || command === "") {
		throw new Error(`mcp-dsh: server "${serverName}" needs a command to spawn`);
	}
	if (toolCallTimeoutMs !== undefined && (!Number.isFinite(toolCallTimeoutMs) || toolCallTimeoutMs <= 0)) {
		throw new Error(`mcp-dsh: server "${serverName}" toolCallTimeoutMs must be a positive number of milliseconds`);
	}
	const config: McpStdioServerConfig = { type: "stdio", command };
	if (entry.args !== undefined) config.args = entry.args;
	if (entry.env !== undefined) config.env = entry.env;
	if (entry.cwd !== undefined) config.cwd = entry.cwd;
	if (toolCallTimeoutMs !== undefined) config.timeout = Math.max(1, Math.ceil(toolCallTimeoutMs / 1000));
	if (entry.exposure !== undefined) config.exposure = entry.exposure;
	if (entry.description !== undefined) config.description = entry.description;
	if (entry.enabled !== undefined) config.enabled = entry.enabled;
	return { name: serverName, config, failOnStartupError: entry.failOnStartupError ?? defaultFailOnStartupError };
}

/**
 * Create the extension that registers DSH-shaped MCP servers with pi.
 *
 * @param options - Servers to declare and their shared defaults.
 * @returns The extension factory. Validation runs when the factory is created, so a bad entry
 *   fails the extension at load with no registration applied.
 */
export function createMcpDshExtension(options: McpDshExtensionOptions = {}): ExtensionFactory {
	const failOnStartupError = options.failOnStartupError ?? false;
	const servers = (options.servers ?? []).map((entry) => resolveServer(entry, failOnStartupError));
	// One extension owns both registrations, so a duplicate would silently replace the first server.
	// Like DSH's `serverName` reservation it fails the instance before the first registration.
	const names = new Set<string>();
	for (const { name } of servers) {
		if (names.has(name)) throw new Error(`mcp-dsh: serverName "${name}" is declared twice`);
		names.add(name);
	}

	return (pi) => {
		const skipped: string[] = [];
		for (const server of servers) {
			try {
				pi.registerMcpServer(server.name, server.config);
			} catch (error) {
				if (server.failOnStartupError) throw error;
				skipped.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (skipped.length > 0) {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(
					`MCP servers declared by the mcp-dsh extension were not registered:\n${skipped
						.map((line) => `  ${line}`)
						.join("\n")}`,
					"error",
				);
			});
		}
	};
}

export default createMcpDshExtension();
