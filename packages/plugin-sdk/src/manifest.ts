/**
 * The `pi` block of a package manifest.
 *
 * There is no `pi-plugin.json`: discovery already reads the `pi` block of `package.json`, and a
 * second manifest format would be a third discovery path (`resolveExtensionEntries` was duplicated
 * in two modules before it was unified).
 *
 * Forward-compatibility rule for the whole file: parsing never fails on an unknown key and never
 * warns about one. pi's manifest reader has always picked known fields and ignored the rest, and
 * `test/skills.test.ts` locks in the "unknown field must not warn" behavior for skills. Note the
 * opposite policy pi applies to its own versioned on-disk state (`plugin-packages-<id>.json`
 * rejects unknown keys): data from the ecosystem is read leniently, data pi wrote itself is read
 * strictly.
 *
 * The schema below is an authoring aid (a plugin can validate its own manifest in CI). Hosts do not
 * validate manifests against it, because a host must load manifests that declare capabilities or an
 * `apiVersion` from a newer SDK.
 */
import { Type } from "typebox";
import { EXTENSION_CAPABILITIES } from "./capabilities.ts";
import { PLUGIN_API_VERSION } from "./version.ts";

/** Resource fields, unchanged since the manifest was introduced: package-relative paths. */
export const EXTENSION_RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

export type ExtensionResourceField = (typeof EXTENSION_RESOURCE_FIELDS)[number];

/**
 * Contract envelope: the four scalar fields that say which contract an extension was written against.
 *
 * All four are optional. `apiVersion` absent means the legacy tier (see `LEGACY_API_VERSION`),
 * `minHostVersion` absent means "no host requirement", `capabilities` absent means "not declared",
 * and `experimental` absent means "no unstable capabilities".
 */
export interface ExtensionContractEnvelope {
	/** Exact contract major version, e.g. `"1"`. */
	apiVersion?: string;
	/** semver range the host must satisfy, e.g. `">=1.0.0 <2.0.0"`. Warned about, never enforced. */
	minHostVersion?: string;
	/** Capabilities the extension intends to use. Unknown values are ignored. */
	capabilities?: string[];
	/** Unstable capabilities, e.g. `"experimental.ui.widget"`. Never enforced. */
	experimental?: string[];
}

export const ExtensionContractSchema = Type.Object({
	apiVersion: Type.Optional(Type.Literal(String(PLUGIN_API_VERSION))),
	minHostVersion: Type.Optional(Type.String()),
	capabilities: Type.Optional(
		Type.Array(Type.Union(EXTENSION_CAPABILITIES.map((capability) => Type.Literal(capability)))),
	),
	experimental: Type.Optional(Type.Array(Type.String())),
});
