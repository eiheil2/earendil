/**
 * Startup self-check card (AC-D01): fd / rg / git / network / terminal colors / working
 * directory writability, each in one of three states - `ready`, `degraded` (with the
 * concrete loss spelled out) or `blocked` (with the exact command that fixes it).
 *
 * Two cross-batch behaviors live here:
 * - AC-D03: in offline mode the network check degrades *and* enumerates the capabilities
 *   that are unavailable because of it, instead of a single warning line.
 * - AC-D04: on Android/Termux the fd/rg checks carry the exact `pkg install ...` command,
 *   taken from `termuxInstallCommand` next to the download skip that needs it.
 *
 * fd/rg detection reuses `getToolPath` from `utils/tools-manager.ts`, the same lookup
 * `ensureTool` uses before it downloads (AC-D02 baseline), so the card reports the state the
 * user will actually get. The git / terminal-colors / writability checks mirror
 * `cli/doctor-command.ts` `collectSelfChecks` (that file is another batch's, read-only here)
 * but keep their own copy because the doctor version has no Termux or offline handling and
 * probes the network for 5s instead of the 2s a startup screen may spend.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { APP_NAME } from "../config.ts";
import { getToolPath, isOfflineModeEnabled, termuxInstallCommand } from "../utils/tools-manager.ts";

export type SelfCheckState = "ready" | "degraded" | "blocked";

export type SelfCheckId = "fd" | "rg" | "git" | "network" | "terminal-colors" | "cwd";

export interface StartupSelfCheck {
	readonly id: SelfCheckId;
	/** Short card label, stable across states. */
	readonly label: string;
	readonly state: SelfCheckState;
	/** What is true right now. Never a remedy. */
	readonly detail: string;
	/** degraded only: what the user loses while the item is not ready. */
	readonly loss?: string;
	/** The exact command that fixes or works around the item. */
	readonly fix?: string;
}

export interface StartupSelfCheckOptions {
	cwd?: string;
	/** Defaults to `isOfflineModeEnabled()`. */
	offline?: boolean;
	/** Defaults to `process.platform`. Injected so tests cover Termux without an Android host. */
	platform?: string;
	/** Network probe; defaults to `startNetworkProbe`. Injected so tests never touch the network. */
	probeNetwork?: () => Promise<void>;
	/** fd/rg lookup; defaults to the `getToolPath` used by the AC-D02 download path. */
	toolPath?: (tool: "fd" | "rg") => string | null;
}

/**
 * What stops working without a network, listed on the card whenever the network check is not
 * ready (AC-D03). Each entry maps to a real guard:
 * - tool auto-download: `utils/tools-manager.ts` `ensureTool` returns early when offline
 * - model catalog refresh: `core/model-runtime.ts` disables network refresh when PI_OFFLINE
 *   is set, and `interactive-mode.ts` skips `refreshModelCatalogs`
 * - new-version check: `utils/version-check.ts` returns early when PI_OFFLINE is set
 * - package install/update: `core/package-manager.ts` `isOfflineModeEnabled`
 * - package update notices: `interactive-mode.ts` `checkForPackageUpdates` returns early
 * - install telemetry and `/bug` upload: `interactive-mode.ts` `reportInstallTelemetry`,
 *   `modes/interactive/bug-report.ts`
 */
export const OFFLINE_LOST_CAPABILITIES: readonly string[] = [
	"fd/rg auto-download (find and grep need a local install instead)",
	"model catalog refresh (new providers and models are not picked up)",
	"new-version check and package update notices",
	"extension/skill/prompt/theme package install and update",
	"install telemetry and /bug upload",
	"provider sign-in and token refresh",
];

/** Startup probes are short, credential-free and never call an API (AC-D01 network item). */
export const NETWORK_PROBE_URL = "https://pi.dev/";
export const NETWORK_PROBE_TIMEOUT_MS = 2_000;

/**
 * Start the network probe early so it overlaps with the tool checks. Sends one HEAD request
 * with no credentials and no authorization header, and gives up after
 * {@link NETWORK_PROBE_TIMEOUT_MS}; any HTTP answer (including 4xx/5xx) counts as reachable,
 * only a transport failure does not.
 */
export function startNetworkProbe(url: string = NETWORK_PROBE_URL): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error(`no response within ${NETWORK_PROBE_TIMEOUT_MS}ms`)),
		NETWORK_PROBE_TIMEOUT_MS,
	);
	return fetch(url, { method: "HEAD", redirect: "manual", credentials: "omit", signal: controller.signal })
		.then(() => undefined)
		.finally(() => clearTimeout(timeout));
}

/** Copy-pasteable install commands per platform; mirrors `cli/doctor-command.ts` `packageHints`. */
function installFixCommand(id: "fd" | "rg" | "git", plat: string): string {
	if (id !== "git") {
		const termux = termuxInstallCommand(id, plat);
		if (termux) return termux;
	}
	if (plat === "win32") {
		return id === "fd"
			? "winget install sharkdp.fd"
			: id === "rg"
				? "winget install BurntSushi.ripgrep.MSVC"
				: "winget install Git.Git";
	}
	if (plat === "darwin") {
		return id === "fd" ? "brew install fd" : id === "rg" ? "brew install ripgrep" : "brew install git";
	}
	return id === "fd" ? "sudo apt install fd-find" : id === "rg" ? "sudo apt install ripgrep" : "sudo apt install git";
}

