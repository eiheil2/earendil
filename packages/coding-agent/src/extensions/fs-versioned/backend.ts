import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { type FsInfo, type FsObservation, FsVersionedError, type FsWriteIntent, type FsWriteOutcome } from "./types.ts";
import { computeFileVersion } from "./version.ts";

/**
 * Pluggable storage for the versioned fs tools. Paths arrive
 * resolved to absolute form by the tool layer. Implementations must
 * evaluate a write intent against the committed state at commit time
 * (not at call time), so concurrent writers guarding on the same
 * version produce exactly one success.
 */
export interface VersionedFsBackend {
	/** Observe a path: a present observation carries the current version. */
	observe(path: string): Promise<FsObservation>;
	/** Full metadata about a path; `undefined` when the target is absent. */
	stat(path: string): Promise<FsInfo | undefined>;
	/**
	 * Write `content` to `path`, honoring `intent` when supplied.
	 * Rejects with {@link FsVersionedError} (`FS_STALE_VERSION` /
	 * `FS_NOT_OBSERVED`) when the guard fails.
	 */
	writeText(path: string, content: string, intent?: FsWriteIntent): Promise<FsWriteOutcome>;
}

/**
 * In-memory {@link VersionedFsBackend} for tests. Writes serialize per
 * path through the same mutation queue the `edit` tool uses, and the
 * intent guard runs inside the queue, so the guard holds across
 * concurrent interleavings.
 */
export class InMemoryVersionedFsBackend implements VersionedFsBackend {
	private files = new Map<string, string>();

	async observe(path: string): Promise<FsObservation> {
		const content = this.files.get(path);
		return content === undefined ? { kind: "absent" } : { kind: "present", version: computeFileVersion(content) };
	}

	async stat(path: string): Promise<FsInfo | undefined> {
		const content = this.files.get(path);
		if (content === undefined) return undefined;
		return { version: computeFileVersion(content), type: "file", size: content.length };
	}

	async writeText(path: string, content: string, intent?: FsWriteIntent): Promise<FsWriteOutcome> {
		return withFileMutationQueue(path, async () => {
			const existing = this.files.get(path);
			if (intent) {
				if (intent.kind === "createIfAbsent") {
					if (existing !== undefined) {
						throw new FsVersionedError(
							`fs.write: ${path} already exists; createIfAbsent rejected (FS_NOT_OBSERVED)`,
							"FS_NOT_OBSERVED",
						);
					}
				} else {
					const current = existing === undefined ? undefined : computeFileVersion(existing);
					if (current === undefined || current !== intent.version) {
						throw new FsVersionedError(
							`fs.write: ${path} is absent or changed since version ${intent.version}; replaceIfVersion rejected (FS_STALE_VERSION)`,
							"FS_STALE_VERSION",
						);
					}
				}
			}
			this.files.set(path, content);
			return {
				operation: existing === undefined ? ("create" as const) : ("update" as const),
				version: computeFileVersion(content),
				before: existing ?? null,
				after: content,
			};
		});
	}
}
