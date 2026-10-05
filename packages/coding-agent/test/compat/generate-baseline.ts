/**
 * Regenerate or verify `baseline.json`, the recorded surface of every fixture.
 *
 * Follows the convention `check:shrinkwrap` and `check:install-lock` already use in this repository: a
 * generator with a `--check` mode. The point of that convention is that a change to the recorded state
 * shows up as a diff in review instead of as a failure inside CI, so the reviewer sees what moved rather
 * than just that something moved.
 *
 * `node test/compat/generate-baseline.ts` rewrites the file; `--check` fails with a unified diff and
 * writes nothing. The two modes share one code path so they cannot disagree about what the baseline means.
 *
 * Two guards on regeneration, because a baseline that can be rewritten silently is not a baseline:
 * `--check` is what CI runs, and regenerating requires the caller to pass `--update` explicitly rather
 * than a bare flag that could end up in a CI script.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { VERSION } from "../../src/config.ts";
import { clearExtensionCache, discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";
import { fixtureDirectory, readFixtureIndex } from "./fixtures.ts";
import {
	type Baseline,
	baselinePath,
	type RecordedFixture,
	recordRuntimeSurface,
	recordSurface,
	serializeBaseline,
} from "./surface.ts";

const compatRoot = fileURLToPath(new URL(".", import.meta.url));

/** Load one fixture the way the matrix does and record what it registered. */
async function recordFixture(name: string, root: string): Promise<RecordedFixture> {
	const work = mkdtempSync(join(tmpdir(), "pi-compat-baseline-"));
	try {
		const { cpSync } = await import("node:fs");
		const target = join(work, "plugins", name);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(fixtureDirectory(name), target, { recursive: true });

		clearExtensionCache();
		const result = await discoverAndLoadExtensions([target], work, work);
		if (result.errors.length > 0) {
			throw new Error(`${name} failed to load: ${result.errors.map((error) => error.error).join("; ")}`);
		}
		return {
			name,
			apiVersion: readFixtureIndex().fixtures.find((entry) => `${entry.name}@v${entry.apiVersion}` === name)
				?.apiVersion as string,
			errors: [],
			warnings: (result.warnings ?? []).map((warning) => warning.warning),
			surface: result.extensions.map((extension) => recordSurface(extension, target)),
			...recordRuntimeSurface(result.runtime),
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
		void root;
	}
}

async function buildBaseline(): Promise<Baseline> {
	const index = readFixtureIndex();
	const fixtures: RecordedFixture[] = [];
	for (const entry of index.fixtures) {
		const name = `${entry.name}@v${entry.apiVersion}`;
		process.stderr.write(`recording ${name}\n`);
		fixtures.push(await recordFixture(name, compatRoot));
	}
	return { hostVersion: VERSION, pluginApiVersion: index.pluginApiVersion, fixtures };
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			check: { type: "boolean", default: false },
			update: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(`Usage: node packages/coding-agent/test/compat/generate-baseline.ts [--check | --update]

  (no flag)  Write baseline.json
  --check    Fail if baseline.json differs from what the current fixtures record
  --update   Write baseline.json (explicit form, so a CI script cannot do it by accident)`);
		return 0;
	}
	if (values.check && values.update) {
		console.error("--check and --update are mutually exclusive.");
		return 1;
	}

	const baseline = await buildBaseline();
	const expected = serializeBaseline(baseline);
	const path = baselinePath();

	if (!values.check) {
		writeFileSync(path, expected);
		console.log(`Wrote ${path}`);
		return 0;
	}

	const actual = readFileSync(path, "utf8");
	if (actual === expected) {
		console.log(`${path} is up to date (host ${baseline.hostVersion}, ${baseline.fixtures.length} fixtures).`);
		return 0;
	}

	// A diff rather than "files differ": the reviewer needs to see which fixture changed and how, which
	// is the entire reason this file exists rather than a boolean assertion in a test.
	console.error(`${path} does not match what the fixtures record.\n`);
	console.error(unifiedDiff(actual, expected, "baseline.json", "baseline.json (regenerated)"));
	console.error(
		"\nIf this change is intended - a registration was renamed, added or removed - review it, then run:\n" +
			"  node packages/coding-agent/test/compat/generate-baseline.ts --update\n",
	);
	return 1;
}

/** Line diff via git when it is available, because it exists in every environment that runs the suite. */
function unifiedDiff(actual: string, expected: string, actualLabel: string, expectedLabel: string): string {
	const write = (dir: string, name: string, content: string) => {
		writeFileSync(join(dir, name), content);
		return join(dir, name);
	};
	const dir = mkdtempSync(join(tmpdir(), "pi-compat-diff-"));
	try {
		const actualPath = write(dir, "actual.json", actual);
		const expectedPath = write(dir, "expected.json", expected);
		const result = spawnSync("git", ["diff", "--no-index", "--unified=3", actualPath, expectedPath], {
			encoding: "utf8",
		});
		if (result.status === null || result.error) {
			return `(${actualLabel} and ${expectedLabel} differ; git diff was unavailable for the detail)\n`;
		}
		return result.stdout
			.split("\n")
			.map((line) =>
				line
					.replaceAll(dir, "")
					.replace(/actual\.json/g, actualLabel)
					.replace(/expected\.json/g, expectedLabel),
			)
			.join("\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

process.exit(await main());
