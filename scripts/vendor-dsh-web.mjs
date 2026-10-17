import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { posix } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const repository = "deepseek-ai/deepseek-harness";
const revision = "1517a4dbca0a2789ff1d41ba439600f8547d23fa";
const destination = new URL("../vendor/deepseek-web/", import.meta.url);
const files = [
	"LICENSE",
	"packages/client/ui-layout/src/client/AppFrame.tsx",
	"packages/client/ui-layout/src/client/AppFrame.module.css",
	"packages/client/ui-layout/src/client/columns.ts",
	"packages/client/ui-layout/src/client/DocumentTitle.tsx",
	"packages/client/ui-theme/src/styles/base.css",
	"packages/client/ui-theme/src/styles/design-platform.css",
	"packages/client/ui-theme/src/styles/focus.css",
	"packages/client/ui-theme/src/styles/scrollbar.css",
	"packages/client/ui-sidebar/src/client/SidebarRoot.tsx",
	"packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx",
	"packages/client/ui-chat/src/client/chat/UserContent.tsx",
];

const primitives = "packages/client/ui-primitives/src/";
const primitiveEntries = ["FishLogo.tsx", "Tooltip.tsx", "ShortcutKeys.tsx", "darwin-desktop.ts", "icons/index.tsx", "FileTypeIcon.tsx", "file-size.ts", "user-text.tsx", "markdown/JsonBlock.tsx"];
const roots = [...files, ...primitiveEntries.map(path => primitives + path), primitives + "markdown/MarkdownText.tsx", "packages/util/workspace-path/src/index.ts", "packages/util/code-language/src/index.ts"];

const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) throw new Error("Unknown argument");
const manifestUrl = new URL("manifest.json", destination);

if (check) {
	const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
	if (manifest.repository !== repository || manifest.revision !== revision) throw new Error("DSH source revision mismatch");
	if (roots.some(path => !(path in manifest.files))) {
		throw new Error("DSH source file list mismatch");
	}
	for (const path of Object.keys(manifest.files)) {
		const content = await readFile(new URL(path, destination));
		if (createHash("sha256").update(content).digest("hex") !== manifest.files[path]) {
			throw new Error(`Modified DSH source: ${path}`);
		}
	}
	console.log(`DSH Web source verified (${Object.keys(manifest.files).length} files, ${revision}).`);
} else {
	// Fetch the complete selection before writing any files. Source snapshots remain immutable.
	const visited = new Set();
	const sources = [];
	const cache = pathToFileURL(`${tmpdir().replaceAll("\\", "/")}/opencode/dsh-web-${revision}/`);
	async function collect(path) {
		if (visited.has(path)) return;
		visited.add(path);
		let content;
		try { content = await readFile(new URL(path, cache)); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		for (let attempt = 0; content === undefined && attempt < 4; attempt++) {
			try {
				const response = await fetch(`https://raw.githubusercontent.com/${repository}/${revision}/${path}`, { signal: AbortSignal.timeout(20_000) });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				content = Buffer.from(await response.arrayBuffer());
				await mkdir(new URL(".", new URL(path, cache)), { recursive: true });
				await writeFile(new URL(path, cache), content);
			} catch (error) { if (attempt === 3) throw new Error(`DSH download failed: ${path}`, { cause: error }); }
		}
		sources.push({ path, content });
		let text = content.toString("utf8");
		if (/\.tsx?$/.test(path)) text = (await transform(text, { loader: path.endsWith("tsx") ? "tsx" : "ts", jsx: "automatic" })).code;
		const imports = [...text.matchAll(/(?:from\s*|import\s*|@import\s*)["'](\.[^"']+)["']/g)].map(match => posix.normalize(posix.join(posix.dirname(path), match[1])));
		for (const dependency of imports) await collect(dependency);
	}
	for (const root of roots) await collect(root);
	sources.sort((left, right) => left.path.localeCompare(right.path));
	for (const { path, content } of sources) {
		try {
			const existing = await readFile(new URL(path, destination));
			if (!existing.equals(content)) throw new Error(`Refusing to overwrite DSH source: ${path}`);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	for (const { path, content } of sources) {
		const target = new URL(path, destination);
		await mkdir(new URL(".", target), { recursive: true });
		await writeFile(target, content);
	}
	await writeFile(manifestUrl, `${JSON.stringify({
		repository,
		revision,
		files: Object.fromEntries(sources.map(({ path, content }) => [path, createHash("sha256").update(content).digest("hex")])),
	}, null, 2)}\n`);
	console.log(`Imported DSH Web source into ${fileURLToPath(destination)}.`);
}
