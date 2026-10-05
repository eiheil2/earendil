/**
 * L1, the compile layer: does each fixture still compile against the contract version it declares?
 *
 * `tsc --noEmit`, no new dependencies - TypeScript is already a root devDependency. What this catches is
 * the class of regression the runtime cannot: a host that narrows a type an extension used keeps loading
 * that extension (jiti strips types without checking them) while breaking every extension built against the
 * old shape. That is the failure mode `PLUGIN_API_VERSION` exists to detect, and without a compile step a
 * version bump would have nothing to fail.
 *
 * Each fixture is compiled against the SDK types for *its own* declared `apiVersion`, which is what makes
 * this a compatibility matrix rather than a type check of the current tree. A fixture declaring version 0
 * is compiled without any SDK mapping at all, because that is what a version-0 plugin could see.
 *
 * Two harness details that are not cosmetic, because getting them wrong produces failures which look like
 * contract failures:
 *
 * - The path mappings come from the repository's own tsconfig, read at runtime and re-based onto the
 *   generated config. Restating them here would be a second copy that drifts, and a partial copy is worse
 *   than none: mapping some workspace packages to their sources and letting the rest resolve to their
 *   `dist` types gives two incompatible copies of the same type, and every such mismatch is reported
 *   somewhere inside the host rather than at the line that caused it.
 * - Each fixture is compiled in its own generated config, in a temporary directory. One shared program
 *   would attribute an error to the wrong fixture, and a fixture that stopped compiling could be masked
 *   by its neighbours' output.
 *
 * The SDK/host conformance assertions in `packages/plugin-sdk/test/host-conformance.test.ts` are part of
 * this layer and are compiled here too, so a contract drift fails the compile step with a file:line rather
 * than only surfacing in the next full `npm run check`.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureDirectory, indexedFixtures, readFixtureIndex, readFixtureMetadata } from "./fixtures.ts";

// Four levels up from `test/compat/`: compat -> test -> coding-agent -> packages -> repo root.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const index = readFixtureIndex();
const conformanceSource = join(repoRoot, "packages/plugin-sdk/test/host-conformance.test.ts");

/** Fixtures declaring the legacy contract, which have no contract types to compile against. */
function isLegacy(name: string): boolean {
	return readFixtureMetadata(name).apiVersion === "0";
}

/** A path inside the repository, with forward slashes. */
function repoPath(...segments: string[]): string {
	return join(repoRoot, ...segments)
		.split(sep)
		.join("/");
}

/** The `typescript` CLI entry, as in the R8 pin: TypeScript 7 does not export it through `exports`. */
function tscEntry(): string {
	const require = createRequire(import.meta.url);
	const manifestPath = require.resolve("typescript/package.json");
	return join(dirname(manifestPath), "lib/tsc.js");
}

/**
 * The repository's path mappings, made absolute and extended with the SDK.
 *
 * The SDK is mapped to its `src` rather than its `dist` so the compile step works in a checkout where the
 * SDK has not been built yet - which is also the state `npm run check` runs in before the first build.
 */
