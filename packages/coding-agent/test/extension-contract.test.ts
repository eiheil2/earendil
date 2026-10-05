import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { findExtensionManifest } from "../src/core/extensions/contract.ts";
import {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { readPiManifest, resolveExtensionEntries } from "../src/core/pi-manifest.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(testDir, "../examples/extensions");
const workspaceExamples = ["with-deps", "custom-provider-anthropic", "custom-provider-gitlab-duo", "sandbox"] as const;

const commandExtension = `
	export default function(pi) {
		pi.registerCommand("test", { handler: async () => {} });
	}
`;

describe("extension contract envelope", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-contract-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** Write an extension package: a directory with a `pi` manifest and one factory file. */
	function writeExtensionPackage(name: string, pi: Record<string, unknown>): string {
		const dir = path.join(extensionsDir, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "index.ts"), commandExtension);
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, pi }, null, 2));
		return dir;
	}

	function writeManifest(pi: Record<string, unknown>): string {
		const file = path.join(tempDir, "manifest-package.json");
		fs.writeFileSync(file, JSON.stringify({ name: "manifest-probe", pi }, null, 2));
		return file;
	}

	describe("manifest parsing", () => {
		it("reads the four contract fields", () => {
			const manifest = readPiManifest(
				writeManifest({
					apiVersion: "1",
					minHostVersion: ">=1.0.0 <2.0.0",
					capabilities: ["tool.register", "event.subscribe"],
					experimental: ["experimental.ui.widget"],
				}),
			);

			expect(manifest).toEqual({
				apiVersion: "1",
				minHostVersion: ">=1.0.0 <2.0.0",
				capabilities: ["tool.register", "event.subscribe"],
				experimental: ["experimental.ui.widget"],
			});
		});

		it("keeps the resource fields and the contract fields independent", () => {
			const manifest = readPiManifest(
				writeManifest({ extensions: ["./index.ts"], skills: ["./skills"], apiVersion: "1" }),
			);

			expect(manifest).toEqual({ extensions: ["./index.ts"], skills: ["./skills"], apiVersion: "1" });
		});

		it("ignores unknown fields without failing", () => {
			const manifest = readPiManifest(
				writeManifest({ apiVersion: "1", futureField: { nested: true }, $schema: "x" }),
			);

			expect(manifest).toEqual({ apiVersion: "1" });
		});

		it("ignores contract fields of the wrong type", () => {
			const manifest = readPiManifest(
				writeManifest({ apiVersion: 1, minHostVersion: [], capabilities: "tool.register", experimental: [1] }),
			);

			expect(manifest).toEqual({});
		});

		it("returns null for a missing or malformed manifest", () => {
			expect(readPiManifest(path.join(tempDir, "does-not-exist.json"))).toBeNull();
			const broken = path.join(tempDir, "broken.json");
			fs.writeFileSync(broken, "{ not json");
			expect(readPiManifest(broken)).toBeNull();
		});
	});

	describe("extension entry resolution", () => {
		it("prefers the manifest entries, then index.ts, then index.js", () => {
			const manifestDir = path.join(tempDir, "manifest-pkg");
			fs.mkdirSync(manifestDir);
			fs.writeFileSync(path.join(manifestDir, "index.ts"), commandExtension);
			fs.writeFileSync(path.join(manifestDir, "custom.ts"), commandExtension);
			fs.writeFileSync(
				path.join(manifestDir, "package.json"),
				JSON.stringify({ name: "manifest-pkg", pi: { extensions: ["./custom.ts"] } }),
			);
			expect(resolveExtensionEntries(manifestDir)).toEqual([path.join(manifestDir, "custom.ts")]);

			const indexTsDir = path.join(tempDir, "index-ts-pkg");
			fs.mkdirSync(indexTsDir);
			fs.writeFileSync(path.join(indexTsDir, "index.ts"), commandExtension);
			fs.writeFileSync(path.join(indexTsDir, "index.js"), commandExtension);
			expect(resolveExtensionEntries(indexTsDir)).toEqual([path.join(indexTsDir, "index.ts")]);

			const indexJsDir = path.join(tempDir, "index-js-pkg");
			fs.mkdirSync(indexJsDir);
			fs.writeFileSync(path.join(indexJsDir, "index.js"), commandExtension);
			expect(resolveExtensionEntries(indexJsDir)).toEqual([path.join(indexJsDir, "index.js")]);

			expect(resolveExtensionEntries(path.join(tempDir, "empty-pkg"))).toBeNull();
		});
	});

	describe("manifest ownership", () => {
		it("finds the manifest that declares the extension, including through a subdirectory", () => {
			const dir = writeExtensionPackage("nested", { extensions: ["./index.ts"], apiVersion: "1" });
			const nestedDir = path.join(dir, "src");
			fs.mkdirSync(nestedDir);
			fs.writeFileSync(path.join(nestedDir, "main.ts"), commandExtension);
			fs.writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "nested", pi: { extensions: ["./src/main.ts"], apiVersion: "1" } }),
			);

			expect(findExtensionManifest(path.join(nestedDir, "main.ts"))?.apiVersion).toBe("1");
		});

		it("has no envelope for a bare file, a built-in, or an unrelated manifest", () => {
			const bare = path.join(extensionsDir, "bare.ts");
			fs.writeFileSync(bare, commandExtension);
			expect(findExtensionManifest(bare)).toBeNull();
			expect(findExtensionManifest("builtin:mcp")).toBeNull();
			expect(findExtensionManifest("<inline>")).toBeNull();

			// The #9863 shape: an installed dependency's package.json must not claim an unrelated file.
			const dependencyDir = path.join(tempDir, "node_modules", "@earendil-works", "pi-coding-agent");
			fs.mkdirSync(dependencyDir, { recursive: true });
			fs.writeFileSync(
				path.join(dependencyDir, "package.json"),
				JSON.stringify({ name: "@earendil-works/pi-coding-agent", pi: { extensions: ["./index.js"] } }),
			);
			fs.writeFileSync(path.join(dependencyDir, "index.js"), commandExtension);
			expect(findExtensionManifest(path.join(extensionsDir, "bare.ts"))).toBeNull();
		});
	});

	describe("apiVersion", () => {
		it("loads an extension that declares the current version", async () => {
			writeExtensionPackage("current", {
				extensions: ["./index.ts"],
				apiVersion: "1",
				capabilities: ["command.register"],
			});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toEqual([]);
			expect(result.warnings ?? []).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		});

		it("rejects an unsupported version and keeps loading the rest of the batch", async () => {
			writeExtensionPackage("future", { extensions: ["./index.ts"], apiVersion: "2" });
			writeExtensionPackage("current", { extensions: ["./index.ts"], apiVersion: "1" });
			fs.writeFileSync(path.join(extensionsDir, "legacy.ts"), commandExtension);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toContain("future");
			expect(result.errors[0].error).toContain('requires extension API version "2"');
			expect(result.errors[0].error).toContain('this host implements version "1"');
			expect(result.extensions).toHaveLength(2);
			expect(result.extensions.some((extension) => extension.path.includes("future"))).toBe(false);
			expect(result.extensions.some((extension) => extension.path.endsWith("legacy.ts"))).toBe(true);
		});

		it("loads an extension with no apiVersion, and does not warn about it", async () => {
			writeExtensionPackage("legacy", { extensions: ["./index.ts"] });

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toEqual([]);
			expect(result.warnings ?? []).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		});

		it("registers nothing when the extension is rejected", async () => {
			writeExtensionPackage("future", { extensions: ["./index.ts"], apiVersion: "2" });

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.extensions).toHaveLength(0);
			expect(result.runtime.pendingProviderRegistrations).toEqual([]);
			expect(result.runtime.pendingVirtualModelRegistrations).toEqual([]);
		});
	});

	describe("minHostVersion", () => {
		it("warns and loads when the range is not satisfied", async () => {
			writeExtensionPackage("too-new", {
				extensions: ["./index.ts"],
				apiVersion: "1",
				minHostVersion: ">=99",
				capabilities: ["command.register"],
			});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toEqual([]);
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings?.[0].path).toContain("too-new");
			expect(result.warnings?.[0].warning).toBe(`requires host >=99; host version is ${VERSION}`);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0].commands.has("test")).toBe(true);
		});

		it("stays silent when the range is satisfied", async () => {
			writeExtensionPackage("compatible", {
				extensions: ["./index.ts"],
				apiVersion: "1",
				minHostVersion: ">=0.0.1",
				capabilities: ["command.register"],
			});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toEqual([]);
			expect(result.warnings ?? []).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		});

		it("warns when the range cannot be parsed", async () => {
			writeExtensionPackage("bad-range", {
				extensions: ["./index.ts"],
				minHostVersion: "newest",
				capabilities: ["command.register"],
			});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toEqual([]);
			expect(result.warnings?.[0].warning).toContain("is not a valid semver range");
			expect(result.extensions).toHaveLength(1);
		});
	});

	describe("capabilities", () => {
		const mismatched = {
			extensions: ["./index.ts"],
			apiVersion: "1",
			capabilities: ["tool.register"],
		};

		it("warns when the extension registers something it did not declare", async () => {
			writeExtensionPackage("undeclared", mismatched);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toEqual([]);
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings?.[0].warning).toBe("uses undeclared capabilities: command.register");
			expect(result.extensions).toHaveLength(1);
		});

		it("rejects the same extension under --strict-capabilities", async () => {
			writeExtensionPackage("undeclared", mismatched);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir, undefined, {
				strictCapabilities: true,
			});

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].error).toContain("uses undeclared capabilities: command.register");
			expect(result.warnings ?? []).toEqual([]);
			expect(result.extensions).toHaveLength(0);
		});

		it("warns when an extension that joined the contract declares nothing", async () => {
			writeExtensionPackage("no-capabilities", { extensions: ["./index.ts"], apiVersion: "1" });

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.warnings).toHaveLength(1);
			expect(result.warnings?.[0].warning).toBe("declares no capabilities but uses: command.register");
		});

		it("stays silent when the declaration covers what the extension registered", async () => {
			writeExtensionPackage("declared", {
				extensions: ["./index.ts"],
				apiVersion: "1",
				capabilities: ["command.register", "tool.register"],
			});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir, undefined, {
				strictCapabilities: true,
			});

			expect(result.errors).toEqual([]);
			expect(result.warnings ?? []).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		});

		it("ignores capability strings the host does not know", async () => {
			writeExtensionPackage("future-capability", {
				extensions: ["./index.ts"],
				apiVersion: "1",
				capabilities: ["command.register", "capability.from.the.future"],
			});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir, undefined, {
				strictCapabilities: true,
			});

			expect(result.errors).toEqual([]);
			expect(result.warnings ?? []).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		});

		it("does not nag an extension that never joined the contract, even in strict mode", async () => {
			writeExtensionPackage("legacy", { extensions: ["./index.ts"] });

			const result = await discoverAndLoadExtensions([], tempDir, tempDir, undefined, {
				strictCapabilities: true,
			});

			expect(result.errors).toEqual([]);
			expect(result.warnings ?? []).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		});

		it("observes the registrations of the factory, not just the manifest", async () => {
			const dir = writeExtensionPackage("registers-everything", {
				extensions: ["./index.ts"],
				apiVersion: "1",
				capabilities: ["command.register"],
			});
			fs.writeFileSync(
				path.join(dir, "index.ts"),
				`
				export default function(pi) {
					pi.registerCommand("test", { handler: async () => {} });
					pi.on("agent_start", async () => {});
					pi.registerFlag("demo-flag", { type: "boolean" });
				}
			`,
			);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.warnings?.[0].warning).toBe("uses undeclared capabilities: event.subscribe, flag.register");
		});
	});

	describe("registration conflict messages", () => {
		function writeMcpExtension(name: string, register: string): string {
			const dir = writeExtensionPackage(name, { extensions: ["./index.ts"] });
			const entry = path.join(dir, "index.ts");
			fs.writeFileSync(entry, `export default function(pi) { ${register} }`);
			return entry;
		}

		it("names both extensions when one asks for a taken MCP server name", async () => {
			const first = writeMcpExtension(
				"mcp-owner",
				`pi.registerMcpServer("shared", { command: "node", args: ["server.js"] });`,
			);
			const second = writeMcpExtension(
				"mcp-claimant",
				`pi.registerMcpServer("shared", { command: "node", args: ["server.js"] });`,
			);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			// Whichever of the two loads second loses, so the winner is the path that is not failing.
			expect(result.errors).toHaveLength(1);
			expect(result.extensions).toHaveLength(1);
			const winner = result.extensions[0].path;
			const loser = result.errors[0].path;
			expect([first, second]).toContain(winner);
			expect(loser).toBe(winner === first ? second : first);
			expect(result.errors[0].error).toContain(`MCP server "shared" requested by extension "${loser}"`);
			expect(result.errors[0].error).toContain(`is already registered by extension "${winner}"`);
		});

		it("names both extensions when two MCP server names share a namespace", async () => {
			const first = writeMcpExtension(
				"mcp-dash-owner",
				`pi.registerMcpServer("shared-one", { command: "node", args: ["server.js"] });`,
			);
			const second = writeMcpExtension(
				"mcp-underscore-claimant",
				`pi.registerMcpServer("shared_one", { command: "node", args: ["server.js"] });`,
			);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(1);
			expect(result.extensions).toHaveLength(1);
			const winner = result.extensions[0].path;
			const loser = result.errors[0].path;
			expect(loser).toBe(winner === first ? second : first);
			expect(result.errors[0].error).toContain(`MCP server "shared_one" requested by extension "${loser}"`);
			expect(result.errors[0].error).toContain(
				`conflicts with server "shared-one" registered by extension "${winner}"`,
			);
		});
	});

	describe("existing extensions keep loading", () => {
		it("loads every built-in extension", async () => {
			const eventBus = createEventBus();
			const runtime = createExtensionRuntime();

			const builtins = builtInExtensions.filter(
				(extension): extension is typeof extension & { name: string; factory: ExtensionFactory } =>
					typeof extension !== "function",
			);
			expect(builtins.length).toBeGreaterThanOrEqual(4);
			for (const builtin of builtins) {
				const extension = await loadExtensionFromFactory(
					builtin.factory,
					tempDir,
					eventBus,
					runtime,
					`builtin:${builtin.name}`,
				);
				expect(extension.path).toBe(`builtin:${builtin.name}`);
			}
		});

		it("loads the workspace example extensions without a contract envelope", async () => {
			for (const name of workspaceExamples) {
				const result = await discoverAndLoadExtensions([path.join(examplesDir, name)], tempDir, tempDir);

				expect(result.errors, name).toEqual([]);
				expect(result.warnings ?? [], name).toEqual([]);
				expect(result.extensions, name).toHaveLength(1);
			}
		});
	});
});
