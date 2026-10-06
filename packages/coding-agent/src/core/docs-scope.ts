/**
 * Grammar for the `pi://` documentation URLs: which doc a URL names, and the
 * whole corpus for the docs root.
 *
 * `pi://` is the scheme rather than omp's `omp://` because the protocol belongs to
 * pi itself: the CLI binary is `pi`, the config directory is `.pi`, the agent
 * directory is `~/.pi/agent`, and `pi` is not a registered URI scheme. The URL
 * grammar is otherwise the one omp proved out, including `pi://<file>.md` as the
 * host-as-filename shorthand next to the canonical `pi://docs/<file>.md`.
 *
 * Canonical form is `pi://docs/<file>.md`; `pi://`, `pi:///`, `pi://docs`, and
 * `pi://docs/` all name the docs root, which expands to the whole corpus.
 *
 * URLs are parsed with the WHATWG parser, which ASCII-lowercases a host, so doc
 * file names - all lowercase by convention - round-trip unchanged.
 */
import { listPiDocs, readPiDoc } from "./docs-index.ts";

/** The URL scheme that owns pi's documentation. */
export const PI_DOCS_SCHEME = "pi";

/** Every documentation URL starts with this. */
export const PI_DOCS_PREFIX = `${PI_DOCS_SCHEME}://`;

/** Canonical docs root prefix: `pi://docs/<file>.md`. */
export const PI_DOCS_ROOT = `${PI_DOCS_PREFIX}docs`;

/**
 * Host + path of a `pi://` URL exactly as written, or `""` when the URL names the
 * docs root. Throws on undecodable percent-encoding, because a path that cannot be
 * decoded can never name a real doc file.
 */
function piDocsUrlTarget(url: URL): string {
	let pathname = "";
	try {
		pathname = url.pathname === "/" ? "" : decodeURIComponent(url.pathname);
	} catch {
		throw new Error(`Malformed percent-encoding in ${PI_DOCS_ROOT}/ URL: ${url.pathname}`);
	}
	return pathname ? `${url.host}${pathname}` : url.host;
}

/**
 * Canonical doc path relative to `docs/` for a `pi://` URL, or `""` for the docs
 * root. Throws on absolute paths and on `..` traversal - the two rejections the
 * protocol reports - so a URL can never reach outside the corpus.
 */
export function piDocsUrlRelativePath(url: URL): string {
	const target = piDocsUrlTarget(url);
	if (target === "" || target === "docs" || target === "docs/") return "";
	if (target.startsWith("/") || /^[a-z]:/i.test(target)) {
		throw new Error(`Absolute paths are not allowed in ${PI_DOCS_ROOT}/ URLs`);
	}
	const parts = target.replaceAll("\\", "/").split("/");
	if (parts.includes("..")) {
		throw new Error(`Path traversal (..) is not allowed in ${PI_DOCS_ROOT}/ URLs`);
	}
	const path = parts.filter((part) => part && part !== ".").join("/");
	if (path === "docs" || path === "") return "";
	return path.startsWith("docs/") ? path.slice("docs/".length) : path;
}

/** The canonical `pi://docs/<file>.md` URL for a doc path relative to `docs/`. */
export function piDocsUrl(relativePath: string): string {
	return `${PI_DOCS_ROOT}/${relativePath}`;
}

/**
 * Every doc of the corpus with its canonical URL and body, in index (sorted) order.
 * Empty when no corpus is reachable; this is what the docs root expands to.
 */
export async function piDocsScopeEntries(): Promise<Array<{ url: string; content: string }>> {
	const entries: Array<{ url: string; content: string }> = [];
	for (const relativePath of listPiDocs()) {
		const content = await readPiDoc(relativePath);
		if (content === undefined) continue;
		entries.push({ url: piDocsUrl(relativePath), content });
	}
	return entries;
}
