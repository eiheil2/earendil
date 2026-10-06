/**
 * Destructive-operation confirmation (AC-D06) and the permission/sandbox boundary shown on
 * the startup screen (AC-D07).
 *
 * Ported from omp `examples/hooks/permission-gate.ts` (dangerous bash patterns confirmed
 * before the call runs) and `examples/hooks/confirm-destructive.ts` (confirm + cancel
 * notice before a destructive session action), plus the three-tier permission presets of
 * the frozen DSH repo `packages/interaction/permission-presets/src/index.ts`, whose default
 * table ships `workspace-write` (workspace-write + ask) and `danger-full-access`
 * (danger-full-access + never) with the descriptions reused verbatim here. The third tier,
 * `read-only`, comes from DSH's `SANDBOX_MODES` with `read-only` as the fail-safe default.
 *
 * pi ships no OS sandbox: the README section "Permissions & Containerization" states that
 * pi "does not include a built-in permission system ... it runs with the permissions of the
 * user and process that launched it". The presets therefore differ in *approval* behavior
 * (what pi asks about before acting), not in enforced filesystem scope, and
 * `permissionBoundaryLines` says exactly that on the first screen instead of leaving the
 * boundary in the README.
 *
 * This module stays free of imports so both `settings-manager` (which stores the preset) and
 * the interactive UI (which renders and enforces it) can depend on it.
 */

export type PermissionPresetName = "read-only" | "workspace-write" | "danger-full-access";

/** DSH's sandbox knob; recorded for parity, not enforced by pi (no OS sandbox). */
export type SandboxMode = PermissionPresetName;

/** DSH's approval knob: does pi stop and ask before a destructive command runs? */
export type ApprovalPolicy = "ask" | "never";

/**
 * Which shell commands the preset sends through the confirmation dialog:
 * - `all`: every command (the read-only posture: nothing mutates without approval)
 * - `destructive`: only commands matching {@link isDestructiveCommand}
 * - `none`: never (DSH's `danger-full-access` + `never` bundle)
 */
export type ConfirmScope = "all" | "destructive" | "none";

export interface PermissionPreset {
	readonly name: PermissionPresetName;
	readonly sandbox: SandboxMode;
	readonly approval: ApprovalPolicy;
	readonly confirm: ConfirmScope;
	/** One user-facing sentence on what the preset means. */
	readonly description: string;
}

/**
 * The three-tier permission table. `workspace-write` and `danger-full-access` carry DSH's
 * own description strings; `read-only` states what pi actually enforces.
 */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
	{
		name: "read-only",
		sandbox: "read-only",
		approval: "ask",
		confirm: "all",
		description:
			"Ask before every shell command. pi has no OS sandbox, so this preset is confirmation-only: " +
			"commands still run with your user's permissions once approved.",
	},
	{
		name: "workspace-write",
		sandbox: "workspace-write",
		approval: "ask",
		confirm: "destructive",
		description:
			"Write inside the working directory and permitted temporary directories; destructive commands require approval.",
	},
	{
		name: "danger-full-access",
		sandbox: "danger-full-access",
		approval: "never",
		confirm: "none",
		description: "Full file access without approval prompts.",
	},
];

/** DSH's `defaultPreset` analogue. */
export const DEFAULT_PERMISSION_PRESET: PermissionPresetName = "workspace-write";

/** Resolve a stored preset name; an unknown or missing value falls back to the default. */
export function resolvePermissionPreset(name: string | undefined): PermissionPreset {
	const preset = PERMISSION_PRESETS.find((entry) => entry.name === name);
	return preset ?? (PERMISSION_PRESETS.find((entry) => entry.name === DEFAULT_PERMISSION_PRESET) as PermissionPreset);
}

/**
 * Commands that destroy data or escalate privilege. These come from omp's
 * `examples/hooks/permission-gate.ts` set - `sudo`, `chmod/chown 777` verbatim, and the rm
 * pattern widened from `(-rf?|--recursive)` to `(-[a-z]*r|--recursive)` so the flag order
 * `rm -fr` is caught too; the rest cover the destructive git and Windows shell equivalents
 * pi's `!` line accepts.
 */
export const DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[a-z]*r|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[a-z]*f/i,
	/\bgit\s+push\b.*--force\b/i,
	/\bmkfs(\.\w+)?\b/i,
	/\bdd\b[^|;&]*\bof=/i,
	/\bRemove-Item\b[^|;&]*-(Recurse|Force)/i,
	/\bdel\b[^|;&]*\/[a-z]*f/i,
];

/** Whether a shell command matches one of the destructive patterns. */
export function isDestructiveCommand(command: string): boolean {
	if (command.trim().length === 0) return false;
	return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export interface ConfirmationPolicy {
	/** The settings switch behind the one-click opt-out (AC-D06). Default: true. */
	readonly confirmDestructive: boolean;
	/** Preset name; unknown values resolve to the default. */
	readonly preset?: string;
}

/**
 * Whether the interactive `!` line must stop for a Yes/No answer before running `command`.
 *
 * `confirmDestructive: false` is the one-click off switch and wins over the preset, so a
 * user who disables confirmation is never re-prompted by a preset change.
 */
export function requiresConfirmation(command: string, policy: ConfirmationPolicy): boolean {
	if (!policy.confirmDestructive) return false;
	const preset = resolvePermissionPreset(policy.preset);
	if (preset.confirm === "none") return false;
	if (preset.confirm === "all") return command.trim().length > 0;
	return isDestructiveCommand(command);
}

/** Where the switch lives, quoted the same way in both notice variants. */
export const CONFIRM_SETTING_HINT = `Settings -> "Destructive confirmation" (or "confirmDestructive": false in settings.json)`;

/**
 * The sentence shown before the first confirmation of an install, and the short reminder
 * shown afterwards (AC-D06: tell the user how confirmation works *before* it first runs).
 */
export function confirmationMechanismNotice(options: { firstTime: boolean; preset: PermissionPresetName }): string {
	const presetLine = `Permission preset: ${options.preset}.`;
	if (!options.firstTime) {
		return `${presetLine} Confirmation runs before destructive commands; turn it off in ${CONFIRM_SETTING_HINT}.`;
	}
	return (
		`${presetLine} Destructive commands are confirmed before they run: answer "Yes" to allow this one ` +
		`command, "No" to cancel it. This is the first confirmation you have seen. ` +
		`Turn it off in ${CONFIRM_SETTING_HINT}, or switch the preset to danger-full-access.`
	);
}

export interface PermissionBoundaryInput {
	readonly preset: PermissionPresetName;
	readonly confirmDestructive: boolean;
	/** Absolute working directory the session runs in. */
	readonly cwd: string;
}

/**
 * The first-screen permission/sandbox boundary (AC-D07): three short, checkable statements
 * that replace "it is only written in the README" with something the user sees on launch.
 */
export function permissionBoundaryLines(input: PermissionBoundaryInput): string[] {
	const preset = resolvePermissionPreset(input.preset);
	const confirmState = input.confirmDestructive && preset.confirm !== "none" ? "on" : "off";
	return [
		`Permissions: preset "${preset.name}" (confirmation ${confirmState}) - ${preset.description}`,
		`Sandbox: no built-in OS sandbox - commands run with your user's permissions in ${input.cwd}; ` +
			"containerize pi for stronger boundaries (README: Permissions & Containerization).",
		"Boundaries that do apply: destructive shell commands are confirmed, and project-local skills, prompts and " +
			"extensions stay unloaded until this project is trusted.",
	];
}
