/**
 * Tool definitions for the versioned filesystem tools (`fs.stat`,
 * `fs.write`). Both take an already-resolved absolute path from
 * `resolveToCwd` and delegate storage to a {@link VersionedFsBackend}.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionToolContext, ToolDefinition } from "../../core/extensions/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import type { VersionedFsBackend } from "./backend.ts";
import type { FsInfo, FsObservation, FsWriteOutcome } from "./types.ts";

const fsStatSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to observe (relative or absolute)" }),
	},
	{},
);

const createIfAbsentIntentSchema = Type.Object(
	{
		kind: Type.Literal("createIfAbsent"),
	},
	{ description: "Write only when the target does not exist. Rejected with FS_NOT_OBSERVED when it does." },
);

const replaceIfVersionIntentSchema = Type.Object(
	{
		kind: Type.Literal("replaceIfVersion"),
		version: Type.String({
			description:
				"Version token from the latest fs.stat observation of this path. The write is rejected with FS_STALE_VERSION when the file changed since.",
		}),
	},
	{ description: "Write only when the file still has the given version." },
);

const fsWriteSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
		content: Type.String({ description: "Full file content to write" }),
		intent: Type.Optional(
			Type.Union([createIfAbsentIntentSchema, replaceIfVersionIntentSchema], {
				description: "Guarded write. Omit for an unconditional create-or-overwrite.",
			}),
		),
	},
	{},
);

const fsStatOutputSchema = Type.Object(
	{
		path: Type.String(),
		kind: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
		version: Type.Optional(Type.String()),
		type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("other")])),
		size: Type.Optional(Type.Number()),
	},
	{},
);

const fsWriteOutputSchema = Type.Object(
	{
		path: Type.String(),
		operation: Type.Union([Type.Literal("create"), Type.Literal("update")]),
		version: Type.String(),
	},
	{},
);

export type FsStatInput = Static<typeof fsStatSchema>;
export type FsWriteInput = Static<typeof fsWriteSchema>;
export type FsStatOutput = Static<typeof fsStatOutputSchema>;
export type FsWriteOutput = Static<typeof fsWriteOutputSchema>;

export interface FsStatDetails {
	/** Path resolved against the session cwd */
	path: string;
	/** Present/absent observation; the version to guard a later fs.write on */
	observation: FsObservation;
	/** Target type, present when the observation is present */
	type?: FsInfo["type"];
	/** Byte size of a regular file, when known */
	size?: number;
}

export interface FsWriteDetails extends FsWriteOutcome {
	/** Path resolved against the session cwd */
	path: string;
}

function statText(path: string, observation: FsObservation, info: FsInfo | undefined): string {
	if (observation.kind === "absent") return `${path} does not exist`;
	const parts = [`${path} exists`, `type: ${info?.type ?? "file"}`, `version: ${observation.version}`];
	if (info?.size !== undefined) parts.push(`size: ${info.size} bytes`);
	return parts.join(", ");
}

/**
 * `fs.stat`: observe a file and get its version token, the freshness
 * token a later `fs.write` guards on with `replaceIfVersion`.
 */
export function createFsStatToolDefinition(
	backend: VersionedFsBackend,
): ToolDefinition<typeof fsStatSchema, FsStatDetails> {
	return {
		name: "fs.stat",
		label: "fs.stat",
		description:
			"Observe a file and report whether it exists, its type and size, and its version token. The version token guards a later fs.write with replaceIfVersion.",
		promptSnippet: "Observe file state and get its version token for guarded writes",
		promptGuidelines: ["Call fs.stat before fs.write with replaceIfVersion to obtain the current version token"],
		parameters: fsStatSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		outputSchema: fsStatOutputSchema,
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(
			_toolCallId: string,
			input: FsStatInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<FsStatDetails> | undefined,
			ctx: ExtensionToolContext | undefined,
		): Promise<AgentToolResult<FsStatDetails>> {
			if (signal?.aborted) throw new Error("Operation aborted");
			const absolutePath = resolveToCwd(input.path, ctx?.cwd || process.cwd());
			const info = await backend.stat(absolutePath);
			const observation: FsObservation =
				info === undefined ? { kind: "absent" } : { kind: "present", version: info.version };
			const details: FsStatDetails = {
				path: absolutePath,
				observation,
				type: info?.type,
				size: info?.size,
			};
			const version = observation.kind === "present" ? observation.version : undefined;
			const structuredContent: FsStatOutput = {
				path: input.path,
				kind: observation.kind,
				version,
				type: info?.type,
				size: info?.size,
			};
			return {
				content: [{ type: "text", text: statText(input.path, observation, info) }],
				details,
				structuredContent,
			};
		},
	};
}

/**
 * `fs.write`: write full file content, optionally guarded by an
 * intent. `createIfAbsent` writes only new files;
 * `replaceIfVersion` writes only when the file still has the version
 * token from a prior `fs.stat`.
 */
export function createFsWriteToolDefinition(
	backend: VersionedFsBackend,
): ToolDefinition<typeof fsWriteSchema, FsWriteDetails> {
	return {
		name: "fs.write",
		label: "fs.write",
		description:
			"Write full file content. With intent createIfAbsent, writes only when the file does not exist. With intent replaceIfVersion, writes only when the file still has the version token from a prior fs.stat; otherwise the call fails with FS_STALE_VERSION. Without intent, unconditionally creates or overwrites.",
		promptSnippet: "Write file content with optional version guards (createIfAbsent, replaceIfVersion)",
		promptGuidelines: [
			"Call fs.stat first to get the current version, then fs.write with replaceIfVersion to avoid clobbering concurrent changes",
			"A rejected replaceIfVersion (FS_STALE_VERSION) means the file changed: re-run fs.stat and retry with the new version",
		],
		parameters: fsWriteSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		outputSchema: fsWriteOutputSchema,
		annotations: { destructiveHint: true, idempotentHint: true },
		async execute(
			_toolCallId: string,
			input: FsWriteInput,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<FsWriteDetails> | undefined,
			ctx: ExtensionToolContext | undefined,
		): Promise<AgentToolResult<FsWriteDetails>> {
			if (signal?.aborted) throw new Error("Operation aborted");
			const absolutePath = resolveToCwd(input.path, ctx?.cwd || process.cwd());
			const outcome: FsWriteOutcome = await backend.writeText(absolutePath, input.content, input.intent);
			return {
				content: [
					{
						type: "text",
						text: `${outcome.operation === "create" ? "Created" : "Replaced"} ${input.path} (version ${outcome.version})`,
					},
				],
				details: { ...outcome, path: absolutePath },
				structuredContent: {
					path: input.path,
					operation: outcome.operation,
					version: outcome.version,
				},
			};
		},
	};
}
