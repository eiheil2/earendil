/**
 * GitHub Copilot provider: ~/.copilot, .github/copilot-instructions.md.
 * Port of omp github.ts subset.
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "github";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 45;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".copilot", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".copilot/copilot-instructions.md", kind: "context-file", level: "user", base: "home" },
			{ rel: ".copilot/mcp.json", kind: "mcp", level: "user", base: "home" },
			{ rel: ".github/copilot-instructions.md", kind: "context-file", level: "project", base: "cwd" },
			{ rel: ".github/instructions", kind: "prompts", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit Copilot instructions and MCP config from ~/.copilot and .github/",
	priority: PRIORITY,
	load,
});
