/**
 * OpenAI Codex provider: ~/.codex, .codex, AGENTS.md. Port of omp codex.ts subset.
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "codex";
const DISPLAY_NAME = "OpenAI Codex";
const PRIORITY = 60;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".codex", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".codex/AGENTS.md", kind: "context-file", level: "user", base: "home" },
			{ rel: ".codex/config.toml", kind: "settings", level: "user", base: "home" },
			{ rel: ".codex/skills", kind: "skills", level: "user", base: "home" },
			{ rel: ".codex/prompts", kind: "prompts", level: "user", base: "home" },
			{ rel: ".codex", kind: "config-dir", level: "project", base: "cwd" },
			{ rel: "AGENTS.md", kind: "context-file", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit context files and prompts from ~/.codex and .codex/",
	priority: PRIORITY,
	load,
});
