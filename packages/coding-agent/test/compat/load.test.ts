/**
 * The compatibility matrix: every fixture, loaded three ways, against the committed surface baseline.
 *
 * What is covered and why:
 *
 * - Three entry points, because they are three different code paths. `discoverAndLoadExtensions` finds
 *   plugins by convention (`.pi/extensions/`, `agentDir/extensions/`, configured paths),
 *   `loadExtensions` takes explicit paths, and `loadExtensionFromFactory` takes a factory function - the
 *   path inline extensions and built-ins take. A fixture that only ever loads through one of them proves
 *   less than it appears to.
 * - Two resolution modes. A TypeScript source runtime resolves imports through virtual modules and the
 *   root tsconfig paths; an unbundled Node build resolves them through the dist alias table. A plugin can
 *   work in one and fail in the other, and that failure is invisible to whichever mode is not exercised.
 *   The third mode - a bundled or SEA binary using embedded modules - cannot run in-process from a test,
 *   and is covered by the binary build job instead.
 * - Errors empty, warnings as recorded, surface equal to the baseline.
 *
 * Isolation between fixtures: each one is installed into its own temporary directory, and the loader's
 * extension cache is keyed by `{cwd, generation}`, so a different directory means a different cache
 * entry. Changing a fixture file therefore requires a new directory to take effect - the cache would
 * otherwise hand back the previously parsed factory and the test would silently keep testing the old code.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import {
	clearExtensionCache,
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "../../src/core/extensions/loader.ts";
import type { ExtensionFactory, LoadExtensionsResult } from "../../src/core/extensions/types.ts";
import { fixtureDirectory, readFixtureIndex } from "./fixtures.ts";
import { readBaseline, recordRuntimeSurface, recordSurface } from "./surface.ts";

const MODES = ["discover", "explicit", "factory"] as const;
type Mode = (typeof MODES)[number];

const index = readFixtureIndex();
const baseline = readBaseline();

/**
 * The fixture and entry point this run covers, from the environment; both empty means all of them.
 *
 * This is how the CI matrix gets one job per fixture without the test needing to know about matrices:
 * `PI_COMPAT_FIXTURE` and `PI_COMPAT_MODE` narrow the run, and the same command with no environment runs
 * everything locally. Narrowing is applied as a filter over the fixture list rather than as a separate code
 * path, so a local run and a matrix run execute the same assertions.
 */
const selectedFixture = process.env.PI_COMPAT_FIXTURE;
const selectedMode = process.env.PI_COMPAT_MODE as Mode | undefined;

function fixtureCases(): string[] {
	const all = index.fixtures.map((entry) => `${entry.name}@v${entry.apiVersion}`);
	if (!selectedFixture) return all;
	if (!all.includes(selectedFixture)) {
		throw new Error(`PI_COMPAT_FIXTURE=${selectedFixture} is not in the fixture index`);
	}
	return [selectedFixture];
}

function modeCases(): Mode[] {
	if (!selectedMode) return [...MODES];
	if (!(MODES as readonly string[]).includes(selectedMode)) {
		throw new Error(`PI_COMPAT_MODE=${selectedMode} is not one of ${MODES.join(", ")}`);
	}
	return [selectedMode];
}

