/**
 * Hashline single-file edit tool.
 *
 * Pure-TypeScript port of the OMP `crates/pi-edit` hashline engine
 * (方案 A): parses `[PATH#TAG]` sections of `PUT`/`CUT`/`REM`/`MV` ops,
 * validates the snapshot tag against current content, applies the edit,
 * and writes back. Pairs with the existing `edit` tool rather than
 * replacing it.
 *
 * The tree-sitter block resolver (`PUT N*:`, `CUT N*`, `PUT >N*`) and
 * the syntax-probing boundary repair are not ported: unified pi ships no
 * tree-sitter runtime. Those ops fail with a clear unresolved-block
 * diagnostic (see PHASE2-HASHLINE.md).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ExtensionToolContext,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { Patch } from "./input.ts";
import { stagePatch } from "./patcher.ts";
import { EditStore } from "./store.ts";

export { applyEdits } from "./apply.ts";
export { fileHash, payloadHash } from "./hash.ts";
export { Patch } from "./input.ts";
export { parsePatch, parsePatchStreaming } from "./parser.ts";
export { EditStore } from "./store.ts";

const hashlineSchema = Type.Object(
	{
		input: Type.String({
			description:
				"Hashline patch: `[PATH#TAG]` section header followed by `PUT N.=M:` / `CUT N.=M` / `PUT <N:` / `PUT >N:` / `REM` / `MV DEST` ops and `+TEXT` body rows. `TAG` must be the 4-hex snapshot from the latest read.",
		}),
	},
	{},
);

type HashlineInput = Static<typeof hashlineSchema>;

export interface HashlineDetails {
	sections: Array<{ path: string; op: string; warnings: string[] }>;
}

export function createHashlineToolDefinition(store: EditStore): ToolDefinition<typeof hashlineSchema, HashlineDetails> {
	return {
		name: "hashline-edit",
		label: "hashline-edit",
		description:
			"Edit files with content-hash-anchored line operations (`[PATH#TAG]` + PUT/CUT/REM/MV). The TAG is a 4-hex snapshot from the latest read; a stale tag is rejected.",
		promptSnippet: "Edit files via hashline line-anchored ops",
		promptGuidelines: [
			"Use hashline-edit with the 4-hex tag from the most recent read output for the file",
			"PUT N.=M: replaces lines N through M with the +TEXT body rows; CUT N.=M deletes them; MV moves the file",
		],
		parameters: hashlineSchema,
		annotations: { destructiveHint: true },
		async execute(
			_toolCallId: string,
			input: HashlineInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<HashlineDetails> | undefined,
			ctx: ExtensionToolContext | undefined,
		): Promise<AgentToolResult<HashlineDetails>> {
			if (signal?.aborted) throw new Error("Operation aborted");
			const cwd = ctx?.cwd || process.cwd();
			const patch = Patch.parse(input.input, { cwd, path: undefined });
			if (patch.sections.length === 0) throw new Error("No hashline sections found in input.");
			const { staged, clipboard } = stagePatch(patch, store, cwd, input.input, false);
			store.commitClipboard(clipboard);
			const sections: HashlineDetails["sections"] = [];
			const lines: string[] = [];
			for (const item of staged) {
				const absolute = path.isAbsolute(item.path) ? item.path : path.resolve(cwd, item.path);
				switch (item.op) {
					case "delete":
						rmSync(absolute, { force: true });
						store.invalidate(absolute);
						sections.push({ path: item.path, op: "delete", warnings: item.warnings });
						lines.push(`Deleted ${item.path}`);
						break;
					case "move": {
						if (item.moveTo === undefined) throw new Error(`Missing MV destination for ${item.path}.`);
						const dest = item.moveTo;
						mkdirSync(path.dirname(dest), { recursive: true });
						writeFileSync(dest, (item.bom ? "\uFEFF" : "") + item.text, "utf8");
						rmSync(absolute, { force: true });
						store.invalidate(absolute);
						store.relocate(absolute, dest);
						store.record(dest, item.text, undefined);
						sections.push({ path: item.path, op: "move", warnings: item.warnings });
						lines.push(`Moved ${item.path} to ${item.moveTo}`);
						break;
					}
					case "noop":
						sections.push({ path: item.path, op: "noop", warnings: item.warnings });
						lines.push(`No change to ${item.path}: body row(s) are byte-identical to the file.`);
						break;
					case "update":
						writeFileSync(absolute, (item.bom ? "\uFEFF" : "") + item.text, "utf8");
						store.record(absolute, item.text, undefined);
						sections.push({ path: item.path, op: "update", warnings: item.warnings });
						lines.push(`Updated ${item.path}`);
						break;
				}
				for (const warning of item.warnings) lines.push(`warning: ${warning}`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { sections },
			};
		},
	};
}

export interface HashlineExtensionOptions {
	store?: EditStore;
	defaultActive?: boolean;
}

export function createHashlineExtension(options: HashlineExtensionOptions = {}): ExtensionFactory {
	const store = options.store ?? new EditStore();
	const defaultActive = options.defaultActive ?? false;
	return (pi: ExtensionAPI) => {
		pi.registerTool({ ...createHashlineToolDefinition(store), defaultActive });
	};
}

export default createHashlineExtension();
