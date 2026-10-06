/**
 * OpenCode provider: ~/.opencode, ~/.config/opencode, .opencode, opencode.json.
 * Port of omp opencode.ts subset.
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "opencode";
const DISPLAY_NAME = "OpenCode";
const PRIORITY = 55;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".opencode", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".config/opencode", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".config/opencode/opencode.json", kind: "settings", level: "user", base: "home" },
			{ rel: ".opencode", kind: "config-dir", level: "project", base: "cwd" },
			{ rel: "opencode.json", kind: "settings", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit settings from ~/.opencode, ~/.config/opencode, and opencode.json",
	priority: PRIORITY,
	load,
});
