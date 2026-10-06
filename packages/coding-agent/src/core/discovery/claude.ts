/**
 * Claude Code provider: scans ~/.claude*, ~/.claude.json, .claude/, CLAUDE.md.
 * Port of omp `src/discovery/claude.ts` (read-only scan subset).
 */
import { probeCandidates } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "claude";
const DISPLAY_NAME = "Claude Code";
const PRIORITY = 80;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	return {
		items: probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
			{ rel: ".claude", kind: "config-dir", level: "user", base: "home" },
			{ rel: ".claude.json", kind: "settings", level: "user", base: "home" },
			{ rel: ".claude/settings.json", kind: "settings", level: "user", base: "home" },
			{ rel: ".claude/CLAUDE.md", kind: "context-file", level: "user", base: "home" },
			{ rel: ".claude/skills", kind: "skills", level: "user", base: "home" },
			{ rel: ".claude/commands", kind: "prompts", level: "user", base: "home" },
			{ rel: ".claude", kind: "config-dir", level: "project", base: "cwd" },
			{ rel: ".claude/settings.json", kind: "settings", level: "project", base: "cwd" },
			{ rel: "CLAUDE.md", kind: "context-file", level: "project", base: "cwd" },
		]),
	};
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit settings, rules, and prompts from ~/.claude and .claude/",
	priority: PRIORITY,
	load,
});
