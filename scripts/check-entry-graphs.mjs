#!/usr/bin/env node
/**
 * Entry points are cost contracts.
 *
 * A package's `exports` map is the only place that says which modules are public, and one stray
 * `export *` can silently make a narrow entry drag an entire barrel: importing a 1-file pure
 * function through a barrel costs ~37 MB of evaluated module graph, and nothing fails until someone
 * measures a process. This walks the value-import graph of every declared entry point and enforces a
 * budget per entry, so that regression fails at commit time instead.
 *
 * Only value imports count, so a budget is about what a consumer evaluates at runtime. A budget that
 * guards a source-level boundary (the plugin SDK must not carry host types) sets
 * `includeTypeImports: true` and is walked with type-only imports included as well.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Workspace package name -> its source root, so cross-package imports are followed.
 *
 * Every workspace package belongs here. A `@earendil-works/*` specifier that is missing from this
 * table used to be treated as an external dependency and skipped silently, which made the `forbid`
 * patterns of a budget unenforceable for exactly the packages the boundary cares about.
 */
const WORKSPACE = {
	"@earendil-works/chord": "packages/chord/src",
	"@earendil-works/pi-ai": "packages/ai/src",
	"@earendil-works/pi-client": "packages/client/src",
	"@earendil-works/pi-codemode": "packages/codemode/src",
	"@earendil-works/pi-coding-agent": "packages/coding-agent/src",
	"@earendil-works/pi-durable": "packages/durable/src",
	"@earendil-works/pi-agent-core": "packages/agent/src",
	"@earendil-works/pi-mcp": "packages/mcp/src",
	"@earendil-works/pi-plugin-sdk": "packages/plugin-sdk/src",
	"@earendil-works/pi-protocol": "packages/protocol/src",
	"@earendil-works/pi-server": "packages/server/src",
	"@earendil-works/pi-telemetry": "packages/telemetry/src",
	"@earendil-works/pi-tui": "packages/tui/src",
};

/**
 * Source roots the plugin SDK must not reach, at all.
 *
 * The SDK declares the extension contract; it must not carry host implementation types into it.
 * Copying `ExtensionAPI`'s payload types would move the coupling from the extension side into the SDK
 * instead of removing it, so the whole host tree is forbidden rather than one entry.
 */
const HOST_SOURCES = [
	"packages/agent/src",
	"packages/ai/src",
	"packages/chord/src",
	"packages/client/src",
	"packages/codemode/src",
	"packages/coding-agent/src",
	"packages/durable/src",
	"packages/mcp/src",
	"packages/protocol/src",
	"packages/server/src",
	"packages/telemetry/src",
	"packages/tui/src",
];

/**
 * Budgets are deliberate. Entries with no budget remain unbounded; each listed entry states the
 * graph it is allowed to reach.
 */
const BUDGETS = {
	"packages/ai": {
		"./models": {
			maxFiles: 15,
			forbid: ["providers/", "models.generated.ts", "index.ts", "utils/validation.ts", "utils/typebox-helpers.ts"],
		},
		"./utils/*": { maxFiles: 3, forbid: ["providers/", "api/", "index.ts"] },
	},
	"packages/durable": {
		".": {
			// The built-in tool task validates arguments with pi-ai's TypeBox-based validation, so TypeBox is allowed.
			maxFiles: 60,
			forbid: ["packages/ai/src/index.ts", "packages/ai/src/utils/typebox-helpers.ts"],
		},
	},
	"packages/plugin-sdk": {
		".": { maxFiles: 10, forbid: HOST_SOURCES, includeTypeImports: true },
		"./api": { maxFiles: 4, forbid: HOST_SOURCES, includeTypeImports: true },
		"./capabilities": { maxFiles: 2, forbid: HOST_SOURCES, includeTypeImports: true },
		"./compat": { maxFiles: 4, forbid: HOST_SOURCES, includeTypeImports: true },
		"./events": { maxFiles: 2, forbid: HOST_SOURCES, includeTypeImports: true },
		"./manifest": { maxFiles: 4, forbid: HOST_SOURCES, includeTypeImports: true },
		"./version": { maxFiles: 2, forbid: HOST_SOURCES, includeTypeImports: true },
	},
};