describe("compatibility matrix", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "pi-compat-"));
		clearExtensionCache();
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/**
	 * Install a fixture into the temporary directory as the package it would be published as.
	 *
	 * Copying rather than loading in place matters: `findExtensionManifest` resolves the contract
	 * envelope from the extension file's own manifest, so a fixture only exercises the contract when the
	 * host sees it as an installed package with that manifest. The copy is what makes that true with no
	 * special casing in the test.
	 */
	function install(name: string): string {
		const target = join(workDir, "plugins", name);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(fixtureDirectory(name), target, { recursive: true });
		return target;
	}

	it("loads every fixture with the surface the baseline records", async () => {
		for (const name of fixtureCases()) {
			const entry = index.fixtures.find((candidate) => `${candidate.name}@v${candidate.apiVersion}` === name);
			if (!entry) throw new Error(`${name} is not in the fixture index`);
			const recorded = baseline.fixtures.find((fixture) => fixture.name === name);
			expect(recorded, `${name} is missing from baseline.json`).toBeDefined();

			const target = install(name);
			const result = await loadFixture(target, "discover");

			expect(
				result.errors.map((error) => error.error),
				`${name} load errors`,
			).toEqual([]);
			const warnings = warningsOf(result);
			expect(warnings.length, `${name} warning count`).toBe(entry.expectWarnings.length);
			for (const warning of warnings) {
				expect(
					entry.expectWarnings.some((fragment) => warning.warning.includes(fragment)),
					`${name} produced an unexpected warning: ${warning.warning}`,
				).toBe(true);
			}
			expect(
				result.extensions.map((extension) => recordSurface(extension, target)),
				`${name} surface`,
			).toEqual(recorded?.surface);
		}
	});

	it("loads every fixture through every entry point", async () => {
		for (const name of fixtureCases()) {
			for (const mode of modeCases()) {
				const target = install(name);
				const result = await loadFixture(target, mode);
				expect(
					result.errors.map((error) => error.error),
					`${name} via ${mode}`,
				).toEqual([]);
				expect(result.extensions, `${name} via ${mode}`).toHaveLength(1);
			}
		}
	});

	it("registers something in every fixture", async () => {
		// A fixture that loads and registers nothing would satisfy every assertion above, including the
		// baseline comparison, without proving the loader gave the plugin an API at all. Runtime
		// registrations count here because providers and MCP servers never touch the extension object.
		for (const name of fixtureCases()) {
			const target = install(name);
			const result = await loadFixture(target, modeCases()[0] ?? "discover");
			const surface = recordSurface(result.extensions[0], target);
			const runtime = recordRuntimeSurface(result.runtime);
			const registrations =
				surface.handlers.length +
				surface.tools.length +
				surface.commands.length +
				surface.flags.length +
				surface.shortcuts.length +
				surface.messageRenderers.length +
				surface.entryRenderers.length +
				surface.renderers.length +
				runtime.providers.length +
				runtime.virtualModels.length +
				runtime.mcpServers.length;
			expect(registrations, `${name} registered nothing`).toBeGreaterThan(0);
		}
	});

	it("records what each fixture registered with the host as well as on the extension", async () => {
		// Providers, virtual models and MCP servers are applied by the atomic commit rather than onto the
		// extension object, so a snapshot of the extension alone would report a plugin that registers an
		// MCP server as registering nothing.
		for (const name of fixtureCases()) {
			const recorded = baseline.fixtures.find((fixture) => fixture.name === name);
			const runtime = recordRuntimeSurface((await loadFixture(install(name), "discover")).runtime);
			expect(runtime.providers, `${name} providers`).toEqual(recorded?.providers);
			expect(runtime.virtualModels, `${name} virtual models`).toEqual(recorded?.virtualModels);
			expect(runtime.mcpServers, `${name} mcp servers`).toEqual(recorded?.mcpServers);
		}
	});

	it("rejects a fixture whose declared api version this host does not implement", async () => {
		// The negative case of the same mechanism, so the matrix cannot pass by never evaluating the
		// envelope. Without it, a fixture set that stopped loading at all would look like one that loads.
		//
		// `extensions` is kept in the rewritten `pi` block deliberately: `findExtensionManifest` only
		// attributes a contract envelope to a file its own manifest declares, so dropping it would fall
		// back to the legacy tier and the assertion would pass for the wrong reason.
		const target = install("tool-register@v1");
		const manifestPath = join(target, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pi: Record<string, unknown> };
		writeFileSync(manifestPath, JSON.stringify({ ...manifest, pi: { ...manifest.pi, apiVersion: "999" } }));
		clearExtensionCache();

		const result = await loadFixture(target, "discover");
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain('requires extension API version "999"');
		expect(result.extensions).toHaveLength(0);
	});

	it("rejects a fixture that declares a capability it does not use, under strict capabilities", async () => {
		// The E0 half of the capability check, which the default mode never reaches.
		const target = install("events-only@v1");
		const manifestPath = join(target, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pi: Record<string, unknown> };
		writeFileSync(
			manifestPath,
			JSON.stringify({ ...manifest, pi: { ...manifest.pi, capabilities: ["tool.register"] } }),
		);

		const lenient = await loadFixture(target, "discover");
		expect(lenient.errors, "default mode must warn, not reject").toEqual([]);
		expect(warningsOf(lenient)[0]?.warning).toContain("uses undeclared capabilities: event.subscribe");

		clearExtensionCache();
		const strict = await loadFixture(target, "discover", { strictCapabilities: true });
		expect(strict.errors[0]?.error).toContain("Extension contract not satisfied");
		expect(strict.extensions).toHaveLength(0);
	});

	it("ignores unknown manifest fields without warning", async () => {
		// E4 from the plugin side. The host's reader picks the fields it knows and ignores the rest, and
		// this is the fixture that notices if it stops.
		const result = await loadFixture(install("manifest-unknown-fields@v1"), "discover");
		expect(warningsOf(result)).toEqual([]);
		expect(result.extensions).toHaveLength(1);
	});

	it("matches the host version the baseline was recorded against", () => {
		// A host release that changes the recorded surface must be reviewed as a baseline change rather
		// than absorbed silently. Naming both versions makes the diff say which direction moved.
		expect(baseline.hostVersion).toBe(VERSION);
		expect(baseline.pluginApiVersion).toBe(index.pluginApiVersion);
	});

	it("covers every fixture layer", () => {
		// The matrix is only as representative as its spread. A fixture set covering nothing but tool
		// registration would stay green through a change that broke MCP registration.
		const layers = new Set(index.fixtures.map((entry) => entry.layer));
		expect([...layers].sort()).toEqual([1, 2, 3, 4]);
	});

	it("keeps the failure of one fixture from affecting the next", async () => {
		// Collection-level fail-soft is the property that lets one broken plugin coexist with working
		// ones. A batch load proves it on the compatibility set rather than on a hand-built case, with the
		// rejected fixture first so the ordering that could mask it is the one exercised.
		const bad = install("manifest-unknown-fields@v1");
		const badManifest = join(bad, "package.json");
		const manifest = JSON.parse(readFileSync(badManifest, "utf8")) as { pi: Record<string, unknown> };
		writeFileSync(badManifest, JSON.stringify({ ...manifest, pi: { ...manifest.pi, apiVersion: "999" } }));
		const good = install("tool-register@v1");
		clearExtensionCache();

		const result = await discoverAndLoadExtensions([bad, good], workDir, workDir);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toContain("manifest-unknown-fields@v1");
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.tools.size).toBe(1);
	});
});

