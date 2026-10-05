#!/usr/bin/env node
/**
 * The extension side of the plugin boundary.
 *
 * An extension is loaded by jiti, which can reach anything Node can reach, so "extensions never
 * import pi internals" was a convention with nothing enforcing it - and `check-entry-graphs.mjs`
 * could not enforce it, because it budgets the entries *pi* publishes, not the ones extensions load.
 * This is that enforcement: every import form in the extension trees of this repository is resolved
 * against one allowlist, and anything outside it fails at commit time with a file:line.
 *
 * The boundary promised here is a *stability* boundary: an extension must not depend on pi's internal
 * modules, so refactoring the core does not break it. It is not a sandbox. An extension can still
 * read the environment, write files, call the network and shut pi down.
 *
 * Two severities, because the repository is not homogeneous:
 * - `error` for the extension trees that are contract fixtures. These are the reference shapes a
 *   published plugin should have, so a violation is a bug in the fixture.
 * - `warn` for the workspace example extensions. They predate the contract and 90+ of their imports
 *   cross the boundary; they are the migration backlog, not a gate. Migrating them means editing
 *   `packages/coding-agent/examples/**`, which is a separate change with its own review.
 *
 * Rules (ids match `plan-plugin-contract.md` section 1.3):
 * - R-B1 package allowlist: a bare specifier must be allowlisted or declared by the extension's own
 *   package.json. Anything else fails.
 * - R-B2 relative escape: a relative specifier must resolve inside the extension's own root.
 * - R-B3 repository path direct hit: no specifier may resolve into a workspace package's `src` or
 *   `dist` tree.
 * - R-B4 fail-closed: an `@earendil-works/*` specifier that is on neither list fails, instead of
 *   being treated as an external dependency. This is the hole `check-entry-graphs.mjs` had.
 * - R-B5 full AST coverage: `import`, `export ... from`, `import()` and `import("x").Type`.
 * - R-B6 typebox dual name: `typebox` and `@sinclair/typebox` are both used in this repository and
 *   both are allowlisted.
 * - R-B7 grandfather list: named exemptions, each with the reason it still exists.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
	isImportDeclaration,
	isImportTypeNode,
	isLiteralTypeNode,
	isNoSubstitutionTemplateLiteral,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extension trees in this repository.
 *
 * `pluginRootDepth` is not used; each file's plugin root is the directory of the nearest
 * `package.json` at or below the scan root, or the scan root itself for a bare extension file.
 */
const ROOTS = [
	{ dir: "packages/coding-agent/test/fixtures/plugins", severity: "error", label: "plugin fixtures" },
	{ dir: "packages/plugin-sdk/test/fixtures/plugins", severity: "error", label: "plugin-sdk fixtures" },
	{
		dir: "packages/coding-agent/examples/extensions",
		severity: "warn",
		label: "workspace example extensions (grandfathered, see the header)",
	},
];

/**
 * Bare specifiers an extension may use. A prefix entry also allowlists its subpaths
 * (`@earendil-works/pi-plugin-sdk/events`).
 *
 * - The SDK subpaths are the contract surface (`plan-plugin-contract.md` section 1.2.2).
 * - `typebox` is the schema library `registerTool` expects; the repository uses both the bare and
 *   the `@sinclair/` spelling, so both are here (R-B6).
 * - `node:*` is Node itself and needs no entry; it is matched by prefix below.
 */
const ALLOWED = ["@earendil-works/pi-plugin-sdk", "typebox", "@sinclair/typebox"];

/**
 * pi's own packages. Naming one is the failure this gate exists to prevent, so it is an error even
 * when the extension declares it as a dependency: the dependency fence (`package-manager.ts`) is
 * about installing third-party code, not about what an extension is allowed to couple to.
 */
const DENIED = [
	"@earendil-works/chord",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-client",
	"@earendil-works/pi-codemode",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-durable",
	"@earendil-works/pi-evals",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-protocol",
	"@earendil-works/pi-server",
	"@earendil-works/pi-telemetry",
	"@earendil-works/pi-tui",
];

