import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import type { RegisteredMcpServer } from "../src/core/mcp-servers.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { createMcpDshExtension, type DshMcpServerConfig } from "../src/extensions/mcp-dsh/index.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	getToolResult,
	type Harness,
} from "./suite/harness.ts";

/** Local stdio MCP server, answered entirely by the fixture process (see its header). */
const FIXTURE = resolve(import.meta.dirname, "mcp-dsh-fixture-server.mjs");

const WAIT = { timeout: 20_000, interval: 50 };

describe("mcp-dsh extension", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	/**
	 * Load the built-in mcp extension, `before`, the mcp-dsh extension with `servers`, and an
	 * observer that reads `pi.getMcpServers()` after mcp-dsh committed, then start a session.
	 */
	async function setup(
		servers: DshMcpServerConfig[],
		before: InlineExtension[] = [],
		options: { failOnStartupError?: boolean } = {},
	) {
		let registered: RegisteredMcpServer[] = [];
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
				...before,
				{
					name: "mcp-dsh",
					factory: createMcpDshExtension({ servers, failOnStartupError: options.failOnStartupError }),
				},
				{
					name: "observer",
					factory: (pi) => {
						registered = pi.getMcpServers();
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return { harness, registered: () => registered, notifications };
	}

	it("registers the fixture server, lists its tools, and answers a call from the fixture", async () => {
		const { harness, registered } = await setup([
			{
				serverName: "dsh-fixture",
				command: process.execPath,
				args: [FIXTURE],
				// The transport spawns stdio servers in the session temp dir by default; an
				// absolute cwd keeps the child out of it so cleanup can delete the dir on Windows.
				cwd: import.meta.dirname,
				toolCallTimeoutMs: 5_000,
				exposure: "direct",
				description: "DSH stdio fixture",
			},
		]);

		// The server is in the registry pi's mcp extension reads on session_start.
		expect(registered().map((server) => [server.name, server.extensionPath])).toEqual([
			["dsh-fixture", "<inline:mcp-dsh>"],
		]);
		expect(registered()[0].config).toMatchObject({
			type: "stdio",
			command: process.execPath,
			args: [FIXTURE],
			// DSH toolCallTimeoutMs 5000 becomes pi's timeout of 5 seconds.
			timeout: 5,
			exposure: "direct",
			description: "DSH stdio fixture",
		});

		// tools/list ran against the fixture, so its tools are registered for the model.
		await vi.waitFor(
			() => expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__dsh_fixture__add"),
			WAIT,
		);
		expect(harness.session.getActiveToolNames()).toContain("mcp__dsh_fixture__add");

		// The call goes to the fixture process, which adds the numbers itself.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__dsh_fixture__add", { a: 3, b: 4 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("add 3 and 4");

		const result = getToolResult(harness, "mcp__dsh_fixture__add");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe("7");
	});

	it("a server that exits at startup is recorded while the host keeps running", async () => {
		const { harness, registered, notifications } = await setup([
			{
				serverName: "dsh-exits",
				command: process.execPath,
				args: ["-e", "process.exit(1)"],
				toolCallTimeoutMs: 3_000,
				exposure: "direct",
			},
		]);

		// Fail-soft: the session runs a prompt after the server died.
		harness.setResponses([fauxAssistantMessage("alive")]);
		await harness.session.prompt("hello");
		expect(getAssistantTexts(harness)).toEqual(["alive"]);

		// The failure is registered: the connection state and the startup report name the server,
		// while the registration itself stays in place for a later reconnect.
		await vi.waitFor(() => expect(notifications.join("\n")).toContain("dsh-exits: failed"), WAIT);
		expect(registered().map((server) => server.name)).toEqual(["dsh-exits"]);
	});

	it("fails only the mcp-dsh extension when a registration is rejected (R10)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-dsh-"));
		dirs.push(cwd);
		const squatter: InlineExtension = {
			name: "squatter",
			factory: (pi) => {
				pi.registerMcpServer("taken", { command: "squatter" });
			},
		};
		const dsh: InlineExtension = {
			name: "mcp-dsh",
			factory: createMcpDshExtension({
				servers: [
					{ serverName: "free", command: "free-server" },
					{ serverName: "taken", command: "taken-server", failOnStartupError: true },
				],
			}),
		};
		const survivor: InlineExtension = {
			name: "survivor",
			factory: (pi) => {
				pi.on("session_start", () => {});
			},
		};

		const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, extensionFactories: [squatter, dsh, survivor] });
		// The factory throw is contained: loading continues instead of failing the host.
		await loader.reload();

		const { extensions, errors, runtime } = loader.getExtensions();
		expect(errors).toEqual([
			{
				path: "<inline:mcp-dsh>",
				// Matches the loader's wording before and after the parallel wording change in
				// core/extensions/loader.ts: only the phrasing between name and "already" differs.
				error: expect.stringMatching(/MCP server "taken".*already registered by extension "<inline:squatter>"/),
			},
		]);
		expect(extensions.map((extension) => extension.path)).toEqual(["<inline:squatter>", "<inline:survivor>"]);
		// The failed extension's pending registrations were discarded with it.
		expect(runtime.mcpServers.list().map((server) => [server.name, server.extensionPath])).toEqual([
			["taken", "<inline:squatter>"],
		]);
	});

	it("skips a rejected registration by default and reports it on session_start", async () => {
		const { harness, registered, notifications } = await setup(
			[
				{ serverName: "dsh-other", command: "other-server" },
				{ serverName: "dsh-taken", command: "taken-server" },
			],
			[
				{
					name: "squatter",
					factory: (pi) => {
						pi.registerMcpServer("dsh-taken", { command: "squatter", enabled: false });
					},
				},
			],
		);

		// DSH's default (failOnStartupError false): the other server still registers, and the
		// rejected one is reported on session_start instead of failing the extension.
		expect(registered().map((server) => [server.name, server.extensionPath])).toEqual([
			["dsh-taken", "<inline:squatter>"],
			["dsh-other", "<inline:mcp-dsh>"],
		]);
		expect(notifications.join("\n")).toContain("MCP servers declared by the mcp-dsh extension were not registered");
		expect(notifications.join("\n")).toContain('dsh-taken: MCP server "dsh-taken"');

		// Host alive: the session still runs a prompt.
		harness.setResponses([fauxAssistantMessage("alive")]);
		await harness.session.prompt("hello");
		expect(getAssistantTexts(harness)).toEqual(["alive"]);
	});
});
