# @earendil-works/pi-plugin-sdk

The versioned contract surface for pi extensions: the manifest envelope, the capability
enumeration, the event names, and the rules a host applies when it loads an extension.

## Terminology

"plugin" in this package name refers to the npm package name. The contract terms are **extension**
and `Extension*`. pi's `./experimental/plugin` export is a different thing (RPC service plugins) and
is unrelated to this package.

## What an extension declares

The contract lives in the `pi` block of `package.json`. There is no separate manifest file:

```jsonc
{
  "name": "acme-toolkit",
  "version": "1.2.0",
  "pi": {
    // Resources: package-relative paths, unchanged since the manifest was introduced.
    "extensions": ["./dist/index.js"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],

    // Contract envelope: all four fields are optional.
    "apiVersion": "1",                  // exact contract major version
    "minHostVersion": ">=1.0.0 <2.0.0", // semver range, warned about, never enforced
    "capabilities": ["tool.register"],  // audited against what the extension actually registers
    "experimental": ["experimental.ui.widget"]
  }
}
```

`apiVersion` absent means the legacy tier: always loadable, and silent. Publishing the contract must
not empty the plugin ecosystem.

## Severity at load time

| Level | Trigger | Host behavior |
|---|---|---|
| E0 | `apiVersion` this host does not implement; capability mismatch under `--strict-capabilities` | extension is rejected, lands in `errors[]`, other extensions keep loading |
| E1 | the factory throws | extension is discarded atomically, lands in `errors[]` |
| E3 | `minHostVersion` not satisfied; capability declaration disagrees with what was observed | warning in `warnings[]`, extension loads |
| E4 | unknown manifest key, unknown capability string, unknown `experimental` entry | silently ignored, never warned about |

Collection level is fail-soft (one bad extension never blocks the others); inside one extension the
load is fail-fast and atomic (the checks run before `commit()`, so a rejected extension registers
nothing).

## Versioning

`PLUGIN_API_VERSION` is an integer major, independent from `PROTOCOL_VERSION` (transport) and from
the host package version (distribution). Additive evolution - a new event, a new optional manifest
field, a new capability value - does not bump it. Removing or renaming an API method, an event name
or a result field, narrowing a type, or changing documented behavior does.

Adding a capability value is deliberately non-breaking for old hosts: capability strings a host does
not know are ignored, never rejected.

## Lenient parsing, in three directions

pi applies three different policies to three different kinds of data. They are not meant to be
unified; the reason is where the data comes from.

| Data | Policy | Why |
|---|---|---|
| Manifest (written by the ecosystem) | ignore unknown keys, never warn | forward compatibility: a new host reads old extensions |
| Versioned on-disk state pi wrote itself (e.g. `plugin-packages-<id>.json`) | reject unknown keys | backward compatibility protection for a format pi controls |
| Contract version | exact value | a version that is wrong is wrong |

## Entry points

| Import | Contents |
|---|---|
| `@earendil-works/pi-plugin-sdk` | everything below, re-exported |
| `@earendil-works/pi-plugin-sdk/version` | `PLUGIN_API_VERSION` and the supported version list |
| `@earendil-works/pi-plugin-sdk/manifest` | envelope types and the typebox schema for the `pi` block |
| `@earendil-works/pi-plugin-sdk/capabilities` | the closed capability enumeration |
| `@earendil-works/pi-plugin-sdk/events` | the event names accepted by `pi.on(...)` |
| `@earendil-works/pi-plugin-sdk/api` | which registration method needs which capability |
| `@earendil-works/pi-plugin-sdk/compat` | the load-time envelope rules |

## Guarantees, and their limits

Guaranteed: an extension that depends on this package and its own dependencies does not depend on pi's
internal modules, so core refactoring does not break it.

Not guaranteed: that an extension cannot do dangerous things. Extensions are not sandboxed. They can
read `process.env`, write files, make network requests, and call `ctx.shutdown()` to stop pi.

Event payload shapes are not declared in this package yet; the payloads reference host
implementation types, and copying them would relocate the coupling instead of removing it. Until the
host-conformance test pins them, a handler receives the host's own event and context types.