/**
 * VS Code provider: ~/.vscode, .vscode. Port of omp vscode.ts subset.
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "vscode";
const DISPLAY_NAME = "VS Code";
const PRIORITY = 40;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".vscode", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".vscode/settings.json", kind: "settings", level: "user", base: "home" },
			{ rel: ".vscode", kind: "config-dir", level: "project", base: "cwd" },
			{ rel: ".vscode/settings.json", kind: "settings", level: "project", base: "cwd" },
			{ rel: ".vscode/mcp.json", kind: "mcp", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit settings and MCP servers from ~/.vscode and .vscode/",
	priority: PRIORITY,
	load,
});
