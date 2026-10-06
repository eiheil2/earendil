import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness, getToolResult, type Harness } from "./suite/harness.ts";

/**
 * AC-B07: a fresh install with zero built-in resources must still complete the first task.
 * The agent directory and the project directory are empty: no skills, no prompt templates,
 * no extensions, no themes, no SYSTEM.md - and PI_OFFLINE=1 so nothing is fetched either.
 */
describe("AC-B07 first task with zero built-in resources", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let harness: Harness | undefined;
	const originalOffline = process.env.PI_OFFLINE;

	beforeEach(() => {
		root = join(tmpdir(), `pi-b07-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		process.env.PI_OFFLINE = "1";
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("loads an empty inventory and completes a write task anyway", async () => {
		const settingsManager = SettingsManager.inMemory({ builtinSkills: false, builtinPrompts: false });
		const resourceLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager });
		await resourceLoader.reload();

		expect(resourceLoader.getExtensions().extensions).toEqual([]);
		expect(resourceLoader.getSkills().skills).toEqual([]);
		expect(resourceLoader.getPrompts().prompts).toEqual([]);
		expect(resourceLoader.getThemes().themes).toEqual([]);
		expect(resourceLoader.getSystemPrompt()).toBeUndefined();
		expect(resourceLoader.getSystemPromptSource()).toBeUndefined();
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);

		harness = await createHarness({ resourceLoader });
		const target = join(projectDir, "first-task.txt");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: target, content: "hello from task one\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Task complete."),
		]);

		await harness.session.prompt("write hello to first-task.txt");

		const result = getToolResult(harness, "write");
		expect(result.content).toBeTruthy();
		expect(readFileSync(target, "utf-8")).toBe("hello from task one\n");

		// The task ran with the same empty inventory it started with: nothing was installed
		// or required to reach a completed first task.
		expect(resourceLoader.getExtensions().extensions).toEqual([]);
		expect(resourceLoader.getSkills().skills).toEqual([]);
		expect(resourceLoader.getPrompts().prompts).toEqual([]);
		expect(resourceLoader.getThemes().themes).toEqual([]);
		expect(resourceLoader.getSystemPromptSource()).toBeUndefined();
	});
});
