#!/usr/bin/env node
/**
 * Build the compressed `pi://` docs corpus that ships inside the pi binary.
 *
 * The whole `docs/` Markdown tree is serialized as a JSON array of bodies and
 * gzipped; the runtime (`src/core/docs-index.ts`) inflates it lazily, once, on
 * the first doc read. The generated TypeScript module is committed so the
 * esbuild bundle and the compiled binary pick the constant up from the module
 * graph instead of a sidecar file, and so `verify-doc-embed --check` can prove
 * the committed payload still matches `docs/`.
 *
 * Usage:
 *   node scripts/generate-docs-index.mjs           # write src/core/docs-embed.generated.ts
 *   node scripts/generate-docs-index.mjs --check   # fail when the committed payload is stale
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(packageDir, "docs");
const embedModulePath = join(packageDir, "src", "core", "docs-embed.generated.ts");

/** Blob chunks stay well under the 120-column formatter limit so the generated module stays diffable. */
const BLOB_CHUNK_SIZE = 96;

/** Sorted documentation file names relative to `docs/`, `/`-separated. */
export function collectDocFiles(root = docsDir) {
	const files = [];
	const walk = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".md")) files.push(relative(root, full).split(sep).join("/"));
		}
	};
	walk(root);
	return files.sort();
}

/**
 * The compressed corpus: sorted file names plus index-aligned Markdown bodies.
 * `blob` is base64 gzip; `payload` is the two-line wire form the runtime parses.
 */
export function buildDocsIndexPayload(root = docsDir) {
	const files = collectDocFiles(root);
	const bodies = files.map(file => readFileSync(join(root, file), "utf8"));
	const blob = gzipSync(Buffer.from(JSON.stringify(bodies), "utf8"), { level: 9 }).toString("base64");
	return { files, bodies, blob, payload: `${JSON.stringify(files)}\n${blob}` };
}

/** Quote a value as a double-quoted TypeScript string literal (base64 and JSON names need no escaping). */
function tsString(value) {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Render the generated module that carries the payload in the module graph. */
export function renderEmbedModule({ files, blob }) {
	const names = files.map(file => `\t${tsString(file)},`).join("\n");
	const chunks = [];
	for (let offset = 0; offset < blob.length; offset += BLOB_CHUNK_SIZE) {
		chunks.push(`\t${tsString(blob.slice(offset, offset + BLOB_CHUNK_SIZE))}`);
	}
	return `/**
 * GENERATED FILE - do not edit. Run \`npm run gen:docs-index\` (packages/coding-agent).
 *
 * The whole \`docs/\` corpus, gzipped, so a self-contained pi build can still read
 * its own documentation through \`pi://docs/<file>.md\`. \`DOC_FILENAMES\` is the
 * sorted listing, \`DOC_BODY_BLOB\` is base64 gzip of the index-aligned bodies.
 * \`verify-doc-embed --check\` fails when this payload drifts from \`docs/\`.
 */

const DOC_FILENAMES = [
${names}
];

const DOC_BODY_BLOB = [
${chunks.join(",\n")},
].join("");

export const PI_DOCS_EMBED = \`\${JSON.stringify(DOC_FILENAMES)}\\n\${DOC_BODY_BLOB}\`;
`;
}

const check = process.argv.includes("--check");
const payload = buildDocsIndexPayload();
const rendered = renderEmbedModule(payload);

if (check) {
	let committed;
	try {
		committed = readFileSync(embedModulePath, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		console.error(`${embedModulePath} is missing. Run: npm run gen:docs-index`);
		process.exit(1);
	}
	if (committed !== rendered) {
		console.error(
			`${relative(packageDir, embedModulePath)} is stale (${payload.files.length} docs, ${payload.blob.length} base64 chars on disk vs ${committed.length} bytes committed). Run: npm run gen:docs-index`,
		);
		process.exit(1);
	}
	console.log(`gen:docs-index: ${payload.files.length} docs embedded, up to date.`);
} else {
	writeFileSync(embedModulePath, rendered);
	console.log(
		`gen:docs-index: wrote ${relative(packageDir, embedModulePath)} (${payload.files.length} docs, ${payload.blob.length} base64 chars).`,
	);
}