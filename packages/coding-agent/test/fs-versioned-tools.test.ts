import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ExtensionToolContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { InMemoryVersionedFsBackend, type VersionedFsBackend } from "../src/extensions/fs-versioned/backend.ts";
import { createFsVersionedExtension } from "../src/extensions/fs-versioned/index.ts";
import { NodeVersionedFsBackend } from "../src/extensions/fs-versioned/node-backend.ts";
import {
	createFsStatToolDefinition,
	createFsWriteToolDefinition,
	type FsStatDetails,
} from "../src/extensions/fs-versioned/tool.ts";
import { FsVersionedError, type FsWriteOutcome } from "../src/extensions/fs-versioned/types.ts";
import { computeFileVersion } from "../src/extensions/fs-versioned/version.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-fs-versioned-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function statVersion(backend: VersionedFsBackend, path: string): Promise<string> {
	const info = await backend.stat(path);
	if (info === undefined) throw new Error(`expected ${path} to exist`);
	return info.version;
}

describe("fs-versioned contract (in-memory backend)", () => {
	it("stat returns v1; replaceIfVersion(v1) succeeds and returns v2; the same v1 guard is then stale", async () => {
		const backend = new InMemoryVersionedFsBackend();
		const path = "/workspace/a.txt";
		await backend.writeText(path, "v1\n");

		const v1 = await statVersion(backend, path);
		expect(v1).toBe(computeFileVersion("v1\n"));

		const replaced: FsWriteOutcome = await backend.writeText(path, "v2\n", {
			kind: "replaceIfVersion",
			version: v1,
		});
		expect(replaced.operation).toBe("update");
		expect(replaced.before).toBe("v1\n");
		expect(replaced.after).toBe("v2\n");

		const v2 = await statVersion(backend, path);
		expect(v2).not.toBe(v1);
		expect(v2).toBe(replaced.version);

		await expect(backend.writeText(path, "v3\n", { kind: "replaceIfVersion", version: v1 })).rejects.toMatchObject({
			name: "FsVersionedError",
			code: "FS_STALE_VERSION",
		});
	});

	it("createIfAbsent rejects an existing target with FS_NOT_OBSERVED", async () => {
		const backend = new InMemoryVersionedFsBackend();
		const path = "/workspace/a.txt";
		await backend.writeText(path, "v1\n");

		await expect(backend.writeText(path, "v2\n", { kind: "createIfAbsent" })).rejects.toMatchObject({
			name: "FsVersionedError",
			code: "FS_NOT_OBSERVED",
		});
	});

	it("createIfAbsent creates an absent target; replaceIfVersion rejects an absent target", async () => {
		const backend = new InMemoryVersionedFsBackend();
		const path = "/workspace/new.txt";

		const created = await backend.writeText(path, "first\n", { kind: "createIfAbsent" });
		expect(created.operation).toBe("create");
		expect(created.before).toBeNull();
		expect(created.version).toBe(computeFileVersion("first\n"));

		await expect(
			backend.writeText("/workspace/absent.txt", "x\n", {
				kind: "replaceIfVersion",
				version: "stale-token",
			}),
		).rejects.toMatchObject({ code: "FS_STALE_VERSION" });
	});

	it("two writers guarding on the same v1: exactly one succeeds (FS_STALE_VERSION for the loser)", async () => {
		const backend = new InMemoryVersionedFsBackend();
		const path = "/workspace/race.txt";
		await backend.writeText(path, "base\n");
		const v1 = await statVersion(backend, path);

		const results = await Promise.allSettled([
			backend.writeText(path, "writer A\n", { kind: "replaceIfVersion", version: v1 }),
			backend.writeText(path, "writer B\n", { kind: "replaceIfVersion", version: v1 }),
		]);

		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);

		const winner = fulfilled[0] as PromiseFulfilledResult<FsWriteOutcome>;
		expect(winner.value.after).toMatch(/^writer [AB]\n$/);

		const loserReason = rejected[0]?.reason;
		expect(loserReason).toBeInstanceOf(FsVersionedError);
		expect((loserReason as FsVersionedError).code).toBe("FS_STALE_VERSION");

		const finalVersion = await statVersion(backend, path);
		expect(finalVersion).toBe(winner.value.version);
	});
});

