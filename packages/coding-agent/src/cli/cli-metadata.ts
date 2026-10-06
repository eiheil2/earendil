/**
 * Canonical metadata for pi's active CLI surface.
 *
 * This module is the single source of truth the completion generator consumes.
 * It deliberately mirrors what the parser in `args.ts` and the subcommand
 * dispatch sites (`package-manager-cli.ts`, `auth-command.ts`, the `mcp`
 * branch in `main.ts`) accept. The contract test in `test/args.test.ts`
 * asserts every listed root flag parses into its declared `Args` field, so a
 * flag added to the parser without a metadata entry (or vice versa) fails the
 * test suite instead of silently drifting.
 */

export type Shell = "bash" | "zsh" | "fish";

export type FlagKind = "flag" | "value" | "enum" | "list" | "file" | "dir";

export interface RootFlagMeta {
	name: string;
	short?: string;
	description: string;
	kind: FlagKind;
	/** Static candidates for `enum`/`list` kinds. */
	values?: readonly string[];
	repeatable?: boolean;
}

export interface SubcommandMeta {
	name: string;
	description: string;
	aliases?: readonly string[];
	/** Positional argument value kind, if any. */
	positional?: { name: string; kind: "enum" | "file" | "value"; values?: readonly string[] };
}

export const ROOT_FLAGS: readonly RootFlagMeta[] = [
	{ name: "provider", description: "Provider to search for --model", kind: "value" },
	{ name: "model", description: "Model pattern or ID", kind: "value" },
	{ name: "api-key", description: "API key", kind: "value" },
	{ name: "system-prompt", description: "System prompt", kind: "value" },
	{ name: "append-system-prompt", description: "Append to the system prompt", kind: "value", repeatable: true },
	{ name: "mode", description: "Output mode", kind: "enum", values: ["text", "json", "rpc"] },
	{ name: "print", short: "p", description: "Non-interactive mode", kind: "flag" },
	{ name: "continue", short: "c", description: "Continue previous session", kind: "flag" },
	{ name: "resume", short: "r", description: "Select a session to resume", kind: "flag" },
	{ name: "session", description: "Use specific session file or partial UUID", kind: "value" },
	{ name: "session-id", description: "Use exact project session ID", kind: "value" },
	{ name: "fork", description: "Fork specific session", kind: "value" },
	{ name: "session-dir", description: "Directory for session storage", kind: "dir" },
	{ name: "no-session", description: "Don't save session", kind: "flag" },
	{ name: "name", short: "n", description: "Set session display name", kind: "value" },
	{ name: "models", description: "Comma-separated model patterns", kind: "list" },
	{ name: "no-tools", short: "nt", description: "Disable all tools", kind: "flag" },
	{ name: "no-builtin-tools", short: "nbt", description: "Disable built-in tools", kind: "flag" },
	{ name: "tools", short: "t", description: "Comma-separated allowlist of tools", kind: "list" },
	{ name: "exclude-tools", short: "xt", description: "Comma-separated denylist of tools", kind: "list" },
	{
		name: "thinking",
		description: "Thinking level",
		kind: "enum",
		values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	},
	{ name: "extension", short: "e", description: "Load an extension", kind: "file", repeatable: true },
	{ name: "no-extensions", short: "ne", description: "Disable extension discovery", kind: "flag" },
	{ name: "strict-capabilities", description: "Reject mismatched extensions", kind: "flag" },
	{ name: "skill", description: "Load a skill", kind: "file", repeatable: true },
	{ name: "no-skills", short: "ns", description: "Disable skills", kind: "flag" },
	{ name: "prompt-template", description: "Load a prompt template", kind: "file", repeatable: true },
	{ name: "no-prompt-templates", short: "np", description: "Disable prompt templates", kind: "flag" },
	{ name: "theme", description: "Load a theme", kind: "file", repeatable: true },
	{ name: "use-theme", description: "Set the initial theme", kind: "value" },
	{ name: "no-themes", description: "Disable themes", kind: "flag" },
	{ name: "no-context-files", short: "nc", description: "Disable AGENTS.md/CLAUDE.md", kind: "flag" },
	{ name: "export", description: "Export session file to HTML", kind: "value" },
	{ name: "list-models", description: "List available models", kind: "value" },
	{ name: "verbose", description: "Force verbose startup", kind: "flag" },
	{ name: "tui-mode", description: "TUI mode", kind: "enum", values: ["fullscreen", "regular"] },
	{ name: "approve", short: "a", description: "Trust project-local files", kind: "flag" },
	{ name: "no-approve", short: "na", description: "Ignore project-local files", kind: "flag" },
	{ name: "offline", description: "Disable startup network operations", kind: "flag" },
	{ name: "help", short: "h", description: "Show help", kind: "flag" },
	{ name: "version", short: "v", description: "Show version", kind: "flag" },
];

export const SUBCOMMANDS: readonly SubcommandMeta[] = [
	{
		name: "install",
		description: "Install extension source and add to settings",
		positional: { name: "source", kind: "value" },
	},
	{
		name: "remove",
		description: "Remove extension source from settings",
		positional: { name: "source", kind: "value" },
	},
	{ name: "uninstall", description: "Alias for remove", positional: { name: "source", kind: "value" } },
	{
		name: "update",
		description: "Update pi, extensions, or model catalogs",
		positional: { name: "target", kind: "value" },
	},
	{ name: "list", description: "List installed extensions from settings" },
	{ name: "config", description: "Open TUI to enable/disable package resources" },
	{
		name: "auth",
		description: "Print credentials or check provider readiness",
		positional: { name: "command", kind: "value" },
	},
	{
		name: "mcp",
		description: "Check MCP servers, sign in to or out of OAuth servers",
		positional: { name: "command", kind: "value" },
	},
	{
		name: "completions",
		description: "Print a shell completion script",
		positional: { name: "shell", kind: "enum", values: ["bash", "zsh", "fish"] },
	},
];
