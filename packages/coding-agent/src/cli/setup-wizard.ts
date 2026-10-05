/**
 * Setup wizard state: scene order, version gates, and skip/resume gates.
 *
 * Kept free of TUI imports so the cold-launch gate in `startup-ui.ts` can answer
 * "does this install still owe setup scenes?" without pulling in the scene
 * components, selectors, and the model runtime they use.
 */
import { existsSync, readFileSync } from "fs";
import { getSettingsPath } from "../config.ts";
import { stripBom } from "../utils/text.ts";

/**
 * Setup version a completed wizard run advances the install to. Bump it whenever a
 * scene lands or an existing scene raises its `minVersion`. Must equal
 * `max(scene.minVersion)` across `SETUP_SCENES`; the setup tests guard that invariant.
 */
export const CURRENT_SETUP_VERSION = 1;

/** Ordered onboarding scenes: credentials → model → appearance. */
export const SETUP_SCENE_IDS = ["credentials", "model", "appearance"] as const;

export type SetupSceneId = (typeof SETUP_SCENE_IDS)[number];

export interface SetupSceneDescriptor {
	readonly id: SetupSceneId;
	readonly minVersion: number;
}

/** Scene order fixed by AC-B05; every scene ships with the first wizard version. */
export const SETUP_SCENES: readonly SetupSceneDescriptor[] = [
	{ id: "credentials", minVersion: 1 },
	{ id: "model", minVersion: 1 },
	{ id: "appearance", minVersion: 1 },
];

/** What the stored settings file says about onboarding progress. */
export interface SetupState {
	/** Stored setup version. 0 means "no wizard run ever finished". */
	version: number;
	/** Scenes the user explicitly finished or skipped. */
	completedScenes: SetupSceneId[];
}

function isSetupSceneId(value: unknown): value is SetupSceneId {
	return typeof value === "string" && (SETUP_SCENE_IDS as readonly string[]).includes(value);
}

/**
 * Read onboarding progress from the settings file.
 *
 * - No settings file: a fresh install, so version 0.
 * - File with neither setup field: an install that predates the wizard. It is already
 *   configured, so it is treated as current instead of being pushed through scenes.
 * - File with `setupCompletedScenes` but no version: a run that was interrupted after
 *   its first scene, so it resumes at version 0 with those scenes already recorded.
 */
export function readSetupState(settingsPath: string = getSettingsPath()): SetupState {
	if (!existsSync(settingsPath)) {
		return { version: 0, completedScenes: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(settingsPath, "utf-8")));
	} catch {
		// An unreadable settings file must not block startup; the wizard reruns from scratch.
		return { version: 0, completedScenes: [] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { version: 0, completedScenes: [] };
	}
	const raw = parsed as Record<string, unknown>;
	const completedScenes = Array.isArray(raw.setupCompletedScenes)
		? raw.setupCompletedScenes.filter(isSetupSceneId)
		: [];
	const storedVersion = raw.setupVersion;
	const hasVersion = typeof storedVersion === "number" && Number.isSafeInteger(storedVersion) && storedVersion >= 0;
	if (!hasVersion) {
		return completedScenes.length > 0
			? { version: 0, completedScenes }
			: { version: CURRENT_SETUP_VERSION, completedScenes: [] };
	}
	return { version: storedVersion, completedScenes };
}

/** `PI_SKIP_SETUP` truthiness: unset stays enabled, "0"/"false"/"no" disable the skip. */
export function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/** Environment and invocation gates for onboarding scene selection. */
export interface SetupSceneSelectionOptions {
	/** `--continue` / `--resume` puts the user back into a session, not into setup. */
	resuming?: boolean;
	/** Defaults to `stdin` and `stdout` both being TTYs. */
	isTTY?: boolean;
	/** Defaults to the `PI_SKIP_SETUP` environment variable. */
	skipEnv?: string | undefined;
}

/** Scenes still owed by this install, honoring the TTY, skip, and resume gates (AC-B02/B03/B04). */
export function selectSetupScenes(
	state: SetupState,
	options: SetupSceneSelectionOptions = {},
	scenes: readonly SetupSceneDescriptor[] = SETUP_SCENES,
): SetupSceneDescriptor[] {
	const isTTY = options.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
	if (!isTTY) return [];
	if (options.resuming) return [];
	if (setupSkipEnvEnabled(options.skipEnv ?? process.env.PI_SKIP_SETUP)) return [];
	const completed = new Set(state.completedScenes);
	return scenes.filter((scene) => scene.minVersion > state.version && !completed.has(scene.id));
}
