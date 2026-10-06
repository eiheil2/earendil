import { existsSync } from "node:fs";
import { join } from "node:path";

export type FirstTaskWorkspaceKind = "git" | "node" | "empty" | "workspace";

export interface FirstTaskTemplate {
	kind: FirstTaskWorkspaceKind;
	title: string;
	prompt: string;
}

export function detectFirstTaskWorkspace(
	cwd: string,
	isGit: (directory: string) => boolean = () => false,
): FirstTaskWorkspaceKind {
	if (isGit(cwd)) return "git";
	if (existsSync(join(cwd, "package.json"))) return "node";
	if (existsSync(join(cwd, ".pi")) || existsSync(join(cwd, "src"))) return "workspace";
	return "empty";
}

export function getFirstTaskTemplate(kind: FirstTaskWorkspaceKind): FirstTaskTemplate {
	switch (kind) {
		case "git":
			return {
				kind,
				title: "Understand this repository",
				prompt:
					"Inspect the repository structure and git status, then summarize the project and suggest the safest first change.",
			};
		case "node":
			return {
				kind,
				title: "Understand this Node project",
				prompt:
					"Read package.json and the project entry points, then explain how to run its checks and identify one useful next task.",
			};
		case "workspace":
			return {
				kind,
				title: "Explore this workspace",
				prompt:
					"Inspect the existing source and configuration files, then summarize what this workspace does and propose a focused next task.",
			};
		default:
			return {
				kind,
				title: "Start a new project",
				prompt:
					"Ask what the user wants to build, inspect the empty workspace, and propose a small first milestone before creating files.",
			};
	}
}
