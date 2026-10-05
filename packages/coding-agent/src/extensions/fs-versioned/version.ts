import { createHash } from "node:crypto";
import { normalizeToLF } from "../../core/tools/edit-diff.ts";

/**
 * Freshness token for a file: the SHA-256 hex digest of its LF-normalized
 * content. The normalization is the edit tool's own (`normalizeToLF` from
 * `core/tools/edit-diff.ts`, reused read-only), so a version always reflects
 * the content the edit tool would match against, regardless of CRLF vs LF on
 * disk.
 */
export function computeFileVersion(content: string): string {
	return createHash("sha256").update(normalizeToLF(content)).digest("hex");
}
