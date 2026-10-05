/**
 * Cordis Context interface subset (deepseek-harness vendor/cordis/src/context.ts)
 *
 * Semantic snapshot from deepseek-harness @ commit `639ed015` (MERGE-FINAL §0-2).
 * This file exports the `Context` type that the snapshot plugin imports in place
 * of `import type { Context } from '@deepseek-ai/cordis'`.
 *
 * Original exported capabilities from vendor/cordis/src/context.ts:
 *   - ctx.events (EventsService): on, emit, parallel, serial, bail, waterfall
 *   - ctx.logger (LoggerService): named logging
 *   - ctx.reflect (ReflectService): ctx.get, ctx.provide interop
 *   - ctx.registry (RegistryService): ctx.plugin(), ctx.inject(), plugin lifecycle
 *   - ctx.root / ctx.baseUrl and isolate/intercept symbol maps
 *
 * Minimal subset command-compact consumes (fields added to Context by the
 * commands/compaction packages and by fiber lifecycle):
 *   - ctx.events.on(event, handler)
 *   - ctx.compaction.compactNow(agent, signal, commandId)
 *   - ctx.commands.register(definition) -> disposer
 *   - ctx.effect(factory, key)  (generator form: yields are teardown registrations)
 *   - ctx.reflect.provide(name, impl) / ctx.reflect.get(name)
 *
 * The bridge implements this shape locally in src/cordis-context.ts; structural
 * typing makes the two definitions interchangeable. Zero cordis runtime imports.
 */

import type { CommandInvocation, CommandResult } from "./dsh-commands.ts"
import type { CompactionSummary } from "./dsh-compaction.ts"

/** Full capability listing, for attribution (see header). */
export type OriginalContext = {
	events: {
		on: (event: string, handler: (...args: unknown[]) => void) => () => void
	}
	// Referenced for structural documentation only:
	// - ctx.logger / ctx.registry / ctx.root / ctx.baseUrl / isolate+intercept maps
}

/** Minimal Context — exactly the fields command-compact uses. */
export type Context = {
	/** Event bus subscription. */
	events: {
		on: (event: string, handler: (...args: unknown[]) => void) => () => void
	}
	/** Compaction seam; resolves `null` when no history is compactable yet. */
	compaction: {
		compactNow: (
			agent: unknown,
			signal: AbortSignal,
			commandId: string,
		) => Promise<CompactionSummary | null>
	}
	/** Plugin-owned command registration; returns the registration disposer. */
	commands: {
		register: (opts: {
			definitionId: string
			name: string
			description: string
			handler: (invocation: CommandInvocation) => Promise<CommandResult>
		}) => () => void
	}
	/** Fiber lifecycle: drives the generator; each yielded value is a teardown. */
	effect: (factory: () => Generator<unknown, void, unknown>, key: string) => void
	/** Service provide/get interop. */
	reflect: {
		provide: (name: string, impl: unknown) => void
		get: (name: string) => unknown
	}
}