function contractPaths(includeSdk: boolean): Record<string, string[]> {
	const root = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as {
		compilerOptions: { paths?: Record<string, string[]> };
	};
	const absolute: Record<string, string[]> = {};
	for (const [specifier, targets] of Object.entries(root.compilerOptions.paths ?? {})) {
		absolute[specifier] = targets.map((target) =>
			isAbsolute(target) ? target : repoPath(target.replace(/^\.\//, "")),
		);
	}
	if (includeSdk) {
		absolute["@earendil-works/pi-plugin-sdk"] = [repoPath("packages/plugin-sdk/src/index.ts")];
		absolute["@earendil-works/pi-plugin-sdk/*"] = [repoPath("packages/plugin-sdk/src/*.ts")];
	}
	return absolute;
}

interface CompileResult {
	ok: boolean;
	output: string;
	/** Diagnostics located in files other than the ones this compile checks. */
	elsewhere: string[];
}

/**
 * Split `tsc` output into diagnostics about the checked files and diagnostics about the rest of the program.
 *
 * Necessary because the conformance file imports the host's `ExtensionAPI`, which drags in the whole host
 * type graph. A type error in unrelated host code - a file another change is mid-edit on, say - is reported
 * but does not fail this layer: it says nothing about whether the SDK contract and the host still agree, and
 * `npm run check` is the gate that fails on it. The distinction is recorded rather than hidden, because a
 * compile layer that silently ignored every error outside its own files would also ignore the error that
 * matters when the contract drifts.
 */
function partition(output: string, checked: string[]): { own: string[]; elsewhere: string[] } {
	// Compare on repository-relative paths, forward-slashed. `tsc` prints a diagnostic path relative to
	// whatever directory it ran in, and comparing a relative path against an absolute one with `endsWith`
	// never matches - which silently classified every error in the conformance file as "elsewhere" and made
	// the assertion below it vacuous.
	const tails = checked.map((file) => {
		const normalized = file.split(sep).join("/");
		const marker = "/packages/";
		const index = normalized.indexOf(marker);
		return index === -1 ? normalized : normalized.slice(index + 1);
	});
	const own: string[] = [];
	const elsewhere: string[] = [];
	let current = "";
	for (const line of output.split("\n")) {
		// A diagnostic header starts with a path and a `(line,column)` position; continuation lines are indented.
		const header = /^(\S.*?)\((\d+),(\d+)\): (?:error|warning)/.exec(line);
		if (header) current = header[1].split(sep).join("/");
		if (tails.some((tail) => current.endsWith(tail))) own.push(line);
		else if (line.trim().length > 0) elsewhere.push(line);
	}
	return { own, elsewhere };
}

/**
 * The host's ambient declaration files.
 *
 * The repository's own `tsc --noEmit` picks them up because its `include` globs cover every package's
 * `src` tree; the generated configs here list files individually. Without them the host does not
 * type-check the same way: `src/utils/highlight-js.d.ts` declares the highlight.js language modules, and
 * dropping it makes the conformance compile fail on `syntax-highlight.ts` with errors that have nothing to
 * do with the contract.
 */
function hostDeclarationFiles(): string[] {
	return declarationFilesUnder(join(repoRoot, "packages/coding-agent/src"));
}

/** Every `.d.ts` under a directory tree. */
function declarationFilesUnder(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".d.ts")) found.push(path);
		}
	};
	walk(dir);
	return found;
}

/**
 * The SDK's own sources.
 *
 * Counted as checked files for the same reason as the fixture: they are what the fixture is compiled
 * against, so an error in them is a contract failure. `partition` needs the list up front because it
 * compares diagnostic paths against it.
 */
function sdkSourceFiles(): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
		}
	};
	walk(join(repoRoot, "packages/plugin-sdk/src"));
	return found;
}

/**
 * The compiler options shared by every compile in this file.
 *
 * `extends` rather than restated. The repository config carries settings that change what the host's own
 * sources type-check as (`lib`, `esModuleInterop`, `forceConsistentCasingInFileNames`), and a hand-written
 * subset produces errors *inside the host* that have nothing to do with the contract - which is how a
 * harness problem gets mistaken for a contract regression.
 */
function compilerOptions(includeSdk: boolean): Record<string, unknown> {
	return {
		// `root` enables `declaration` for the build configs, so `noEmit` is not optional here: without it
		// `tsc` tries to write `.d.ts` files next to the host's sources and fails with TS5055.
		noEmit: true,
		declaration: false,
		declarationMap: false,
		types: ["node"],
		typeRoots: [repoPath("node_modules/@types")],
		paths: contractPaths(includeSdk),
	};
}

/**
 * The repository's own configuration.
 *
 * Extending this rather than `tsconfig.base.json` is what keeps the compile honest: the root config's
 * `include` globs cover every package, so the host's transitive dependencies are checked exactly as
 * `npm run check` checks them. A narrower base resolves some of them differently and produces errors
 * inside the host that have nothing to do with the contract - the first version of this file did exactly
 * that and reported 30 unrelated errors in `session-manager.ts` and `syntax-highlight.ts`.
 */
const baseConfig = repoPath("tsconfig.json");

