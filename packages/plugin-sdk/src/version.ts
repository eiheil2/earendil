/**
 * Contract version of the pi extension surface.
 *
 * Independent from `PROTOCOL_VERSION` (transport layer, `@earendil-works/pi-protocol`) and from the
 * host package version (distribution, `@earendil-works/pi-coding-agent`). A transport upgrade must
 * not break extensions, and a host release must not silently change the contract, so the contract
 * gets its own integer.
 *
 * Integer major only, no minor segment:
 * - Bumping is reserved for changes that force extension authors to edit code (removing or renaming
 *   an `ExtensionAPI` method, an event name or a result field; narrowing a type; changing a
 *   documented behavior).
 * - Additive evolution (a new event member, a new optional manifest field, a new capability value)
 *   does not bump: old extensions keep compiling, and the risk of an exhaustive `switch` without a
 *   `default` branch is pinned by the compatibility matrix, not by a version number.
 *
 * pi's own precedent for integer versions: `PROTOCOL_VERSION` (`packages/protocol/src/protocol.ts`),
 * `CURRENT_SESSION_VERSION` (`packages/coding-agent/src/core/session-manager.ts`), and
 * `PLUGIN_PACKAGE_PROFILE_VERSION` (`packages/coding-agent/src/experimental/plugins/package.ts`).
 */

/** Major version of the extension contract implemented by this SDK. */
export const PLUGIN_API_VERSION = 1 as const;

export type PluginApiVersion = typeof PLUGIN_API_VERSION;

/**
 * Version assumed by an extension whose manifest declares no `pi.apiVersion`.
 *
 * Shipping the contract must not empty the plugin ecosystem, so an undeclared version is the legacy
 * tier: always loadable, and silent (a warning per legacy extension would turn every existing
 * install into noise).
 */
export const LEGACY_API_VERSION = "0";

/** Versions a host implementing `PLUGIN_API_VERSION` accepts. */
export const SUPPORTED_API_VERSIONS: readonly string[] = [LEGACY_API_VERSION, String(PLUGIN_API_VERSION)];