function checkTool(id: "fd" | "rg", label: string, options: StartupSelfCheckOptions): StartupSelfCheck {
	const toolPath = (options.toolPath ?? getToolPath)(id);
	if (toolPath) {
		return { id, label, state: "ready", detail: toolPath };
	}
	const plat = options.platform ?? osPlatform();
	const offline = options.offline ?? isOfflineModeEnabled();
	let detail: string;
	if (plat === "android") {
		detail = `${label} is not installed; the downloaded glibc binary cannot run on Termux`;
	} else if (offline) {
		detail = `${label} is not installed and offline mode skips the automatic download`;
	} else {
		detail = `${label} is not installed and the automatic download did not complete`;
	}
	return {
		id,
		label,
		state: "degraded",
		detail,
		loss:
			id === "fd"
				? "@file autocomplete and the find tool are unavailable"
				: "the grep tool and every rg-based search are unavailable",
		fix: installFixCommand(id, plat),
	};
}

function checkGit(plat: string): StartupSelfCheck {
	const result = spawnSync("git", ["--version"], { stdio: "pipe", timeout: 5_000 });
	const version = result.stdout?.toString().trim();
	if (!result.error && result.status === 0 && version) {
		return { id: "git", label: "git", state: "ready", detail: version };
	}
	const reason = result.error ? result.error.message : `exit code ${result.status ?? "unknown"}`;
	return {
		id: "git",
		label: "git",
		state: "degraded",
		detail: `git is not runnable (${reason})`,
		loss: "session diffs, update checks, and git-sourced packages are unavailable",
		fix: installFixCommand("git", plat),
	};
}

function offlineLoss(): string {
	return `unavailable offline: ${OFFLINE_LOST_CAPABILITIES.join("; ")}`;
}

async function checkNetwork(options: StartupSelfCheckOptions): Promise<StartupSelfCheck> {
	const offline = options.offline ?? isOfflineModeEnabled();
	if (offline) {
		return {
			id: "network",
			label: "network",
			state: "degraded",
			detail: "offline mode (PI_OFFLINE or --offline) is on, so connectivity was not tested",
			loss: offlineLoss(),
			fix: `unset PI_OFFLINE and restart ${APP_NAME} to re-enable them`,
		};
	}
	try {
		await (options.probeNetwork ?? startNetworkProbe)();
		return { id: "network", label: "network", state: "ready", detail: `reachable (HEAD ${NETWORK_PROBE_URL})` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			id: "network",
			label: "network",
			state: "degraded",
			detail: `unreachable: ${message}`,
			loss: offlineLoss(),
			fix: "check network or proxy settings, then restart to re-enable them",
		};
	}
}

function checkTerminalColors(plat: string): StartupSelfCheck {
	if (process.env.NO_COLOR !== undefined) {
		return {
			id: "terminal-colors",
			label: "terminal colors",
			state: "ready",
			detail: "NO_COLOR is set: color is off by user choice",
		};
	}
	const term = process.env.TERM;
	if (plat === "win32" || process.env.COLORTERM || (term && term !== "dumb")) {
		return {
			id: "terminal-colors",
			label: "terminal colors",
			state: "ready",
			detail: `TERM=${term ?? "(unset)"} COLORTERM=${process.env.COLORTERM ?? "(unset)"}`,
		};
	}
	return {
		id: "terminal-colors",
		label: "terminal colors",
		state: "degraded",
		detail: `TERM=${term ?? "(unset)"} reports no color support`,
		loss: "themes render without color",
		fix: `Set TERM before starting ${APP_NAME}, for example export TERM=xterm-256color`,
	};
}

function checkCwd(cwd: string, plat: string): StartupSelfCheck {
	const writable = (path: string): boolean => {
		try {
			accessSync(path, constants.W_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (existsSync(cwd)) {
		if (writable(cwd)) {
			return { id: "cwd", label: "working directory", state: "ready", detail: `${cwd} (writable)` };
		}
		return {
			id: "cwd",
			label: "working directory",
			state: "blocked",
			detail: `${cwd} is not writable for the current user`,
			fix:
				plat === "win32"
					? `icacls "${cwd}" /grant %USERNAME%:F`
					: `chmod u+w "${cwd}"  # or: sudo chown "$USER" "${cwd}"`,
		};
	}
	return {
		id: "cwd",
		label: "working directory",
		state: "blocked",
		detail: `${cwd} does not exist and cannot be created`,
		fix: `mkdir -p "${cwd}"`,
	};
}

/**
 * Run the six startup checks in AC order. Never throws: a check that cannot run degrades
 * with a remedy instead, so the card always renders.
 */
export async function runStartupSelfChecks(options: StartupSelfCheckOptions = {}): Promise<StartupSelfCheck[]> {
	const cwd = options.cwd ?? process.cwd();
	const plat = options.platform ?? osPlatform();
	return [
		checkTool("fd", "fd", options),
		checkTool("rg", "rg", options),
		checkGit(plat),
		await checkNetwork(options),
		checkTerminalColors(plat),
		checkCwd(cwd, plat),
	];
}

export interface SelfCheckSummary {
	ready: number;
	degraded: number;
	blocked: number;
}

export function summarizeSelfChecks(checks: readonly StartupSelfCheck[]): SelfCheckSummary {
	const summary: SelfCheckSummary = { ready: 0, degraded: 0, blocked: 0 };
	for (const check of checks) summary[check.state] += 1;
	return summary;
}

/** Whether the card must be visible even in quiet mode: a blocked check always is. */
export function hasBlockedSelfCheck(checks: readonly StartupSelfCheck[]): boolean {
	return checks.some((check) => check.state === "blocked");
}
