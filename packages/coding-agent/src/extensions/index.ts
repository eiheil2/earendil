import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import fsVersionedExtension from "./fs-versioned/index.ts";
import hashlineExtension from "./hashline/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import mcpDshExtension from "./mcp-dsh/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// Declares MCP servers in DSH's stdio shape through pi.registerMcpServer(); the mcp extension
	// connects them. Without configured servers it registers nothing.
	{ name: "mcp-dsh", factory: mcpDshExtension, builtin: true },
	// Versioned fs.stat/fs.write tools (Phase 2 ctx.fs cap). Tools register inactive; activate
	// with --tools, the defaultTools setting, or setActiveTools().
	{ name: "fs-versioned", factory: fsVersionedExtension, replaceable: true, builtin: true },
	// hashline-edit tool (Phase 2 hashline cap, pure-TS port of OMP pi-edit). Registers inactive
	// by default; pairs with (does not replace) the built-in edit tool.
	{ name: "hashline", factory: hashlineExtension, replaceable: true, builtin: true },
];
