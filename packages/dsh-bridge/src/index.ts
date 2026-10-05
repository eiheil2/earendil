/**
 * @module @earendil-works/dsh-bridge
 *
 * Cross-repo bridge: Cordis-style plugin → pi ExtensionAPI.
 *
 * Philosophy (MERGE-FINAL §0-2, plan-plugin-contract §5):
 *   - DSH is a porting source only; no runtime dependency on @deepseek-ai/*.
 *   - chord facet path is CLOSED — only the ExtensionAPI narrow path is used.
 *   - Plugin apply(ctx) receives a duck-typed Context (cordis-context.ts);
 *     missing host capabilities degrade fail-soft (warn + no-op).
 *   - snapshots/ holds the faithful port of the bridged plugin and the type
 *     shapes it imports (provenance: deepseek-harness @ 639ed015).
 */

export * from "./agent-events.ts";
export * from "./cordis-context.ts";
export * from "./llm-adapter.ts";
export * from "./session-log.ts";
