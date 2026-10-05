/**
 * Contract types for the versioned filesystem tools (`fs.stat` / `fs.write`).
 *
 * Ported from DSH's `@deepseek-ai/dsh-fs` vocabulary with one deliberate
 * difference (merge rule R9): versions are plain `string` content hashes, not
 * branded types, matching pi's nominal-string style. The hash basis is the
 * LF-normalized file content, the same normalization the `edit` tool matches
 * against (`core/tools/edit-diff.ts`).
 */

/** What observing a target yields: present (with its version) or absent. */
export type FsObservation = { kind: "present"; version: string } | { kind: "absent" };

/** Metadata about a target, as `fs.stat` returns. */
export interface FsInfo {
	/**
	 * Freshness token: for regular files, the LF-normalized content hash.
	 * For other target types, an opaque stat-identity token. Plain string (R9).
	 */
	version: string;
	/** Whether the target is a regular file, a directory, or something else. */
	type: "file" | "directory" | "other";
	/** Byte size of a regular file, when known. */
	size?: number;
}

/**
 * Guarded write intent. `createIfAbsent` rejects an existing target with
 * `FS_NOT_OBSERVED`; `replaceIfVersion` rejects absence or version mismatch
 * with `FS_STALE_VERSION`. Omitting the intent means unconditional
 * create-or-overwrite.
 */
export type FsWriteIntent = { kind: "createIfAbsent" } | { kind: "replaceIfVersion"; version: string };

/** Outcome of a full-file write. */
export interface FsWriteOutcome {
	/** Whether the write created a new file or replaced an existing one. */
	operation: "create" | "update";
	/** Version of the file after the write. */
	version: string;
	/** Content before the write, or `null` when the file did not exist. */
	before: string | null;
	/** Content after the write. */
	after: string;
}

/** Stable, machine-routable codes for versioned-fs failures. */
export type FsErrorCode = "FS_NOT_FOUND" | "FS_STALE_VERSION" | "FS_NOT_OBSERVED" | "FS_IO_ERROR" | "FS_INVALID_TARGET";

/**
 * Typed error carrying a stable {@link FsErrorCode} so retry and UI layers can
 * branch without parsing messages. The code also appears in the message text,
 * which is what a failed tool call reports to the model.
 */
export class FsVersionedError extends Error {
	readonly code: FsErrorCode;

	constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
		super(message, options);
		this.name = "FsVersionedError";
		this.code = code;
	}
}
