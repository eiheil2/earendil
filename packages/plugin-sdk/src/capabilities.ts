/**
 * Capability declarations.
 *
 * A capability is what an extension says it will do; the host observes what it actually did during
 * loading and compares the two. Declarations are for auditing and trust ("installing this package
 * registers MCP servers"), not for enforcement: the mismatch default is a warning.
 *
 * Closed enumeration, copied from the real registration surface of `ExtensionAPI`
 * (`packages/coding-agent/src/core/extensions/types.ts`) rather than invented. Adding a value is a
 * non-breaking change for old hosts, which ignore capability strings they do not know.
 *
 * `ui.*` is deliberately absent: UI availability depends on the run mode (`ctx.ui` only exists in
 * `tui` and `rpc`) and is only reachable from event handlers, so it cannot be observed at load time.
 * Unstable UI capabilities belong in the manifest's `experimental` list instead.
 */
export const EXTENSION_CAPABILITIES = [
	"event.subscribe",
	"tool.register",
	"command.register",
	"shortcut.register",
	"flag.register",
	"provider.register",
	"mcp.register",
	"virtualModel.register",
	"eventbus.publish",
] as const;

export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/**
 * Namespace for capabilities whose shape may still change.
 *
 * Declared in `pi.experimental`, never checked against `EXTENSION_CAPABILITIES`, and never
 * enforced: an unknown experimental entry is ignored exactly like an unknown capability.
 */
export const EXPERIMENTAL_CAPABILITY_PREFIX = "experimental.";

export function isExtensionCapability(value: string): value is ExtensionCapability {
	return (EXTENSION_CAPABILITIES as readonly string[]).includes(value);
}
