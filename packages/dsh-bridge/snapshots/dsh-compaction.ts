/**
 * Manual compaction error classification.
 *
 * Semantic snapshot from deepseek-harness @ commit `639ed015` (MERGE-FINAL §0-2):
 *   - packages/compaction/compaction/src/index.ts (ManualCompactionErrorCode, ManualCompactionError)
 *
 * Adaptations (recorded per snapshot policy):
 *   - Constructor parameter property (`readonly code`) rewritten as an explicit
 *     field + assignment: pi's root config requires erasable-only TypeScript.
 *   - `CompactionSummary` below mirrors the object `compactNow()` resolves with
 *     (fields consumed by command-compact: `shadowedSeqs`, `shadowedTokenCount`,
 *     `summarySeq`); `SessionSeq` erased to `number`.
 *
 * Zero `@deepseek-ai/*` runtime imports.
 */

/** Expected failure classes for an explicit idle-session compaction request (index.ts). */
export type ManualCompactionErrorCode =
	| "busy"
	| "cancelled"
	| "changed"
	| "summary"
	| "commit"
	| "persistence"

/** Expected manual-compaction failure suitable for a direct human-command result (index.ts). */
export class ManualCompactionError extends Error {
	override readonly name = "ManualCompactionError"
	/** Stable failure class. */
	readonly code: ManualCompactionErrorCode

	/**
	 * Create one classified compaction failure.
	 * @param code - stable failure class.
	 * @param message - backend diagnostic retained as the Error message.
	 * @param options - optional original failure.
	 */
	constructor(code: ManualCompactionErrorCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.code = code
	}
}

/** What a compaction produced; `null` means nothing compactable yet (see plugin usage). */
export interface CompactionSummary {
	readonly shadowedSeqs: readonly number[]
	readonly shadowedTokenCount: number
	readonly summarySeq: number
}
