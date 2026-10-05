/**
 * Recording what a loaded extension registered, and comparing it with the committed baseline.
 *
 * This is the L2 contract layer. It answers "does this plugin still load and still register what it
 * registered" - not "does it behave correctly", which would be the L3 layer's job and needs a Docker
 * daemon and real credentials.
 *
 * The choice of a surface snapshot over a behaviour assertion is deliberate. A surface snapshot is
 * sensitive to what a plugin registered and insensitive to what happened afterwards, which makes it
 * stable enough to baseline: a refactor that renames a registration shows up, a refactor that changes
 * timing does not. It also catches exactly the regressions that matter for compatibility - a removed
 * `on()` overload means an event a plugin subscribed to is no longer dispatched, which is visible in the
 * recorded handler list and invisible to a load-only assertion.
 *
 * What it cannot catch is R8, the exhaustive-switch hazard: an old plugin that switches over the event
 * union without a `default` branch keeps loading and keeps registering, and silently stops handling the
 * new event. That is pinned separately, by the pair of fixtures in
 * `packages/plugin-sdk/test/r8-exhaustive-switch/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Extension, ExtensionRuntime } from "../../src/core/extensions/types.ts";
import { compatRoot } from "./fixtures.ts";

export interface RecordedSurface {
	/** Extension path relative to the fixture directory, so a baseline does not embed a temp directory. */
	path: string;
	handlers: string[];
	tools: string[];
	messageRenderers: string[];
	entryRenderers: string[];
	commands: string[];
	flags: string[];
	shortcuts: string[];
	renderers: string[];
}

export interface RecordedFixture {
	name: string;
	apiVersion: string;
	errors: string[];
	warnings: string[];
	surface: RecordedSurface[];
	/**
	 * Registrations that do not land on the extension object.
	 *
	 * Providers, virtual models and MCP servers are queued on the runtime and applied by the atomic
	 * commit, because routing and connections need a model registry that does not exist during loading.
	 * A surface snapshot that only looked at the extension object would show a plugin that registers an
	 * MCP server as registering nothing at all - which is exactly the regression the matrix exists to
	 * catch. Recorded per fixture from the runtime the load returned.
	 */
	providers: string[];
	virtualModels: string[];
	mcpServers: string[];
}

export interface Baseline {
	hostVersion: string;
	pluginApiVersion: string;
	fixtures: RecordedFixture[];
}

/**
 * The surface of one loaded extension.
 *
 * Every collection is reduced to sorted key lists. Sorted because registration order is an implementation
 * detail of the loader, and a baseline that encoded it would fail on a reordering that changed nothing an
 * extension author can observe.
 */
export function recordSurface(extension: Extension, fixtureDirectory: string): RecordedSurface {
	const relativePath = extension.path.startsWith(fixtureDirectory)
		? extension.path.slice(fixtureDirectory.length).replace(/^[\\/]/, "")
		: extension.path;
	const entryRenderers = extension.entryRenderers ?? new Map();
	return {
		path: relativePath,
		handlers: [...extension.handlers.keys()].sort(),
		tools: [...extension.tools.keys()].sort(),
		messageRenderers: [...extension.messageRenderers.keys()].sort(),
		entryRenderers: [...entryRenderers.keys()].sort(),
		commands: [...extension.commands.keys()].sort(),
		flags: [...extension.flags.keys()].sort(),
		shortcuts: [...extension.shortcuts.keys()].sort(),
		renderers: extension.markdownTransformer ? ["markdownTransformer"] : [],
	};
}

/**
 * What a load queued on the runtime, beyond the extension object.
 *
 * Provider, virtual-model and MCP registrations go through `applyRuntimeChange` and are applied by the
 * commit, so they are only visible on the runtime afterwards. Names only - a `Provider` config contains
 * an api key literal and an MCP config contains headers, neither of which belongs in a committed file.
 */
export function recordRuntimeSurface(
	runtime: ExtensionRuntime,
): Pick<RecordedFixture, "providers" | "virtualModels" | "mcpServers"> {
	return {
		providers: [
			...runtime.pendingProviderRegistrations.map((registration) => registration.name),
			...runtime.pendingNativeProviderRegistrations.map((registration) => registration.provider.id),
		].sort(),
		virtualModels: runtime.pendingVirtualModelRegistrations
			.map((registration) => `${registration.definition.provider}/${registration.definition.id}`)
			.sort(),
		mcpServers: runtime.mcpServers
			.list()
			.map((server) => server.name)
			.sort(),
	};
}

export function baselinePath(): string {
	return join(compatRoot, "baseline.json");
}

export function readBaseline(): Baseline {
	return JSON.parse(readFileSync(baselinePath(), "utf8")) as Baseline;
}

export function baselineExists(): boolean {
	return existsSync(baselinePath());
}

/** Serialize a baseline the way the committed file is written: tab-indented, trailing newline. */
export function serializeBaseline(baseline: Baseline): string {
	return `${JSON.stringify(baseline, null, "\t")}\n`;
}
