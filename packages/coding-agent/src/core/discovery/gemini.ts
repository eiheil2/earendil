/**
 * Gemini CLI provider: ~/.gemini, .gemini, GEMINI.md. Port of omp gemini.ts subset.
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "gemini";
const DISPLAY_NAME = "Gemini CLI";
const PRIORITY = 60;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".gemini", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".gemini/settings.json", kind: "settings", level: "user", base: "home" },
			{ rel: ".gemini/GEMINI.md", kind: "context-file", level: "user", base: "home" },
			{ rel: ".gemini/extensions", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".gemini", kind: "config-dir", level: "project", base: "cwd" },
			{ rel: ".gemini/settings.json", kind: "settings", level: "project", base: "cwd" },
			{ rel: "GEMINI.md", kind: "context-file", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit settings and context from ~/.gemini and .gemini/",
	priority: PRIORITY,
	load,
});
