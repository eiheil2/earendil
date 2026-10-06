/**
 * Cursor provider: ~/.cursor, .cursor/, .cursorrules. Port of omp cursor.ts subset.
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "cursor";
const DISPLAY_NAME = "Cursor";
const PRIORITY = 50;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".cursor", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".cursor/mcp.json", kind: "mcp", level: "user", base: "home" },
			{ rel: ".cursor/settings.json", kind: "settings", level: "user", base: "home" },
			{ rel: ".cursor", kind: "config-dir", level: "project", base: "cwd" },
			{ rel: ".cursor/mcp.json", kind: "mcp", level: "project", base: "cwd" },
			{ rel: ".cursor/rules", kind: "rules", level: "project", base: "cwd" },
			{ rel: ".cursorrules", kind: "rules", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit rules and MCP servers from ~/.cursor and .cursor/",
	priority: PRIORITY,
	load,
});
