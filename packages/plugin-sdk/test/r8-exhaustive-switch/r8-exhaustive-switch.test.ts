/**
 * The R8 pin, as a meta-test.
 *
 * R8: `ExtensionEvent` is a closed union of event names and `on()` is one overload per member. Adding a
 * member is a non-breaking change by the version policy (no `PLUGIN_API_VERSION` bump), which is only
 * true while extensions are written defensively. An extension that switches over the union without a
 * `default` branch silently stops handling the new event at runtime, and nothing in pi detects it:
 * `assertNever` appears zero times in the extension subsystem.
 *
 * So the guarantee is pinned by a pair of fixtures and this test:
 *
 * | fixture | shape | when one event is added |
 * |---|---|---|
 * | `exhaustive-switch@v1` | exhaustive switch, no `default` | must stop compiling |
 * | `exhaustive-switch-with-default@v1` | exhaustive switch, `default` present | must keep compiling |
 *
 * Only the first one would obstruct legitimate additive evolution, and only the second one would prove
 * nothing. Running both is what makes the pin usable rather than merely strict.
 *
 * How the first row is enforced without editing the SDK's union: both fixtures are compiled twice. Once
 * against the real `ExtensionEventName`, where both must pass - that is the everyday state. And once
 * against `future-event-union.d.ts`, which is the same union plus one member standing in for the next
 * event a maintainer adds; there the first must fail and the second must pass. Adding a fake member to
 * `EXTENSION_EVENT_NAMES` itself would be strictly worse than no gate: the exhaustive fixture would fail
 * permanently and the failure would stop meaning anything.
 *
 * The compile step spawns `tsc`. `noEmit` plus a synthetic tsconfig keeps it hermetic - no repo tsconfig
 * is involved, so the result does not depend on the host's paths or on anything a parallel change did to
 * the root config.
 *
 * The fixtures themselves live in the compatibility fixture set
 * (`packages/coding-agent/test/fixtures/plugins/`), not next to this test. One copy of each: a second copy
 * here would be a fixture that can be edited without changing what the matrix loads, and the matrix is the
 * thing that has to keep passing.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Repository root.
 *
 * Four levels up, not three: `new URL("../../../", ...)` resolves against the file's *own* directory, so
 * from a file in `r8-exhaustive-switch` three levels lands on `packages/`.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The compatibility fixture set, where the two R8 fixtures live. */
const fixtureRoot = join(repoRoot, "packages/coding-agent/test/fixtures/plugins");
const exhaustiveFixture = join(fixtureRoot, "exhaustive-switch@v1/index.ts");
const defaultFixture = join(fixtureRoot, "exhaustive-switch-with-default@v1/index.ts");

/** The SDK's entry point, as a forward-slashed path: `paths` does not resolve Windows backslashes. */
const SDK_ENTRY = join(sdkRoot, "src/index.ts").split(sep).join("/");

/**
 * The declaration file `typebox` publishes.
 *
 * Located by walking up to the repository's `node_modules` rather than through `require.resolve`, because
 * `typebox` does not export `./package.json` and resolution fails on the subpath, not on the package.
 * Named as a file rather than as the package directory because `typebox`'s `exports` map has no `types`
 * condition, so a `paths` entry naming the directory does not resolve under NodeNext resolution.
 */
