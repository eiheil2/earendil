/**
 * Windsurf provider: ~/.windsurf, ~/.codeium/windsurf, .windsurfrules.
 * Port of omp windsurf.ts subset.
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "windsurf";
const DISPLAY_NAME = "Windsurf";
const PRIORITY = 40;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".windsurf", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".codeium/windsurf", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".windsurf", kind: "config-dir", level: "project", base: "cwd" },
			{ rel: ".windsurfrules", kind: "rules", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit rules from ~/.windsurf and .windsurfrules",
	priority: PRIORITY,
	load,
});
