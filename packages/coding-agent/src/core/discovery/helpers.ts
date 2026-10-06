/**
 * Shared helpers for provider scans: check well-known candidate paths and
 * keep results in a stable shape. Ports the `probe` pattern used by omp's
 * discovery helpers; read-only (existsSync only).
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DiscoveredAsset, DiscoveredAssetKind, DiscoveredAssetLevel, DiscoveryLoadContext } from "./types.ts";

export interface CandidateSpec {
	/** Path relative to `base`. */
	rel: string;
	kind: DiscoveredAssetKind;
	level: DiscoveredAssetLevel;
	/** "home" scans under ctx.home, "cwd" under ctx.cwd. */
	base: "home" | "cwd";
}

export function probeCandidates(
	provider: string,
	providerName: string,
	ctx: DiscoveryLoadContext,
	candidates: readonly CandidateSpec[],
): DiscoveredAsset[] {
	const items: DiscoveredAsset[] = [];
	for (const candidate of candidates) {
		const base = candidate.base === "home" ? ctx.home : ctx.cwd;
		const absolute = resolve(base, candidate.rel);
		if (!isAbsolute(absolute)) continue;
		if (!existsSync(absolute)) continue;
		items.push({
			id: `${provider}:${absolute}`,
			provider,
			providerName,
			kind: candidate.kind,
			path: absolute,
			level: candidate.level,
		});
	}
	return items;
}

/** Walk up from `startDir` looking for `relName`, bounded by `home`/fs root. */
export function walkUpFor(startDir: string, relName: string, stopDir: string): string | null {
	let current = resolve(startDir);
	const stop = resolve(stopDir);
	for (;;) {
		const candidate = join(current, relName);
		if (existsSync(candidate)) return candidate;
		if (current === stop) return null;
		const parent = resolve(current, "..");
		if (parent === current) return null;
		current = parent;
	}
}