const TYPEBOX_TYPES = (() => {
	const manifestPath = join(repoRoot, "node_modules/typebox/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { types: string };
	return join(dirname(manifestPath), manifest.types).split(sep).join("/");
})();

/**
 * The TypeScript CLI entry script.
 *
 * `node_modules/typescript/bin/tsc` is a 44-byte shim with no file extension, which cannot be spawned on
 * Windows, and TypeScript 7 does not export it through `exports` either. `lib/tsc.js` is the script that
 * shim imports, and it locates and runs the native compiler itself, so going through `node` with it works on
 * every platform.
 */
function tscEntry(): string {
	const require = createRequire(import.meta.url);
	return join(dirname(require.resolve("typescript/package.json")), "lib/tsc.js");
}

interface CompileResult {
	ok: boolean;
	output: string;
}

/**
 * Compile one fixture source against one event-name type.
 *
 * `unionSpecifier` is a module that exports a type; the fixture source is copied with its import of
 * `ExtensionEventName` rewritten to that module, so the fixture body is the real one and only the union
 * under it changes.
 */
function compileFixture(
	fixturePath: string,
	unionSpecifier: string,
	extraFiles: Record<string, string>,
): CompileResult {
	const work = mkdtempSync(join(tmpdir(), "pi-r8-switch-"));
	try {
		writeFileSync(join(work, "fixture.ts"), rewriteImports(readFileSync(fixturePath, "utf8"), unionSpecifier));
		// The fixture's own `package.json` declares `type: module`; without it the copy is CommonJS and
		// `verbatimModuleSyntax` rejects every top-level `export`. Copying the real manifest rather than
		// declaring `"type": "module"` keeps the compile faithful to how the fixture is actually published.
		cpSync(join(dirname(fixturePath), "package.json"), join(work, "package.json"));
		for (const [name, content] of Object.entries(extraFiles)) {
			writeFileSync(join(work, name), content);
		}
		// TypeScript 7 removed `baseUrl`; `paths` entries resolve against the tsconfig's own directory, so
		// every target here is absolute.
		const tsconfig = {
			compilerOptions: {
				strict: true,
				noEmit: true,
				declaration: false,
				declarationMap: false,
				skipLibCheck: true,
				target: "ES2024",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				allowImportingTsExtensions: true,
				verbatimModuleSyntax: true,
				erasableSyntaxOnly: true,
				types: ["node"],
				typeRoots: [join(repoRoot, "node_modules/@types")],
				paths: {
					"@earendil-works/pi-plugin-sdk": [SDK_ENTRY],
					"@earendil-works/pi-plugin-sdk/*": [join(sdkRoot, "src/*.ts")],
					typebox: [TYPEBOX_TYPES],
				},
			},
			files: ["fixture.ts"],
		};
		writeFileSync(join(work, "tsconfig.json"), JSON.stringify(tsconfig, null, "\t"));
		const result = spawnSync(process.execPath, [tscEntry(), "-p", work], { cwd: work, encoding: "utf8" });
		return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Point a fixture's SDK imports at this compile's sources.
 *
 * The `ExtensionEventName` import is matched by imported *name*, not by specifier: the fixtures import it from
 * the package root while the SDK declares it in the `events` module, so matching the specifier stopped
 * working the moment the fixtures were written against the root. That failure was silent - the pin kept
 * passing while compiling against the real union, testing nothing - which is why the rewrite has its own
 * test below.
 */
function rewriteImports(source: string, unionSpecifier: string): string {
	// One import statement redirected, not two. The fixtures import `ExtensionEventName` and `ExtensionApi`
	// from the same module; splitting the statement would mean aliasing every name back, and the probe module
	// re-exports the rest anyway - it imports them from the SDK and passes them through.
	return source.replace(
		/import type \{([^}]*)\} from "@earendil-works\/pi-plugin-sdk[^"]*";/g,
		(_match, names: string) => `import type {${names}} from "${unionSpecifier}";`,
	);
}

/**
 * The union under test, as a module the rewritten fixture imports as `ExtensionEventName`.
 *
 * Written with a named import alias because a local declaration cannot share the name with the imported
 * one, and the probe must not be the thing that fails to compile.
 */
function unionModule(extraMember?: string): Record<string, string> {
	const members = extraMember ? ` | "${extraMember}"` : "";
	return {
		"union.ts": [
			'import type * as Sdk from "@earendil-works/pi-plugin-sdk";',
			"",
			"/** The event union with one more member than the SDK currently declares. */",
			`export type ExtensionEventName = Sdk.ExtensionEventName${members};`,
			"",
			// Re-exported so a fixture's other imports keep resolving here after its SDK import is redirected.
			"export type ExtensionApi = Sdk.ExtensionApi;",
			"",
		].join("\n"),
	};
}

describe("R8: additive evolution of the event union", () => {
	it("compiles both fixtures against the current union", () => {
		for (const fixture of [exhaustiveFixture, defaultFixture]) {
			const result = compileFixture(fixture, "./union.ts", unionModule());
			expect(result.output, fixture).toBe("");
			expect(result.ok, fixture).toBe(true);
		}
	});

	it("breaks the exhaustive fixture when one event is added", () => {
		const result = compileFixture(exhaustiveFixture, "./union.ts", unionModule("future_contract_probe_event"));
		expect(result.ok).toBe(false);
		// The failure has to be the exhaustiveness one. A missing module would also make it fail, and
		// that would be a broken probe rather than a working pin.
		// TS2366 is the exhaustiveness failure: the switch no longer covers the union, so the function can
		// fall off the end while its return type excludes `undefined`.
		expect(result.output).toMatch(/TS2366/);
		expect(result.output).toMatch(/lacks ending return statement/);
	});

	it("keeps the defensive fixture compiling when one event is added", () => {
		const result = compileFixture(defaultFixture, "./union.ts", unionModule("future_contract_probe_event"));
		expect(result.output).toBe("");
		expect(result.ok).toBe(true);
	});

	it("keeps the two switch bodies identical apart from the default branch", () => {
		// Only the `classify` function is compared. The two files' headers explain why each version exists
		// and are meant to differ, and so are the command names each registers - what has to match is the
		// switch, because that is the code the pin turns on.
		const switchBody = (path: string) => {
			const source = readFileSync(path, "utf8");
			const start = source.indexOf("export function classify");
			const end = source.indexOf("\n}\n", start);
			if (start === -1 || end === -1) throw new Error(`${path} has no classify function`);
			return source.slice(start, end + 3);
		};
		const exhaustive = switchBody(exhaustiveFixture);
		const defensive = switchBody(defaultFixture);
		expect(exhaustive).not.toMatch(/\bdefault\s*:/);
		expect(defensive).toMatch(/\bdefault\s*:/);
		// Removing the `default` branch has to leave the exhaustive switch byte for byte. If it does not, the
		// two fixtures have drifted and the pair no longer isolates the single difference it exists for.
		const withoutDefault = defensive.replace(/\n\t\tdefault:\n(?:\t\t\t.*\n)+\t\}/, "\n\t}");
		expect(withoutDefault).toBe(exhaustive);
	});

	it("does not let the import rewrite silently stop matching", () => {
		// The pin's whole mechanism is that the rewrite redirects the union the switch sees. If it ever stops
		// matching - a changed import shape, a moved module - the "breaks when an event is added" test passes
		// vacuously, because nothing is compiled against a different union. Asserting the rewrite happened
		// keeps that failure loud instead of silent.
		const rewritten = rewriteImports(readFileSync(exhaustiveFixture, "utf8"), "./union.ts");
		expect(rewritten).toContain('from "./union.ts"');
		expect(rewritten).not.toContain('"@earendil-works/pi-plugin-sdk"');
		// The probe has to re-export the names the fixture imports besides the union, or the fixture fails to
		// compile for a reason that has nothing to do with exhaustiveness - which would make the "breaks"
		// assertion pass for the wrong reason.
		expect(unionModule("x")["union.ts"]).toContain("export type ExtensionApi");
	});

	it("lists every current event name in both fixtures", async () => {
		const { EXTENSION_EVENT_NAMES } = await import("../../src/events.ts");
		for (const fixture of [exhaustiveFixture, defaultFixture]) {
			const source = readFileSync(fixture, "utf8");
			for (const name of EXTENSION_EVENT_NAMES) {
				expect(source, `${fixture}: ${name}`).toContain(`case "${name}":`);
			}
		}
	});
});
