/**
 * Discovery module: importing this registers every provider.
 * Callers use `discoverAssets` / `listProviders`; all scans are read-only.
 */
import "./claude.ts";
import "./cline.ts";
import "./codex.ts";
import "./cursor.ts";
import "./gemini.ts";
import "./github.ts";
import "./opencode.ts";
import "./vscode.ts";
import "./windsurf.ts";

export { discoverAssets, listProviders, registerProvider } from "./registry.ts";
export type {
	DiscoveredAsset,
	DiscoveredAssetKind,
	DiscoveredAssetLevel,
	DiscoveryLoadContext,
	DiscoveryLoadResult,
	DiscoveryProvider,
} from "./types.ts";
