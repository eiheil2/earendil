/**
 * The `fs.stat` / `fs.write` tools as an extension. The tools expose
 * DSH's `ctx.fs` versioned-write capability through the extension
 * `registerTool` route (not a chord facet or an ExtensionContext
 * injection), so no core type changes are required.
 *
 * Both tools register inactive. Activate them with `--tools`, the
 * `defaultTools` setting, or `setActiveTools()`.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import type { VersionedFsBackend } from "./backend.ts";
import { NodeVersionedFsBackend } from "./node-backend.ts";
import { createFsStatToolDefinition, createFsWriteToolDefinition } from "./tool.ts";

export { InMemoryVersionedFsBackend, type VersionedFsBackend } from "./backend.ts";
export { NodeVersionedFsBackend } from "./node-backend.ts";
export {
	type FsErrorCode,
	type FsInfo,
	type FsObservation,
	FsVersionedError,
	type FsWriteIntent,
	type FsWriteOutcome,
} from "./types.ts";

export interface FsVersionedExtensionOptions {
	/** Storage backend for both tools. Default: the local filesystem. */
	backend?: VersionedFsBackend;
	/**
	 * Register the tools active. Default: `false`; activate with
	 * `--tools`, the `defaultTools` setting, or `setActiveTools()`.
	 */
	defaultActive?: boolean;
}

export function createFsVersionedExtension(options: FsVersionedExtensionOptions = {}): ExtensionFactory {
	const backend = options.backend ?? new NodeVersionedFsBackend();
	const defaultActive = options.defaultActive ?? false;
	return (pi: ExtensionAPI) => {
		pi.registerTool({ ...createFsStatToolDefinition(backend), defaultActive });
		pi.registerTool({ ...createFsWriteToolDefinition(backend), defaultActive });
	};
}

export default createFsVersionedExtension();
