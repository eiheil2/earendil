import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PI_DOCS_EMBED } from "../src/core/docs-embed.generated.ts";
import { decodePiDocsIndex, listPiDocs, readPiDoc } from "../src/core/docs-index.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { piDocsCompletion, resolvePiDocsScope, resolvePiDocsUrl } from "../src/core/pi-protocol.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const docsRoot = resolve(import.meta.dirname, "../docs");

function docsOnDisk(): string[] {
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return walk(full);
			return entry.isFile() && entry.name.endsWith(".md") ? [relative(docsRoot, full).split(sep).join("/")] : [];
		});
	return walk(docsRoot).sort();
}

function embed(files: readonly string[], bodies: readonly string[]): string {
	const blob = Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies), "utf8"), { level: 9 })).toString("base64");
	return `${JSON.stringify(files)}\n${blob}`;
}

// The embed store only runs in a self-contained build, where these tests would
// otherwise silently exercise the on-disk corpus and ship a broken inline payload
// undetected. These cover the two-line payload contract directly.
describe("inline pi:// docs payload", () => {
	it("lists file names from a corrupt blob, and only reports the corruption on a body read", async () => {
		const index = decodePiDocsIndex('["a.md","b.md"]\n@@@not-a-gzip-blob@@@');
		expect(index?.filenames).toEqual(["a.md", "b.md"]);
		await expect(index?.getDoc("a.md")).rejects.toThrow();
	});

	it("resolves index-aligned bodies and reports an unknown doc as absent", async () => {
		const index = decodePiDocsIndex(embed(["a.md", "nested/b.md"], ["a body", "b body"]));
		await expect(index?.getDoc("a.md")).resolves.toBe("a body");
		await expect(index?.getDoc("nested/b.md")).resolves.toBe("b body");
		await expect(index?.getDoc("missing.md")).resolves.toBeUndefined();
	});

	it("rejects an empty payload so the caller falls through to the next store", () => {
		expect(decodePiDocsIndex("")).toBeNull();
	});

	it("inflates the committed payload to exactly the docs/ tree, byte for byte", async () => {
		// The committed payload is the only docs corpus a single-file binary has, so
		// a stale or truncated blob would ship a binary whose own docs are wrong.
		const onDisk = docsOnDisk();
		expect(onDisk.length).toBeGreaterThan(0);
		const index = decodePiDocsIndex(PI_DOCS_EMBED);
		expect(index?.filenames).toEqual(onDisk);
		for (const filename of onDisk) {
			expect(await index?.getDoc(filename)).toBe(readFileSync(join(docsRoot, ...filename.split("/")), "utf-8"));
		}
	});
});

describe("pi:// documentation protocol", () => {
	it("serves pi:// through the production read tool", async () => {
		const tool = createReadToolDefinition(process.cwd());
		const result = await tool.execute(
			"test",
			{ path: "pi://docs/configuration.md" },
			undefined,
			undefined,
			undefined as unknown as ExtensionToolContext,
		);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("Configuration");
	});
	it("serves a source-mode read through the index, byte-identical to docs/ on disk", async () => {
		const resolved = await resolvePiDocsUrl("pi://docs/configuration.md");
		expect(resolved.url).toBe("pi://docs/configuration.md");
		expect(resolved.content).toBe(readFileSync(join(docsRoot, "configuration.md"), "utf-8"));
	});

	it("treats the four root spellings as the corpus listing without inflating anything", async () => {
		const listings = await Promise.all([
			resolvePiDocsUrl("pi://"),
			resolvePiDocsUrl("pi:///"),
			resolvePiDocsUrl("pi://docs"),
			resolvePiDocsUrl("pi://docs/"),
		]);
		for (const listing of listings) {
			expect(listing.url).toBe("pi://docs/");
			expect(listing.content).toContain(`${listPiDocs().length} files available:`);
			expect(listing.content).toContain("- [configuration.md](pi://docs/configuration.md)");
		}
	});

	it("accepts the host-as-filename shorthand and canonicalizes it", async () => {
		const shorthand = await resolvePiDocsUrl("pi://configuration.md");
		expect(shorthand.url).toBe("pi://docs/configuration.md");
		expect(shorthand.content).toBe(await readPiDoc("configuration.md"));
	});

	it("refuses a traversal that survives URL normalization", async () => {
		// `%2f` is not a path separator to the URL parser, so it only becomes one
		// after decoding - the point where a `..` could still escape the corpus.
		await expect(resolvePiDocsUrl("pi://docs/a/..%2fconfiguration.md")).rejects.toThrow(
			"Path traversal (..) is not allowed",
		);
		await expect(resolvePiDocsUrl("pi://docs/%ZZ")).rejects.toThrow(
			"Malformed percent-encoding in pi://docs/ URL: /%ZZ",
		);
	});

	it("cannot read outside the corpus through a normalized `..`", async () => {
		// The URL parser resolves `docs/..` to the corpus root, so this names a doc
		// inside docs/ - it must not reach the parent directory's settings.json.
		await expect(resolvePiDocsUrl("pi://docs/../settings.json")).rejects.toThrow(
			"Documentation file not found: pi://docs/settings.json",
		);
	});

	it("requires the scheme, so a bare path is not answered as a URL", async () => {
		await expect(resolvePiDocsUrl("docs/configuration.md")).rejects.toThrow(
			"Documentation URLs must start with pi://",
		);
	});

	it("suggests the real file when the URL drops the extension", async () => {
		await expect(resolvePiDocsUrl("pi://docs/configuration")).rejects.toThrow(
			/^Documentation file not found: pi:\/\/docs\/configuration\nDid you mean: pi:\/\/docs\/configuration\.md/,
		);
	});

	it("expands the docs root to every doc, and completes to canonical URLs", async () => {
		const onDisk = docsOnDisk();
		const entries = await resolvePiDocsScope();
		expect(entries.length).toBe(onDisk.length);
		expect(entries[0]?.url).toBe(`pi://docs/${onDisk[0]}`);
		expect(entries[0]?.content).toBe(readFileSync(join(docsRoot, ...(onDisk[0] ?? "").split("/")), "utf-8"));
		expect(piDocsCompletion()).toEqual(entries.map((entry) => entry.url));
		expect(await readPiDoc("no-such-doc.md")).toBeUndefined();
	});
});
