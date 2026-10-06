/**
 * Capability-provider discovery types, ported from the omp
 * `capability/types.ts` structure (oh-my-pi). Each provider scans one
 * external agent's on-disk config tree in a read-only fashion and reports
 * candidate assets. Nothing is imported until the user confirms per item.
 */

/** What kind of asset a provider found. */
export type DiscoveredAssetKind =
	| "config-dir"
	| "settings"
	| "context-file"
	| "rules"
	| "skills"
	| "prompts"
	| "agents"
	| "mcp";

/** Where the asset lives relative to the user. */
export type DiscoveredAssetLevel = "user" | "project";

/** One candidate found on disk; adopted assets are persisted with this shape. */
export interface DiscoveredAsset {
	/** Stable id: `${provider}:${path}`. */
	id: string;
	/** Provider that found this asset (e.g. "claude"). */
	provider: string;
	/** Human-readable provider name (e.g. "Claude Code"). */
	providerName: string;
	kind: DiscoveredAssetKind;
	/** Absolute path to the file or directory on disk. This is the 来源. */
	path: string;
	level: DiscoveredAssetLevel;
}

/** Context passed to every provider load. */
export interface DiscoveryLoadContext {
	/** Project working directory to scan. */
	cwd: string;
	/** User home directory to scan. */
	home: string;
}

export interface DiscoveryLoadResult {
	items: DiscoveredAsset[];
	warnings?: string[];
}

/** A provider that can load items for the discovery capability. */
export interface DiscoveryProvider {
	id: string;
	displayName: string;
	description: string;
	/** Higher priority runs first; kept for parity with the omp registry. */
	priority: number;
	load(ctx: DiscoveryLoadContext): Promise<DiscoveryLoadResult>;
}