describe("fs-versioned contract (node backend)", () => {
	it("guards writes on the real filesystem", async () => {
		const dir = await createTempDir();
		const path = join(dir, "a.txt");
		const backend = new NodeVersionedFsBackend();

		await writeFile(path, "v1\n", "utf-8");
		const v1 = await statVersion(backend, path);
		expect(v1).toBe(computeFileVersion("v1\n"));

		const replaced = await backend.writeText(path, "v2\n", { kind: "replaceIfVersion", version: v1 });
		expect(replaced.operation).toBe("update");
		expect(await readFile(path, "utf-8")).toBe("v2\n");

		await expect(backend.writeText(path, "v3\n", { kind: "replaceIfVersion", version: v1 })).rejects.toMatchObject({
			code: "FS_STALE_VERSION",
		});
		await expect(backend.writeText(path, "v4\n", { kind: "createIfAbsent" })).rejects.toMatchObject({
			code: "FS_NOT_OBSERVED",
		});
		expect(await readFile(path, "utf-8")).toBe("v2\n");
	});

	it("createIfAbsent creates a new file on disk", async () => {
		const dir = await createTempDir();
		const path = join(dir, "new.txt");
		const backend = new NodeVersionedFsBackend();

		const created = await backend.writeText(path, "hello\n", { kind: "createIfAbsent" });
		expect(created.operation).toBe("create");
		expect(await readFile(path, "utf-8")).toBe("hello\n");
	});

	it("stat and observe report absent targets", async () => {
		const dir = await createTempDir();
		const backend = new NodeVersionedFsBackend();
		const missing = join(dir, "missing.txt");
		expect(await backend.stat(missing)).toBeUndefined();
		expect(await backend.observe(missing)).toEqual({ kind: "absent" });
	});

	it("directories are observable with an opaque identity version", async () => {
		const dir = await createTempDir();
		const backend = new NodeVersionedFsBackend();
		const info = await backend.stat(dir);
		expect(info?.type).toBe("directory");
		expect(info?.version).toMatch(/^[0-9a-f]{64}$/);
	});

	it("CRLF and LF content share the LF-normalized version basis", async () => {
		const dir = await createTempDir();
		const lfPath = join(dir, "lf.txt");
		const crlfPath = join(dir, "crlf.txt");
		await writeFile(lfPath, "a\nb\n", "utf-8");
		await writeFile(crlfPath, "a\r\nb\r\n", "utf-8");
		const backend = new NodeVersionedFsBackend();
		expect(await statVersion(backend, lfPath)).toBe(await statVersion(backend, crlfPath));
	});
});

describe("fs.stat / fs.write tool execution", () => {
	const ctx = { cwd: process.cwd() } as ExtensionToolContext;

	it("executes stat and guarded writes through the tool definitions", async () => {
		const backend = new InMemoryVersionedFsBackend();
		const statTool = createFsStatToolDefinition(backend);
		const writeTool = createFsWriteToolDefinition(backend);
		const path = "/w/tool.txt";

		const absent: AgentToolResult<FsStatDetails> = await statTool.execute(
			"call-1",
			{ path },
			undefined,
			undefined,
			ctx,
		);
		expect(absent.content).toEqual([{ type: "text", text: `${path} does not exist` }]);

		const created = await writeTool.execute(
			"call-2",
			{ path, content: "v1\n", intent: { kind: "createIfAbsent" } },
			undefined,
			undefined,
			ctx,
		);
		expect(created.content).toEqual([
			{ type: "text", text: `Created ${path} (version ${computeFileVersion("v1\n")})` },
		]);
		expect(created.structuredContent).toEqual({
			path,
			operation: "create",
			version: computeFileVersion("v1\n"),
		});

		const observed = await statTool.execute("call-3", { path }, undefined, undefined, ctx);
		const observedText = observed.content[0];
		expect(observedText && "text" in observedText ? observedText.text : "").toContain("version: ");

		const v1 = computeFileVersion("v1\n");
		const replaced = await writeTool.execute(
			"call-4",
			{ path, content: "v2\n", intent: { kind: "replaceIfVersion", version: v1 } },
			undefined,
			undefined,
			ctx,
		);
		expect(replaced.content).toEqual([
			{ type: "text", text: `Replaced ${path} (version ${computeFileVersion("v2\n")})` },
		]);

		await expect(
			writeTool.execute(
				"call-5",
				{ path, content: "v3\n", intent: { kind: "replaceIfVersion", version: v1 } },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toMatchObject({ code: "FS_STALE_VERSION" });

		await expect(
			writeTool.execute(
				"call-6",
				{ path, content: "v4\n", intent: { kind: "createIfAbsent" } },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toMatchObject({ code: "FS_NOT_OBSERVED" });
	});

	it("unconditional write creates or overwrites without an intent", async () => {
		const backend = new InMemoryVersionedFsBackend();
		const writeTool = createFsWriteToolDefinition(backend);
		const path = "/w/plain.txt";
		const ctx = { cwd: process.cwd() } as ExtensionToolContext;

		const created = await writeTool.execute("call-1", { path, content: "one\n" }, undefined, undefined, ctx);
		expect(created.content).toEqual([
			{ type: "text", text: `Created ${path} (version ${computeFileVersion("one\n")})` },
		]);

		const updated = await writeTool.execute("call-2", { path, content: "two\n" }, undefined, undefined, ctx);
		expect(updated.content).toEqual([
			{ type: "text", text: `Replaced ${path} (version ${computeFileVersion("two\n")})` },
		]);
	});
});

describe("createFsVersionedExtension", () => {
	it("registers fs.stat and fs.write through registerTool", () => {
		const registered: ToolDefinition[] = [];
		const pi = { registerTool: (tool: ToolDefinition) => registered.push(tool) } as unknown as ExtensionAPI;
		const factory: ExtensionFactory = createFsVersionedExtension({ backend: new InMemoryVersionedFsBackend() });
		factory(pi);
		expect(registered.map((tool) => tool.name).sort()).toEqual(["fs.stat", "fs.write"]);
		for (const tool of registered) {
			expect(tool.defaultActive).toBe(false);
			expect(tool.parameters).toBeTypeOf("object");
		}
	});
});
