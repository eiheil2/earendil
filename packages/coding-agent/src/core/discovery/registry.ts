/**
 * Read-only provider registry for external agent config discovery.
 * Mirrors the omp capability registry: providers self-register, callers only
 * ask for `discoverAssets(ctx)`.
 */
import type { DiscoveredAsset, DiscoveryLoadContext, DiscoveryLoadResult, DiscoveryProvider } from "./types.ts";

const providers: DiscoveryProvider[] = [];

export function registerProvider(provider: DiscoveryProvider): void {
	if (providers.some((existing) => existing.id === provider.id)) return;
	providers.push(provider);
}

export function listProviders(): readonly DiscoveryProvider[] {
	return [...providers].sort((a, b) => b.priority - a.priority);
}

/** Scan every registered provider; deduplicate by absolute path. */
export async function discoverAssets(ctx: DiscoveryLoadContext): Promise<DiscoveredAsset[]> {
	const items: DiscoveredAsset[] = [];
	const seen = new Set<string>();
	for (const provider of listProviders()) {
		let result: DiscoveryLoadResult;
		try {
			result = await provider.load(ctx);
		} catch {
			// A broken provider must not block discovery of the rest.
			continue;
		}
		for (const item of result.items) {
			if (seen.has(item.path)) continue;
			seen.add(item.path);
			items.push(item);
		}
	}
	return items;
}