/**
 * R-B7. Every entry is a deliberate exception, not an oversight.
 *
 * Empty today, and the list is the point: the one exemption this gate was designed around -
 * `test/extensions-discovery.test.ts` asserting that an extension importing
 * `@earendil-works/pi-coding-agent` loads fine - was removed in this milestone, and the test now
 * imports an allowlisted package instead. What stayed is the requirement that any future exception
 * be a named entry with a reason, so that "the boundary is inconvenient here" always shows up as a
 * diff instead of as a silent hole.
 *
 * Note that grandfathering is a static exemption. At runtime the loader still hands extensions
 * `@earendil-works/pi-ai`, `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` through
 * `virtual-modules.ts` and the jiti alias table, because renderer extensions genuinely need the TUI
 * component constructors. This gate governs what this repository's extension trees import, not what a
 * third-party package can reach once installed; see the boundary note in the plugin SDK README.
 */
const GRANDFATHERED = [];

const SKIPPED_DIRECTORIES = new Set([".git", "coverage", "node_modules"]);
/** Vendored build output (the emscripten bundle in the doom-overlay example) is not ours to police. */
const MAX_FILE_BYTES = 512 * 1024;

function packageNameOf(specifier) {
	const segments = specifier.split("/");
	return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function matches(specifier, names) {
	const name = packageNameOf(specifier);
	return names.some((allowed) => name === allowed || specifier.startsWith(`${allowed}/`));
}

function toPosix(path) {
	return path.split(sep).join("/");
}

function collectFiles(dir, files) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) collectFiles(join(dir, entry.name), files);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!/\.(?:ts|js|mjs|cjs)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
		const file = join(dir, entry.name);
		if (statSync(file).size > MAX_FILE_BYTES) {
			console.warn(`Skipped ${toPosix(relative(ROOT, file))}: larger than ${MAX_FILE_BYTES} bytes (vendored?)`);
			continue;
		}
		files.push(file);
	}
}

/** The extension's own manifest: the nearest package.json at or below the scan root, never above it. */
function manifestOf(file, rootDir) {
	let dir = dirname(file);
	while (toPosix(relative(ROOT, dir)).startsWith(toPosix(relative(ROOT, rootDir)))) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				return { dir, json: JSON.parse(readFileSync(manifest, "utf8")) };
			} catch {
				return { dir, json: undefined };
			}
		}
		if (dir === resolve(rootDir)) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { dir: resolve(rootDir), json: undefined };
}

function declaredDependencies(json) {
	if (!json) return new Set();
	const names = new Set();
	for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
		for (const name of Object.keys(json[field] ?? {})) names.add(name);
	}
	return names;
}

const findings = [];

function report(root, file, position, rule, message) {
	findings.push({ severity: root.severity, root, rule, file, position, message });
}

function checkSpecifier(root, file, pluginRoot, declared, node) {
	const specifier = node.text;
	const position = node.start;
	const grandparented = GRANDFATHERED.some((entry) => entry.file.endsWith(toPosix(file)) && entry.specifier === specifier);
	if (grandparented) {
		report(root, file, position, "R-B7", `grandfathered: ${specifier} (${GRANDFATHERED.find((e) => e.specifier === specifier).reason})`);
		return;
	}

	// R-B2 / R-B3: a relative specifier is resolved textually, because the whole point is that the
	// target may well not exist as far as TypeScript is concerned.
	if (/^\.\.?\//.test(specifier)) {
		const target = resolve(dirname(file), specifier);
		const escaped = !toPosix(target).startsWith(`${toPosix(pluginRoot)}/`) && target !== pluginRoot;
		if (escaped) {
			report(
				root,
				file,
				position,
				"R-B2",
				`relative specifier "${specifier}" escapes the extension root (${toPosix(relative(ROOT, pluginRoot))})`,
			);
			return;
		}
		if (/^packages\/[^/]+\/(?:src|dist)\//.test(toPosix(relative(ROOT, target)))) {
			report(root, file, position, "R-B3", `"${specifier}" resolves into a package source tree`);
			return;
		}
		return;
	}

	if (/^(?:file:|[A-Za-z]:[\\/]|\/)/.test(specifier)) {
		const target = specifier.startsWith("file:") ? resolve(dirname(file), specifier.slice(5)) : specifier;
		if (/^packages\/[^/]+\/(?:src|dist)\//.test(toPosix(relative(ROOT, target)))) {
			report(root, file, position, "R-B3", `"${specifier}" points into a package source tree`);
		}
		return;
	}

	if (specifier.startsWith("node:")) return;

	const name = packageNameOf(specifier);
	// Node builtins without the `node:` prefix are deprecated but still resolve, and several example
	// extensions use that spelling. They are Node, not a package, so they need no declaration.
	if (builtinModules.includes(name)) return;

	if (matches(specifier, DENIED)) {
		report(
			root,
			file,
			position,
			"R-B1",
			`"${name}" is pi internal; an extension must import @earendil-works/pi-plugin-sdk instead`,
		);
		return;
	}
	if (matches(specifier, ALLOWED)) return;

	if (declared.has(name)) return;

	if (specifier.startsWith("@earendil-works/")) {
		// R-B4. Not allowlisted, not pi internal, not declared: an unregistered workspace package.
		// Failing closed is the point - treating it as an external dependency is what hid the pi-*
		// imports before.
		report(
			root,
			file,
			position,
			"R-B4",
			`"${specifier}" is an unregistered @earendil-works package; allowlist it or declare it in the extension's package.json`,
		);
		return;
	}

	if (!declared.has(name)) {
		report(
			root,
			file,
			position,
			"R-B1",
			`"${specifier}" is neither allowlisted nor declared in the extension's own package.json`,
		);
	}
}

