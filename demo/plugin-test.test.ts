import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../packages/coding-agent/src/core/extensions/loader.ts";

const demoDir = path.join(process.cwd(), "demo");

describe("demo plugin loading", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(process.cwd(), ".pi-demo-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const copyPlugin = (pluginName: string): string => {
		const src = path.join(demoDir, pluginName);
		const dest = path.join(extensionsDir, pluginName);
		if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
		fs.cpSync(src, dest, { recursive: true });
		return dest;
	};

	it("loads good plugin", async () => {
		copyPlugin("good-plugin");
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		console.log(`GOOD: errors=${result.errors.length}, extensions=${result.extensions.length}`);
		result.errors.forEach((e: any) => console.log(`  error: ${e.error?.substring(0, 100)}`));
		result.extensions.forEach((e: any) => {
			console.log(`  commands: ${Array.from(e.commands.keys()).join(",")}`);
			console.log(`  tools: ${Array.from(e.tools.keys()).join(",")}`);
		});
	});

	it("handles bad-plugin-throw", async () => {
		copyPlugin("bad-plugin-throw");
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		console.log(`THROW: errors=${result.errors.length}, extensions=${result.extensions.length}`);
		result.errors.forEach((e: any) => console.log(`  error: ${e.error?.substring(0, 100)}`));
	});

	it("handles bad-plugin-badmanifest", async () => {
		copyPlugin("bad-plugin-badmanifest");
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		console.log(`BAD-MANIFEST: errors=${result.errors.length}, extensions=${result.extensions.length}`);
		result.errors.forEach((e: any) => console.log(`  error: ${e.error?.substring(0, 100)}`));
	});
});