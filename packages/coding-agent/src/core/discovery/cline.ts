/**
 * Cline provider: .clinerules (file or directory) and ~/.cline.
 * Port of omp cline.ts subset; walks up from cwd like omp does.
 */
import { probeCandidates, walkUpFor } from "./helpers.ts";
import { registerProvider } from "./registry.ts";
import type { DiscoveredAsset, DiscoveryLoadContext, DiscoveryLoadResult } from "./types.ts";

const PROVIDER_ID = "cline";
const DISPLAY_NAME = "Cline";
const PRIORITY = 40;

async function load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult> {
	const items: DiscoveredAsset[] = probeCandidates(PROVIDER_ID, DISPLAY_NAME, ctx, [
		{ rel: ".cline", kind: "config-dir", level: "user", base: "home" },
	]);
	const found = walkUpFor(ctx.cwd, ".clinerules", ctx.home);
	if (found && !items.some((item) => item.path === found)) {
		items.push({
			id: `${PROVIDER_ID}:${found}`,
			provider: PROVIDER_ID,
			providerName: DISPLAY_NAME,
			kind: "rules",
			path: found,
			level: "project",
		});
	}
	return { items };
}

registerProvider({
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Inherit rules from .clinerules and ~/.cline",
	priority: PRIORITY,
	load,
});
