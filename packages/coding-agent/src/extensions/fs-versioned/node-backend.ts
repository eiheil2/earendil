import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { stat as fsStat, readFile, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import type { VersionedFsBackend } from "./backend.ts";
import { type FsInfo, type FsObservation, FsVersionedError, type FsWriteIntent, type FsWriteOutcome } from "./types.ts";
import { computeFileVersion } from "./version.ts";

/** True for ENOENT/ENOTDIR, the errors an absent target produces. */
function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Opaque freshness token for non-regular targets, derived from stat
 * identity like DSH's local backend. Consumers must not parse it.
 */
function identityVersion(stats: Stats): string {
	return createHash("sha256").update(`${stats.mtimeMs}:${stats.size}`).digest("hex");
}

/**
 * Local-filesystem {@link VersionedFsBackend}. File versions are
 * LF-normalized content hashes; directory and other versions are
 * opaque stat-identity tokens. Writes serialize per path through the
 * same mutation queue the `edit` tool uses, and the intent guard runs
 * inside the queue, so the guard holds across concurrent
 * interleavings within the process.
 */
export class NodeVersionedFsBackend implements VersionedFsBackend {
	async observe(path: string): Promise<FsObservation> {
		const info = await this.stat(path);
		return info === undefined ? { kind: "absent" } : { kind: "present", version: info.version };
	}

	async stat(path: string): Promise<FsInfo | undefined> {
		let stats: Stats;
		try {
			stats = await fsStat(path);
		} catch (error: unknown) {
			if (isMissingPathError(error)) return undefined;
			throw new FsVersionedError(
				`fs.stat: could not stat ${path}: ${describeError(error)} (FS_IO_ERROR)`,
				"FS_IO_ERROR",
				{ cause: error },
			);
		}

		if (stats.isDirectory()) {
			return { version: identityVersion(stats), type: "directory" };
		}
		if (!stats.isFile()) {
			return { version: identityVersion(stats), type: "other" };
		}

		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error: unknown) {
			throw new FsVersionedError(
				`fs.stat: could not read ${path}: ${describeError(error)} (FS_IO_ERROR)`,
				"FS_IO_ERROR",
				{ cause: error },
			);
		}
		return { version: computeFileVersion(content), type: "file", size: stats.size };
	}

	async writeText(path: string, content: string, intent?: FsWriteIntent): Promise<FsWriteOutcome> {
		return withFileMutationQueue(path, async () => {
			let existing: string | undefined;
			try {
				existing = await readFile(path, "utf-8");
			} catch (error: unknown) {
				if (!isMissingPathError(error)) {
					throw new FsVersionedError(
						`fs.write: could not read ${path}: ${describeError(error)} (FS_IO_ERROR)`,
						"FS_IO_ERROR",
						{ cause: error },
					);
				}
			}

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

			await writeFile(path, content, "utf-8");
			return {
				operation: existing === undefined ? ("create" as const) : ("update" as const),
				version: computeFileVersion(content),
				before: existing ?? null,
				after: content,
			};
		});
	}
}
