/**
 * Index over the pi documentation corpus, backing the stable `pi://` URL protocol
 * described in `docs/documentation.md`.
 *
 * Two stores answer the same queries through one index, in this order:
 *
 * 1. `docs/` on disk, resolved through `getDocsPath()` (pi's own package root, so a
 *    consumer's `node_modules/docs` can never shadow it). This is what a source
 *    checkout, an npm install, and a binary release that ships `docs/` beside the
 *    executable all see, and bodies are read per request so a docs edit shows up
 *    without a rebuild.
 * 2. The gzipped payload inlined in `docs-embed.generated.ts`, which is what a
 *    single-file binary with no `docs/` directory falls back to.
 *
 * Both stores expose the same lazily-resolving shape: listing parses only the file
 * name list (never the compressed bodies), and a body read is what triggers the one
 * off-thread `gunzip` of the inlined blob, shared across concurrent reads.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { getDocsPath } from "../config.ts";
import { PI_DOCS_EMBED } from "./docs-embed.generated.ts";

const gunzipAsync = promisify(gunzip);

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export interface PiDocsIndex {
	/** Sorted documentation file names relative to `docs/`, `/`-separated. */
	readonly filenames: readonly string[];
	/** A doc body, or `undefined` when the corpus has no such file. */
	getDoc(relativePath: string): Promise<string | undefined>;
}

/**
 * Decode the two-line inlined payload - line 1 a JSON array of file names, line 2
 * base64 gzip of the index-aligned bodies - into a lazily inflating index.
 *
 * Returns `null` for the empty placeholder, which tells the caller to fall through
 * to the next store. Listing touches only line 1, so a corrupt blob still lists and
 * only a body read reports the corruption.
 */
export function decodePiDocsIndex(embed: string): PiDocsIndex | null {
	const newline = embed.indexOf("\n");
	if (newline === -1) return null;
	const names: unknown = JSON.parse(embed.slice(0, newline));
	if (!isStringArray(names)) {
		throw new Error("Embedded pi docs index file-name line is not a JSON string array.");
	}
	let bodies: Promise<Record<string, string>> | undefined;
	return {
		filenames: names,
		getDoc(relativePath: string): Promise<string | undefined> {
			bodies ??= (async () => {
				const inflated = await gunzipAsync(Buffer.from(embed.slice(newline + 1), "base64"));
				const decoded: unknown = JSON.parse(inflated.toString("utf8"));
				if (!isStringArray(decoded)) {
					throw new Error("Embedded pi docs index body blob is not a JSON string array.");
				}
				const map: Record<string, string> = {};
				for (const [index, name] of names.entries()) map[name] = decoded[index];
				return map;
			})();
			return bodies.then((map) => map[relativePath]);
		},
	};
}

/** Sorted `.md` file names under `docsDir`; empty when the directory is absent. */
function listDocsOnDisk(docsDir: string): string[] {
	try {
		return readdirSync(docsDir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) =>
				join(entry.parentPath, entry.name)
					.slice(docsDir.length + 1)
					.split(sep)
					.join("/"),
			)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Disk-backed index: bodies are read per request, so nothing is held in memory until asked for. */
function diskDocsIndex(docsDir: string, filenames: readonly string[]): PiDocsIndex {
	return {
		filenames,
		getDoc(relativePath: string): Promise<string | undefined> {
			if (!filenames.includes(relativePath)) return Promise.resolve(undefined);
			return Promise.resolve(readFileSync(join(docsDir, ...relativePath.split("/")), "utf-8"));
		},
	};
}

/** Index over the inlined payload, or over nothing when the payload is the empty placeholder. */
function embeddedDocsIndex(): PiDocsIndex {
	const decoded = decodePiDocsIndex(PI_DOCS_EMBED);
	if (decoded !== null) return decoded;
	return { filenames: [], getDoc: () => Promise.resolve(undefined) };
}

let index: PiDocsIndex | undefined;

/**
 * The active corpus index, resolved once per process. A reachable `docs/`
 * directory wins so that development edits take effect without regenerating the
 * inlined payload; the payload covers the single-file binary that ships none.
 */
export function getPiDocsIndex(): PiDocsIndex {
	if (index === undefined) {
		const docsDir = getDocsPath();
		const onDisk = listDocsOnDisk(docsDir);
		index = onDisk.length > 0 ? diskDocsIndex(docsDir, onDisk) : embeddedDocsIndex();
	}
	return index;
}

/** Sorted documentation file names, relative to `docs/`. Never inflates the inlined payload. */
export function listPiDocs(): readonly string[] {
	return getPiDocsIndex().filenames;
}

/** A documentation file's body, or `undefined` when the corpus has no such file. */
export function readPiDoc(relativePath: string): Promise<string | undefined> {
	return getPiDocsIndex().getDoc(relativePath);
}