function isStringLiteralLike(node) {
	return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node));
}

function importTypeSpecifier(node) {
	if (!isLiteralTypeNode(node.argument)) return undefined;
	if (!isStringLiteralLike(node.argument.literal)) return undefined;
	return node.argument.literal;
}

const files = [];
const roots = ROOTS.filter((root) => existsSync(resolve(ROOT, root.dir)));
for (const root of roots) collectFiles(resolve(ROOT, root.dir), files);

// One synthetic project parses every file with type resolution off: the specifiers under inspection
// are exactly the ones that must not resolve, so asking TypeScript to resolve them would be circular.
const configPath = resolve(ROOT, "tsconfig.check-plugin-boundary.json");
const config = JSON.stringify({
	compilerOptions: { noResolve: true, noLib: true, types: [], allowJs: true, checkJs: false },
	files,
});
const api = new API({
	cwd: ROOT,
	fs: {
		fileExists: (fileName) => (resolve(fileName) === configPath ? true : undefined),
		readFile: (fileName) => (resolve(fileName) === configPath ? config : undefined),
	},
});

try {
	const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
	for (const file of files.sort()) {
		const sourceFile = program.getSourceFile(file);
		if (!sourceFile) continue;
		const root = roots.find((candidate) => toPosix(file).startsWith(`${toPosix(resolve(ROOT, candidate.dir))}/`));
		if (!root) continue;
		const manifest = manifestOf(file, resolve(ROOT, root.dir));
		const declared = declaredDependencies(manifest.json);

		function visit(node) {
			const check = (specifier) => {
				if (!isStringLiteralLike(specifier)) return;
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile));
				checkSpecifier(root, file, manifest.dir, declared, { text: specifier.text, start: { line, character } });
			};
			if (isImportDeclaration(node)) {
				check(node.moduleSpecifier);
			} else if (isExportDeclaration(node)) {
				check(node.moduleSpecifier);
			} else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
				check(node.arguments[0]);
			} else if (isImportTypeNode(node)) {
				check(importTypeSpecifier(node));
			}
			node.forEachChild(visit);
		}

		visit(sourceFile);
	}
} finally {
	api.close();
}

const errors = findings.filter((finding) => finding.severity === "error");
const warnings = findings.filter((finding) => finding.severity === "warn");

/** Per-root, per-rule, per-specifier counts: the shape a migration backlog is worked through in. */
function summarize(list) {
	const summary = new Map();
	for (const finding of list) {
		const key = `${finding.rule} ${finding.message.replace(/\s*\(.*\)$/, "")}`;
		summary.set(key, (summary.get(key) ?? 0) + 1);
	}
	return [...summary.entries()].sort(([a], [b]) => a.localeCompare(b));
}

for (const finding of errors) {
	const { line, character } = finding.position;
	console.error(
		`${toPosix(relative(ROOT, finding.file))}:${line + 1}:${character + 1}: ${finding.rule} ${finding.message} (${finding.root.label})`,
	);
}

if (warnings.length > 0) {
	// Printed in aggregate: the example tree carries hundreds of findings, and one line each would
	// bury the errors above them in the log.
	console.warn(`\n${warnings.length} grandfathered finding(s) (warn only), by rule:`);
	for (const [key, count] of summarize(warnings)) console.warn(`  ${count}x ${key}`);
}

if (errors.length > 0) {
	console.error(`\n${errors.length} plugin boundary violation(s).`);
	process.exit(1);
}
console.log(`Plugin boundary respected (${files.length} files, ${warnings.length} grandfathered finding(s)).`);