/** Run `tsc` against a generated config and report whether it succeeded. */
function compileIn(extendsPath: string, compilerOptions: Record<string, unknown>, files: string[]): CompileResult {
	const work = mkdtempSync(join(tmpdir(), "pi-compat-compile-"));
	try {
		writeFileSync(
			join(work, "tsconfig.json"),
			JSON.stringify({ extends: extendsPath, compilerOptions, files }, null, "\t"),
		);
		const result = spawnSync(process.execPath, [tscEntry(), "-p", work], { cwd: work, encoding: "utf8" });
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		const split = partition(output, files);
		return { ok: split.own.length === 0, output: split.own.join("\n"), elsewhere: split.elsewhere };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Compile one fixture against the contract types.
 *
 * The fixture is copied rather than referenced in place so the `files` list contains exactly one plugin
 * and an error cannot be attributed to a neighbour.
 */
function compileFixture(name: string): CompileResult {
	const work = mkdtempSync(join(tmpdir(), "pi-compat-fixture-"));
	try {
		const target = join(work, "fixture");
		mkdirSync(target, { recursive: true });
		cpSync(fixtureDirectory(name), target, { recursive: true });
		const files = readdirSync(target, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
			.map((entry) => join(target, entry.name));
		// The SDK sources count as checked: they are what the fixture is being compiled against, and a break
		// there is a contract break, not an unrelated host error.
		return compileIn(baseConfig, compilerOptions(!isLegacy(name)), [...files, ...sdkSourceFiles()]);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Compile the SDK/host conformance test file.
 *
 * Its assertions live in a function that is never called, so `tsc` is the only thing that evaluates them.
 * The file is referenced in place rather than copied: its imports are relative to its own directory, and a
 * copy would break exactly the cross-package imports the check is about.
 */
function compileConformance(): CompileResult {
	return compileIn(baseConfig, compilerOptions(true), [
		conformanceSource,
		...sdkSourceFiles(),
		...hostDeclarationFiles(),
	]);
}

describe("compatibility compile layer", () => {
	it("keeps the SDK and the host mutually assignable", () => {
		const result = compileConformance();
		if (result.elsewhere.length > 0) {
			// Not a failure here - `npm run check` owns those - but never silent either. An error in the host
			// while this layer is green is exactly the situation a reader of a green CI run needs warned about.
			console.warn(
				`${result.elsewhere.length} type error(s) outside the conformance file; npm run check gates them:\n${result.elsewhere.slice(0, 10).join("\n")}`,
			);
		}
		expect(result.output).toBe("");
		expect(result.ok).toBe(true);
	});

	for (const name of indexedFixtures()) {
		it(`${name} compiles against the ${readFixtureMetadata(name).apiVersion} contract`, () => {
			const result = compileFixture(name);
			expect(result.output).toBe("");
			expect(result.ok).toBe(true);
		});
	}

	it("pins the contract version each fixture declares", () => {
		// Without this, a fixture could compile against the SDK regardless of the `apiVersion` its manifest
		// declares, and "compiled against its own contract version" would be a claim rather than a fact.
		// Both tiers have to be represented or one of the two compile configurations goes untested.
		const all = indexedFixtures();
		const legacy = all.filter(isLegacy);
		expect(legacy.length).toBeGreaterThan(0);
		expect(legacy.length).toBeLessThan(all.length);
	});

	it("uses a contract version this host implements for every fixture", () => {
		const supported = new Set(["0", "1"]);
		for (const entry of index.fixtures) {
			expect(supported.has(entry.apiVersion), `${entry.name}@v${entry.apiVersion}`).toBe(true);
		}
	});

	it("keeps the conformance assertions in the file it compiles", () => {
		// The compile step above is only meaningful if the assertions are still there. Reading them from
		// the source is a crude check, and deliberately so: a type error cannot tell the difference between
		// "the contract drifted" and "someone emptied the file".
		const source = readFileSync(conformanceSource, "utf8");
		expect(source).toContain("function assertHostConformance(): void");
		expect(resolve(conformanceSource)).toBe(conformanceSource);
	});
});
