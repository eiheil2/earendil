/**
 * Resolver for the stable `pi://` documentation protocol.
 *
 * - `pi://docs/` (and its `pi://`, `pi:///`, `pi://docs` spellings) lists the
 *   corpus as Markdown links; the listing reads file names only and never
 *   inflates the inlined payload.
 * - `pi://docs/<file>.md` returns that doc's Markdown.
 *
 * Errors are written for the caller that has to act on them: an unknown doc gets
 * near-miss suggestions, an empty build names both stores that were searched.
 */
import { getDocsPath } from "../config.ts";
import { listPiDocs, readPiDoc } from "./docs-index.ts";
import { PI_DOCS_PREFIX, PI_DOCS_ROOT, piDocsScopeEntries, piDocsUrl, piDocsUrlRelativePath } from "./docs-scope.ts";

export interface PiDocsUrlContent {
	/** The requested URL, canonicalized. */
	url: string;
	/** The doc body, or the corpus listing when the URL names the docs root. */
	content: string;
}

/** Canonical `pi://docs/<file>.md` URLs for every doc, for completion and prompts. */
export function piDocsCompletion(): string[] {
	return listPiDocs().map(piDocsUrl);
}

function missingCorpusError(): Error {
	return new Error(
		`No pi documentation is reachable from this build. Looked for docs/ under ${getDocsPath()} and for the inlined ${PI_DOCS_ROOT}/ corpus.`,
	);
}

function listingMarkdown(filenames: readonly string[]): string {
	const links = filenames.map((filename) => `- [${filename}](${piDocsUrl(filename)})`).join("\n");
	return `# Pi documentation\n\n${filenames.length} files available:\n\n${links}\n`;
}

/** Nearest corpus file names for a doc this build does not have. */
function suggestionsFor(relativePath: string): string[] {
	const stem = relativePath.replace(/\.md$/, "");
	return listPiDocs()
		.filter((filename) => filename.includes(stem) || stem.includes(filename.replace(/\.md$/, "")))
		.slice(0, 5);
}

async function docsListing(): Promise<string> {
	const filenames = listPiDocs();
	if (filenames.length === 0) throw missingCorpusError();
	return listingMarkdown(filenames);
}

/**
 * Resolve a `pi://` documentation URL. The URL must carry the scheme: a bare
 * `docs/quickstart.md` is a filesystem path question, not a protocol one, and
 * answering it here would hide the difference between the two.
 */
export async function resolvePiDocsUrl(href: string): Promise<PiDocsUrlContent> {
	if (!href.startsWith(PI_DOCS_PREFIX)) {
		throw new Error(`Documentation URLs must start with ${PI_DOCS_PREFIX}, got: ${href}`);
	}
	const url = new URL(href);
	const relativePath = piDocsUrlRelativePath(url);
	if (relativePath === "") return { url: `${PI_DOCS_ROOT}/`, content: await docsListing() };

	const content = await readPiDoc(relativePath);
	if (content === undefined) {
		const suggestions = suggestionsFor(relativePath);
		const suffix =
			suggestions.length > 0
				? `\nDid you mean: ${suggestions.map(piDocsUrl).join(", ")}`
				: `\nList the available docs with ${PI_DOCS_ROOT}/.`;
		throw new Error(`Documentation file not found: ${piDocsUrl(relativePath)}${suffix}`);
	}
	return { url: piDocsUrl(relativePath), content };
}

/** Every doc in the corpus with its canonical URL, for hosts that expand the docs root. */
export async function resolvePiDocsScope(): Promise<Array<{ url: string; content: string }>> {
	const entries = await piDocsScopeEntries();
	if (entries.length === 0) throw missingCorpusError();
	return entries;
}
