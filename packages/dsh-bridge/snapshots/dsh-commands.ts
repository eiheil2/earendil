/**
 * Command definitions: brands, invocation, and result types.
 *
 * Semantic snapshot from deepseek-harness @ commit `639ed015` (MERGE-FINAL §0-2):
 *   - packages/interaction/commands/src/brand.ts   (CommandDefinitionId, CommandId brands + constructors)
 *   - packages/interaction/commands/src/index.ts   (CommandInvocation, subset)
 *   - packages/interaction/commands/src/types.ts   (CommandResult)
 *
 * Adaptations (recorded per snapshot policy):
 *   - `Branded<B>` from `@deepseek-ai/dsh-brand` inlined as `string & { readonly __brand }`.
 *   - `CommandId` in `CommandInvocation` erased to plain `string`: bridge-supplied
 *     invocations mint ids without the DSH executor, and the brand is directional
 *     (DSH executor -> plugin). `CommandDefinitionId` keeps its brand because the
 *     plugin itself constructs it via `CommandDefinitionId()`.
 *   - `CommandInvocation.agent` (DSH `Agent`) typed `unknown`; the bridge passes it
 *     through to `compactNow` untouched.
 *   - `attachments` field omitted (unused by command-compact).
 *
 * Zero `@deepseek-ai/*` runtime imports.
 */

/** Stable, plugin-owned identity of a command definition (brand.ts). */
export type CommandDefinitionId = string & { readonly __brand: "CommandDefinitionId" }

/**
 * Brand a plugin-namespaced command definition identity.
 * @param id - stable identity chosen by the registering plugin.
 * @returns the same string, branded; no validation is performed.
 */
export function CommandDefinitionId(id: string): CommandDefinitionId {
	return id as CommandDefinitionId
}

/** Executor-minted execution pairing id (brand.ts); erased to plain string, see header. */
export type CommandId = string

/**
 * Brand a string as a CommandId (brand.ts; present for API fidelity).
 * @param id - the executor-minted pairing id.
 * @returns the same string; no validation is performed.
 */
export function CommandId(id: string): CommandId {
	return id
}

/** One command execution (index.ts; subset used by command-compact). */
export interface CommandInvocation {
	/** Pairing id of this invocation. */
	readonly commandId: CommandId
	/** Exact agent whose UI received the command. */
	readonly agent: unknown
	/** Exact text following the registered command name, including separator whitespace. */
	readonly rawInput: string
	/** Cancellation signal owned by the dispatching UI request. */
	readonly signal: AbortSignal
}

/** Expected command outcome rendered directly by the dispatching UI (types.ts). */
export type CommandResult =
	| {
			readonly kind: "success"
			readonly text?: string
			/** Earlier authoritative domain event that owns a richer presentation. */
			readonly sourceEventSeq?: number
	  }
	| { readonly kind: "error"; readonly text: string }
