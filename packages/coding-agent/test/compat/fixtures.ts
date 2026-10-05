/**
 * The compatibility fixture set: what the matrix loads, and the shape of a fixture's manifest.
 *
 * Two things are recorded per fixture and neither is derivable from the fixture itself.
 *
 * `sha256` exists because the matrix asserts that these files never change. Without a content hash,
 * editing a fixture is indistinguishable from fixing a plugin, and anyone can make the matrix green by
 * editing what it measures. The hash is what turns "the fixture changed" into a reviewable line in the
 * diff. It covers every file in the directory *except* `fixture.json`, which cannot cover itself.
 *
 * `expectWarnings` exists because a warning-free load is the normal state and a warning is a fact about
 * the host, not about the fixture. Pinning "this fixture warns" is what keeps the `minHostVersion` warning
 * from being deleted along with the code that produces it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Kimi's four layers, from `plan-plugin-contract.md` section 1.1.4. pi has the first three natively. */
export const FIXTURE_LAYERS = ["skills", "hooks", "mcp", "plugins"] as const;

export type FixtureLayer = (typeof FIXTURE_LAYERS)[number];

/**
 * `synthetic` or `release:<git-sha>`.
 *
 * Every fixture in this set is `synthetic`, and that is a statement about the state of the ecosystem
 * rather than a shortcut: when version 1 of the contract shipped, no version-1 plugin existed to copy, so
 * a synthetic fixture can only prove that the contract shape we designed is self-consistent. It cannot
 * prove that a real plugin survives. The first release snapshot replaces the first synthetic fixture, and
 * each minor release adds another.
 */
export type FixtureSource = "synthetic" | `release:${string}`;

export interface FixtureMetadata {
	apiVersion: string;
	hostVersionAtCreation: string;
	createdAt: string;
	layer: number;
	source: FixtureSource;
	sha256: string;
	note: string;
}

export interface FixtureIndexEntry {
	name: string;
	apiVersion: string;
	layer: number;
	expectWarnings: string[];
	note: string;
}

export interface FixtureIndex {
	pluginApiVersion: string;
	fixtures: FixtureIndexEntry[];
}

export const fixturesRoot = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));
export const compatRoot = fileURLToPath(new URL(".", import.meta.url));

export function fixtureDirectory(name: string): string {
	return join(fixturesRoot, name);
}

/** `events-only@v1` -> `events-only`, for display and for selecting a fixture without its version. */
export function fixtureBaseName(name: string): string {
	return name.replace(/@v\d+$/, "");
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/**
 * The content hash of a fixture directory.
 *
 * Sorted relative paths with POSIX separators, then each file's own hash. Two details make it
 * reproducible across machines: separators are normalized (Windows would otherwise hash a different
 * string), and the file list is sorted rather than in directory order. `fixture.json` is excluded because
 * it carries the hash.
 */
export function fixtureDigest(name: string): string {
	const directory = fixtureDirectory(name);
	const hash = createHash("sha256");
	for (const file of collectFiles(directory)) {
		hash.update(toPosix(relative(directory, file)));
		hash.update("\0");
		hash.update(createHash("sha256").update(readFileSync(file)).digest("hex"));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function collectFiles(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...collectFiles(path));
		else if (entry.isFile() && entry.name !== "fixture.json") found.push(path);
	}
	return found.sort();
}

export function readFixtureIndex(): FixtureIndex {
	return JSON.parse(readFileSync(join(compatRoot, "manifest.json"), "utf8")) as FixtureIndex;
}

export function readFixtureMetadata(name: string): FixtureMetadata {
	return JSON.parse(readFileSync(join(fixtureDirectory(name), "fixture.json"), "utf8")) as FixtureMetadata;
}

/** The manifest of a fixture, as the host reads it: the `pi` block, or nothing for a legacy fixture. */
export function readFixtureManifest(name: string): Record<string, unknown> | undefined {
	const manifestPath = join(fixtureDirectory(name), "package.json");
	if (!existsSync(manifestPath)) return undefined;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pi?: Record<string, unknown> };
	return manifest.pi;
}

/** The extension file a fixture declares in its manifest, resolved to an absolute path. */
export function fixtureEntry(name: string): string {
	const pi = readFixtureManifest(name);
	const declared = pi?.extensions;
	if (!Array.isArray(declared) || declared.length === 0 || typeof declared[0] !== "string") {
		throw new Error(`Fixture ${name} declares no pi.extensions entry`);
	}
	return resolve(fixtureDirectory(name), declared[0]);
}

export function fixtureSourceDirectory(name: string): string {
	return dirname(fixtureEntry(name));
}

/** Every fixture the index lists, in index order. The index is the authority on what the matrix runs. */
export function indexedFixtures(): string[] {
	return readFixtureIndex().fixtures.map((entry) => `${entry.name}@v${entry.apiVersion}`);
}
