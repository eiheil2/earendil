/**
 * `@earendil-works/pi-plugin-sdk` is the versioned contract surface for pi extensions.
 *
 * "plugin" in this package name refers to the npm package. The contract terms are "extension" and
 * `Extension*`. pi's `experimental/plugin` export is a different thing (RPC service plugins) and has
 * nothing to do with this package.
 *
 * This package declares the contract; it does not re-export host implementation types. An extension
 * declares what it will do in the `pi` block of its `package.json`:
 *
 * ```json
 * {
 *   "name": "acme-toolkit",
 *   "pi": {
 *     "extensions": ["./dist/index.js"],
 *     "apiVersion": "1",
 *     "minHostVersion": ">=1.0.0 <2.0.0",
 *     "capabilities": ["tool.register", "command.register", "event.subscribe"]
 *   }
 * }
 * ```
 *
 * What the contract guarantees: an extension depends on this package and its own dependencies, never
 * on pi's internal modules, so refactoring the core does not break extensions.
 *
 * What it does not guarantee: that an extension cannot do dangerous things. Extensions are not
 * sandboxed - they can read the environment, write files, make network requests and shut pi down.
 * Stability and security are different problems and are not mixed here.
 */
export * from "./api.ts";
export * from "./capabilities.ts";
export * from "./compat.ts";
export * from "./events.ts";
export * from "./manifest.ts";
export * from "./version.ts";