const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g;
/** Same as SPEC, but type-only imports count. A budget opts in with `includeTypeImports`. */
const SPEC_WITH_TYPES = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([^;]*?\sfrom\s*)?["']([^"']+)["']/g;

const unregistered = new Set();

function resolveSpec(spec, fromFile) {
	if (spec.startsWith("node:")) return null;
	if (spec.startsWith(".")) {
		const base = resolve(dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	}
	for (const [name, src] of Object.entries(WORKSPACE)) {
		if (spec === name) return resolve(ROOT, src, "index.ts");
		if (!spec.startsWith(`${name}/`)) continue;
		const tail = spec.slice(name.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const file = resolve(ROOT, src, candidate);
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	// Fail closed: an unknown `@earendil-works/*` is a workspace package that nobody registered, so
	// it would silently drop out of every graph and quietly disable the budgets that forbid it.
	if (spec.startsWith("@earendil-works/")) {
		unregistered.add(spec);
		return null;
	}
	return null; // external dependency: not part of the workspace graph
}

function walk(entryFile, includeTypeImports = false) {
	const spec = includeTypeImports ? SPEC_WITH_TYPES : SPEC;
	const seen = new Set();
	const queue = [entryFile];
	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file) || file.endsWith(".json")) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(spec)) {
			const target = resolveSpec(match[2], file);
			if (target) queue.push(target);
		}
	}
	return seen;
}

/** `./dist/harness/context.js` in the exports map is `src/harness/context.ts` on disk. */
function sourceFor(pkgDir, distPath) {
	const rel = distPath.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
	const file = resolve(ROOT, pkgDir, "src", rel);
	return existsSync(file) ? file : undefined;
}

function expand(pkgDir, entry, target) {
	if (!entry.includes("*")) return [[entry, target]];
	const dir = resolve(ROOT, pkgDir, "src", dirname(target.replace(/^\.\/dist\//, "")));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => [entry.replace("*", name.replace(/\.ts$/, "")), target.replace("*", name.replace(/\.ts$/, ""))]);
}

let failures = 0;
for (const [pkgDir, budgets] of Object.entries(BUDGETS)) {
	const manifest = JSON.parse(readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"));
	for (const [entry, budget] of Object.entries(budgets)) {
		const declared = manifest.exports?.[entry];
		if (!declared) {
			console.error(`${pkgDir} declares no export "${entry}" but a budget exists for it`);
			failures += 1;
			continue;
		}
		const target = typeof declared === "string" ? declared : declared.import;
		for (const [name, distPath] of expand(pkgDir, entry, target)) {
			const source = sourceFor(pkgDir, distPath);
			if (!source) {
				console.error(`${pkgDir} export "${name}" points at ${distPath}, which has no source file`);
				failures += 1;
				continue;
			}
			// Forward slashes: a forbid pattern is a repo-relative path, and on Windows `relative()`
			// returns backslashes, which silently made every pattern miss.
			const graph = [...walk(source, budget.includeTypeImports === true)].map((file) =>
				relative(ROOT, file).split(sep).join("/"),
			);
			if (graph.length > budget.maxFiles) {
				console.error(
					`${pkgDir} export "${name}" reaches ${graph.length} files, budget ${budget.maxFiles}\n` +
						graph.map((file) => `    ${file}`).join("\n"),
				);
				failures += 1;
			}
			for (const pattern of budget.forbid ?? []) {
				const hit = graph.filter((file) => file.includes(pattern));
				if (hit.length > 0) {
					console.error(`${pkgDir} export "${name}" must not reach ${pattern}:\n${hit.map((f) => `    ${f}`).join("\n")}`);
					failures += 1;
				}
			}
		}
	}
}

if (unregistered.size > 0) {
	// Reported after the walk so the message can list every unregistered specifier at once. These are
	// not necessarily budget violations today, but each one is a budget that silently does not apply.
	for (const spec of [...unregistered].sort()) {
		console.error(`Unregistered workspace specifier "${spec}". Add it to WORKSPACE in scripts/check-entry-graphs.mjs.`);
	}
	failures += 1;
}

if (failures > 0) {
	console.error(`\n${failures} entry-point budget violation(s).`);
	process.exit(1);
}
console.log("Entry point graphs are within budget.");