/** Load one installed fixture through one entry point. */
async function loadFixture(
	target: string,
	mode: Mode,
	options?: { strictCapabilities?: boolean },
): Promise<LoadExtensionsResult> {
	// The temporary directory is the parent of the installed plugin, so discovery walks it as the
	// project's `.pi`-style root and the extension cache is keyed per fixture.
	const cwd = dirname(dirname(target));
	const entry = join(target, "index.ts");
	switch (mode) {
		case "discover":
			return discoverAndLoadExtensions([target], cwd, cwd, undefined, options);
		case "explicit":
			return loadExtensions([entry], cwd, undefined, undefined, options);
		case "factory": {
			const factory = await importFixture(entry);
			// `loadExtensionFromFactory` is the inline and built-in path: it takes a factory rather than a
			// path, so no manifest lookup happens and the contract envelope is not evaluated. That is the
			// host's behaviour, not a limitation of the fixture, and it is why the envelope assertions above
			// use the two path-based modes.
			const extension = await loadExtensionFromFactory(
				factory,
				cwd,
				createEventBus(),
				createExtensionRuntime(),
				entry,
			);
			return {
				extensions: [extension],
				errors: [],
				warnings: [],
				runtime: createExtensionRuntime(),
			};
		}
	}
}

/**
 * Import a fixture module the way the host does.
 *
 * `jiti` plus the host's virtual modules, which is exactly the configuration `loadExtensionModule` builds
 * for a TypeScript source runtime. Passing the virtual modules is not optional: an installed fixture lives
 * in a temporary directory with no `node_modules`, so `typebox` resolves only through the host's table.
 * Without them this would fail on a resolution detail of the harness rather than on anything about the
 * contract.
 */
async function importFixture(path: string): Promise<ExtensionFactory> {
	const { createJiti } = await import("jiti");
	const { VIRTUAL_MODULES } = await import("../../src/core/extensions/virtual-modules.ts");
	const jiti = createJiti(import.meta.url, { moduleCache: false, virtualModules: VIRTUAL_MODULES });
	// `{ default: true }` makes jiti hand back the default export, which is the factory. The type is asserted
	// rather than narrowed through `module.default`: a fixture with no default export is already reported as
	// a load error by the two path-based modes, and jiti's return type here is `never` after narrowing.
	const factory = await jiti.import(path, { default: true });
	if (typeof factory !== "function") throw new Error(`${path} does not export a factory function`);
	return factory as ExtensionFactory;
}

/**
 * A load's warnings, as an array.
 *
 * `LoadExtensionsResult.warnings` is optional because a caller that does not care about them may leave it
 * out; every implementation in the loader sets it. Narrowed once here so the matrix can assert on its
 * contents without repeating the fallback at each call site.
 */
function warningsOf(result: LoadExtensionsResult): NonNullable<LoadExtensionsResult["warnings"]> {
	return result.warnings ?? [];
}
