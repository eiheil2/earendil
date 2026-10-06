import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectFirstTaskWorkspace, getFirstTaskTemplate } from "../src/core/first-task-template.ts";
import { loadPromptTemplates } from "../src/core/prompt-templates.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkills } from "../src/core/skills.ts";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("packaged defaults", () => {
	it("lets a same-named user skill and prompt win over the packaged copy", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-defaults-"));
		temporary.push(root);
		const agent = join(root, "agent");
		mkdirSync(join(agent, "skills", "review-workflow"), { recursive: true });
		mkdirSync(join(agent, "prompts"), { recursive: true });
		writeFileSync(
			join(agent, "skills", "review-workflow", "SKILL.md"),
			"---\nname: review-workflow\ndescription: User override\n---\nuser",
		);
		writeFileSync(join(agent, "prompts", "review.md"), "---\ndescription: User prompt\n---\nuser prompt");
		const builtin = join(root, "builtin");
		const skills = loadSkills({
			cwd: root,
			agentDir: agent,
			skillPaths: [],
			includeDefaults: true,
			builtinDefaultsDir: builtin,
		});
		const prompts = loadPromptTemplates({
			cwd: root,
			agentDir: agent,
			promptPaths: [],
			includeDefaults: true,
			builtinDefaultsDir: builtin,
		});
		expect(skills.skills.find((skill) => skill.name === "review-workflow")?.description).toBe("User override");
		expect(prompts.templates.find((prompt) => prompt.name === "review")?.content).toContain("user prompt");
	});

	it("resolves the complete skill precedence chain as project over user over builtin", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-defaults-chain-"));
		temporary.push(root);
		const agent = join(root, "agent");
		const project = join(root, ".pi", "skills", "review-workflow");
		const user = join(agent, "skills", "review-workflow");
		const builtin = join(root, "builtin", "skills", "review-workflow");
		for (const directory of [project, user, builtin]) mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(project, "SKILL.md"),
			"---\nname: review-workflow\ndescription: Project override\n---\nproject",
		);
		writeFileSync(join(user, "SKILL.md"), "---\nname: review-workflow\ndescription: User override\n---\nuser");
		writeFileSync(
			join(builtin, "SKILL.md"),
			"---\nname: review-workflow\ndescription: Builtin default\n---\nbuiltin",
		);
		const result = loadSkills({
			cwd: root,
			agentDir: agent,
			skillPaths: [],
			includeDefaults: true,
			builtinDefaultsDir: join(root, "builtin"),
		});
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]?.description).toBe("Project override");
		expect(result.skills[0]?.filePath).toBe(join(project, "SKILL.md"));
	});

	it("persists the three switches and exposes an immediate effective value", () => {
		const manager = SettingsManager.fromStorage(new InMemorySettingsStorage());
		manager.setBuiltinRules(false);
		manager.setBuiltinSkills(false);
		manager.setBuiltinPrompts(false);
		expect(manager.getBuiltinRules()).toBe(false);
		expect(manager.getBuiltinSkills()).toBe(false);
		expect(manager.getBuiltinPrompts()).toBe(false);
	});

	it("selects a first-task workflow from workspace evidence", () => {
		expect(detectFirstTaskWorkspace("/tmp", () => true)).toBe("git");
		expect(getFirstTaskTemplate("empty").prompt).toContain("empty workspace");
	});
});
