/**
 * `pi doctor` — one pasteable diagnostic package (AC-F01).
 *
 * The report carries the version and install method, the self-check results,
 * the loaded resource inventory, and the tail of recent errors, preceded by
 * the credential-redaction guarantee stated in the package itself (AC-F02).
 *
 * The report goes to stdout because it is the requested output; anything the
 * command itself fails to do goes through `reportUserError`, which writes to
 * stderr and mirrors into the rotating structured log (AC-F06).
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import {
	APP_NAME,
	detectInstallMethod,
	getAgentDir,
	getAuthPath,
	getBinDir,
	getPackageDir,
	VERSION,
} from "../config.ts";
import { readCrashLog } from "../core/crash-log.ts";
import type { ResourceDiagnostic } from "../core/diagnostics.ts";
import {
	type ErrorRemedy,
	formatCauseChain,
	formatRemedy,
	HELP_REMEDY,
	reportUserError,
} from "../core/error-render.ts";
import { credentialEnvNames, redactSecrets } from "../core/redact.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { DIAGNOSTICS_WARNING } from "../core/startup-diagnostics.ts";
import { readStructuredLogTail } from "../core/structured-log.ts";
import { getToolPath } from "../utils/tools-manager.ts";
import { type DoctorInvocation, doctorUsage } from "./doctor-args.ts";

export type CheckStatus = "ok" | "degraded" | "blocked";

/**
 * One self-check result. Every non-ok state carries its remedy, so a report
 * never shows a problem without saying what to do about it (AC-F07).
 */
export type SelfCheck =
	| { id: string; status: "ok"; detail: string }
	| { id: string; status: "degraded" | "blocked"; detail: string; remedy: ErrorRemedy };

export interface SettingsErrorReport {
	scope?: string;
	path?: string;
	message: string;
}

export interface SelfCheckOptions {
	cwd?: string;
	agentDir?: string;
	offline?: boolean;
	/** Global settings path, used in the settings check detail. */
	settingsPath?: string;
	/** Network probe; defaults to a HEAD request. Injected so tests stay offline. */
	probeNetwork?: () => Promise<void>;
	/** Settings parse errors, supplied after the resource loader drained them. */
	settingsErrors?: readonly SettingsErrorReport[];
}

export interface ResourceEntry {
	label: string;
	scope?: string;
}

export interface ResourceInventory {
	projectTrusted: boolean;
	extensions: ResourceEntry[];
	extensionErrors: Array<{ path: string; error: string }>;
	extensionWarnings: Array<{ path: string; warning: string }>;
	skills: ResourceEntry[];
	prompts: ResourceEntry[];
	themes: ResourceEntry[];
	contextFiles: string[];
	diagnostics: ResourceDiagnostic[];
}

export interface DoctorReportInput {
	generatedAt: Date;
	version: string;
	installMethod: string;
	packageDir: string;
	nodeVersion: string;
	platform: string;
	arch: string;
	cwd: string;
	agentDir: string;
	offline: boolean;
	settingsPath: string;
	checks: SelfCheck[];
	resources: ResourceInventory;
	recentErrors: readonly string[];
	crashes: ReturnType<typeof readCrashLog>;
}

/** Copy-pasteable install commands for the tools a self-check can miss. */
function packageHints(): Record<"fd" | "rg" | "git" | "node", string> {
	if (process.platform === "win32") {
		return {
			fd: "winget install sharkdp.fd",
			rg: "winget install BurntSushi.ripgrep.MSVC",
			git: "winget install Git.Git",
			node: "winget install OpenJS.NodeJS.LTS",
		};
	}
	if (process.platform === "darwin") {
		return { fd: "brew install fd", rg: "brew install ripgrep", git: "brew install git", node: "brew install node" };
	}
	return {
		fd: "sudo apt install fd-find",
		rg: "sudo apt install ripgrep",
		git: "sudo apt install git",
		node: "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install nodejs",
	};
}

function isTruthyFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return value === "1" || normalized === "true" || normalized === "yes";
}

function isWritable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Nearest existing ancestor of `path`, used when the directory is not created yet. */
function firstExistingAncestor(path: string): string {
	let current = path;
	for (;;) {
		if (existsSync(current)) return current;
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

function checkRuntime(): SelfCheck {
	const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
	const supported = major > 22 || (major === 22 && minor >= 19);
	if (supported) return { id: "runtime", status: "ok", detail: `${process.version} (requires >= 22.19.0)` };
	return {
		id: "runtime",
		status: "blocked",
		detail: `${process.version} is older than the required 22.19.0`,
		remedy: { nextStep: packageHints().node },
	};
}

function checkWritable(id: string, label: string, path: string, missingDetail: string): SelfCheck {
	if (existsSync(path)) {
		if (isWritable(path)) return { id, status: "ok", detail: `${label}: ${path}` };
		return {
			id,
			status: "blocked",
			detail: `${label} is not writable: ${path}`,
			remedy: { nextStep: `Make ${path} writable for the current user, then re-run ${APP_NAME} doctor` },
		};
	}
	const ancestor = firstExistingAncestor(path);
	if (isWritable(ancestor))
		return { id, status: "ok", detail: `${label}: ${path} (${missingDetail}, nearest existing: ${ancestor})` };
	return {
		id,
		status: "blocked",
		detail: `${label} does not exist and cannot be created: ${path}`,
		remedy: {
			nextStep: `Create ${ancestor} with write permission for the current user, then re-run ${APP_NAME} doctor`,
		},
	};
}

function checkTool(id: "fd" | "rg", label: string, loss: string): SelfCheck {
	const path = getToolPath(id);
	if (path) return { id, status: "ok", detail: `${path}` };
	return {
		id,
		status: "degraded",
		detail: `${label} not found in ${getBinDir()} or PATH; ${loss}`,
		remedy: { nextStep: packageHints()[id] },
	};
}

function checkGit(): SelfCheck {
	const result = spawnSync("git", ["--version"], { stdio: "pipe", timeout: 5_000 });
	const version = result.stdout?.toString().trim();
	if (!result.error && result.status === 0 && version) {
		return { id: "git", status: "ok", detail: version };
	}
	const reason = result.error ? result.error.message : `exit code ${result.status ?? "unknown"}`;
	return {
		id: "git",
		status: "degraded",
		detail: `git is not runnable (${reason}); session diffs, update checks, and git-sourced packages are unavailable`,
		remedy: { nextStep: packageHints().git },
	};
}

async function defaultNetworkProbe(): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		await fetch("https://pi.dev/", { method: "HEAD", signal: controller.signal, redirect: "manual" });
	} finally {
		clearTimeout(timeout);
	}
}

async function checkNetwork(options: SelfCheckOptions): Promise<SelfCheck> {
	if (options.offline) {
		return {
			id: "network",
			status: "degraded",
			detail:
				"offline mode is on, so connectivity was not tested; model catalog refresh, provider sign-in, and extension installs are unavailable for this run",
			remedy: {
				nextStep: `Run ${APP_NAME} doctor in a shell without PI_OFFLINE (and without --offline) to test connectivity`,
			},
		};
	}
	try {
		await (options.probeNetwork ?? defaultNetworkProbe)();
		return { id: "network", status: "ok", detail: "reachable (HEAD https://pi.dev/)" };
	} catch (error) {
		const chain = formatCauseChain(error);
		return {
			id: "network",
			status: "degraded",
			detail: `unreachable: ${chain.join(": ") || String(error)}`,
			remedy: { nextStep: `Check network or proxy settings, then re-run ${APP_NAME} doctor` },
		};
	}
}

function checkSettings(options: SelfCheckOptions, settingsPath: string): SelfCheck {
	const errors = options.settingsErrors ?? [];
	if (errors.length === 0) return { id: "settings", status: "ok", detail: `parsed ${settingsPath}` };
	const first = errors[0];
	const where = first.path ?? first.scope ?? settingsPath;
	return {
		id: "settings",
		status: "degraded",
		detail: `${errors.length} settings error(s); ${where}: ${first.message}; the invalid entries are ignored for this run`,
		remedy: { nextStep: `Fix ${where}, then re-run ${APP_NAME} doctor` },
	};
}

function checkCredentials(): SelfCheck {
	const names = credentialEnvNames();
	const authExists = existsSync(getAuthPath());
	if (names.length > 0 || authExists) {
		const parts = [
			names.length > 0 ? `${names.length} credential environment variable(s): ${names.join(", ")}` : undefined,
			authExists ? `auth.json present at ${getAuthPath()}` : "auth.json absent",
		].filter((part): part is string => part !== undefined);
		return { id: "credentials", status: "ok", detail: `${parts.join("; ")} (values are never read here)` };
	}
	return {
		id: "credentials",
		status: "degraded",
		detail: "no credential environment variable and no auth.json; no provider is ready, so no model can be selected",
		remedy: { nextStep: APP_NAME },
	};
}

function checkTerminalColors(): SelfCheck {
	if (process.env.NO_COLOR !== undefined) {
		return { id: "terminal-colors", status: "ok", detail: "NO_COLOR is set: color is off by user choice" };
	}
	const term = process.env.TERM;
	if (process.platform === "win32" || process.env.COLORTERM || (term && term !== "dumb")) {
		return {
			id: "terminal-colors",
			status: "ok",
			detail: `TERM=${term ?? "(unset)"} COLORTERM=${process.env.COLORTERM ?? "(unset)"}`,
		};
	}
	return {
		id: "terminal-colors",
		status: "degraded",
		detail: `TERM=${term ?? "(unset)"} reports no color support; themes render without color`,
		remedy: { nextStep: `Set TERM before starting ${APP_NAME}, for example export TERM=xterm-256color` },
	};
}

/** Run every self-check. Order is stable so the report diff stays readable. */
export async function collectSelfChecks(options: SelfCheckOptions = {}): Promise<SelfCheck[]> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsPath = options.settingsPath ?? join(agentDir, "settings.json");
	return [
		checkRuntime(),
		checkWritable("cwd", "working directory", cwd, "will be created"),
		checkWritable("agent-dir", "agent directory", agentDir, "will be created"),
		checkTool("fd", "fd", "the find tool fails instead of searching"),
		checkTool("rg", "ripgrep (rg)", "the grep tool fails instead of searching"),
		checkGit(),
		await checkNetwork(options),
		checkSettings(options, settingsPath),
		checkCredentials(),
		checkTerminalColors(),
	];
}

function labelResource(entry: ResourceEntry | string): string {
	if (typeof entry === "string") return entry;
	return entry.scope ? `${entry.label} [${entry.scope}]` : entry.label;
}

/** Snapshot what the resource loader actually loaded this run. */
export function collectResourceInventory(
	loader: ResourceLoader,
	options: { projectTrusted: boolean },
): ResourceInventory {
	const extensions = loader.getExtensions();
	const skills = loader.getSkills();
	const prompts = loader.getPrompts();
	const themes = loader.getThemes();
	return {
		projectTrusted: options.projectTrusted,
		extensions: extensions.extensions.map((extension) => ({
			label:
				extension.sourceInfo.origin === "package"
					? extension.sourceInfo.source
					: extension.sourceInfo.source !== extension.path
						? `${extension.path} (${extension.sourceInfo.source})`
						: extension.path,
			scope: extension.sourceInfo.scope,
		})),
		extensionErrors: extensions.errors.map(({ path, error }) => ({ path, error })),
		extensionWarnings: (extensions.warnings ?? []).map(({ path, warning }) => ({ path, warning })),
		skills: skills.skills.map((skill) => ({
			label: `${skill.name} — ${skill.filePath}`,
			scope: skill.sourceInfo.scope,
		})),
		prompts: prompts.prompts.map((prompt) => ({ label: `${prompt.name} — ${prompt.filePath}` })),
		themes: themes.themes.map((theme) => ({
			label: theme.name ?? theme.sourcePath ?? "(unnamed theme)",
			scope: theme.sourceInfo?.scope,
		})),
		contextFiles: loader.getAgentsFiles().agentsFiles.map((file) => file.path),
		diagnostics: [...skills.diagnostics, ...prompts.diagnostics, ...themes.diagnostics],
	};
}

function formatChecks(checks: readonly SelfCheck[]): string[] {
	const lines: string[] = [];
	for (const check of checks) {
		const marker = check.status === "ok" ? "[ok]      " : check.status === "degraded" ? "[degraded]" : "[blocked] ";
		lines.push(`  ${marker} ${check.id}: ${check.detail}`);
		if (check.status !== "ok") lines.push(...formatRemedy(check.remedy).map((line) => `            ${line}`));
	}
	const counts: Record<CheckStatus, number> = { ok: 0, degraded: 0, blocked: 0 };
	for (const check of checks) counts[check.status]++;
	lines.push("");
	lines.push(`Result: ${counts.ok} ok, ${counts.degraded} degraded, ${counts.blocked} blocked`);
	return lines;
}

function formatList(title: string, entries: readonly (ResourceEntry | string)[], empty = "(none)"): string[] {
	if (entries.length === 0) return [`${title}: ${empty}`];
	return [`${title}: ${entries.length}`, ...entries.map((entry) => `  - ${labelResource(entry)}`)];
}

function formatResources(resources: ResourceInventory): string[] {
	const lines = [
		`project-local resources: ${resources.projectTrusted ? "loaded (project trusted for this run)" : "not loaded (project not trusted; re-run with --approve to include them)"}`,
		...formatList("extensions", resources.extensions),
	];
	if (resources.extensionErrors.length > 0) {
		lines.push(`  extensions that failed to load: ${resources.extensionErrors.length}`);
		for (const failure of resources.extensionErrors) {
			lines.push(`  - ${failure.path}: ${failure.error.split("\n")[0]}`);
		}
	}
	if (resources.extensionWarnings.length > 0) {
		lines.push(`  extension warnings: ${resources.extensionWarnings.length}`);
		for (const warning of resources.extensionWarnings) lines.push(`  - ${warning.path}: ${warning.warning}`);
	}
	lines.push(...formatList("skills", resources.skills));
	lines.push(...formatList("prompt templates", resources.prompts));
	lines.push(...formatList("themes", resources.themes));
	lines.push(...formatList("context files", resources.contextFiles));
	if (resources.diagnostics.length > 0) {
		lines.push(`resource diagnostics: ${resources.diagnostics.length}`);
		for (const diagnostic of resources.diagnostics) lines.push(`  - [${diagnostic.type}] ${diagnostic.message}`);
	}
	return lines;
}

function formatRecentErrors(records: readonly string[]): string[] {
	if (records.length === 0) {
		return ["(no records: the structured log gets its first entry on the first error of this install)"];
	}
	return records.map((record) => `  - ${record}`);
}

function formatCrashes(crashes: DoctorReportInput["crashes"]): string[] {
	if (crashes.length === 0) return ["(none)"];
	return crashes.map((crash) => `  - ${crash.timestamp} ${crash.kind}: ${crash.message}`);
}

/**
 * Build the pasteable report. Pure: every value is supplied by the caller, so
 * the package text can be asserted without touching the filesystem.
 */
export function buildDoctorReport(input: DoctorReportInput): string {
	const counts: Record<CheckStatus, number> = { ok: 0, degraded: 0, blocked: 0 };
	for (const check of input.checks) counts[check.status]++;
	const assembled = [
		`${APP_NAME} doctor — diagnostic report`,
		`Generated: ${input.generatedAt.toISOString()}`,
		"",
		"Credential redaction guarantee: this report is redacted before it is printed. Values of",
		"environment variables whose names contain TOKEN, SECRET, PASSWORD, CREDENTIAL, API_KEY,",
		"ACCESS_KEY or PRIVATE_KEY, whether they appear as a bare value or a NAME=value pair, common",
		"API key shapes (sk-..., ghp_..., AKIA..., AIza..., xox-..., Bearer ...), and token query",
		"parameters are replaced with [redacted]. Provider credentials are never read: auth.json is",
		"only reported as present or absent, and structured log lines are redacted when they are",
		"written, so the tail below is reproduced verbatim.",
		DIAGNOSTICS_WARNING,
		"",
		"== Version ==",
		`${APP_NAME} version:   ${input.version}`,
		`install method: ${input.installMethod}`,
		`package dir:    ${input.packageDir}`,
		`node:           ${input.nodeVersion}`,
		`platform:       ${input.platform} ${input.arch}`,
		"",
		"== Environment ==",
		`cwd:            ${input.cwd}`,
		`agent dir:      ${input.agentDir}`,
		`settings file:  ${input.settingsPath}`,
		`offline mode:   ${input.offline ? "on" : "off"}`,
		"",
		"== Self-check ==",
		...formatChecks(input.checks),
		"",
		"== Loaded resources ==",
		...formatResources(input.resources),
		"",
		"== Recent errors (structured log tail, newest last) ==",
		...formatRecentErrors(input.recentErrors),
		"",
		"== Recent crashes (crashes.json) ==",
		...formatCrashes(input.crashes),
		"",
		`== End == ${counts.blocked > 0 ? `blocked checks: ${counts.blocked}` : "no blocked checks"}`,
		"",
	].join("\n");
	// The guarantee stated at the top of the report must hold for every line
	// below it, including values that arrive from errors and crash logs.
	return redactSecrets(assembled);
}

function helpText(): string {
	return [
		doctorUsage(),
		"Print a pasteable diagnostic report: version, install method, self-check, loaded resources,",
		"and the tail of recent errors. Credential values are redacted before anything is printed.",
		"",
		"Options:",
		"  --approve, -a         Also load project-local resources (they are skipped by default)",
		"  --no-extensions, -ne  Skip extension execution",
		"  --help, -h            Show this help",
		"",
	].join("\n");
}

export interface DoctorCommandDeps {
	/** Report sink; defaults to stdout. Errors always go to stderr. */
	write?: (text: string) => void | Promise<void>;
	cwd?: string;
	agentDir?: string;
	/** Network probe override for tests. */
	probeNetwork?: () => Promise<void>;
	/** Self-check override for tests (the real checks read the live system). */
	selfChecks?: readonly SelfCheck[];
	/** Skip loading resources (unit tests that only exercise the wiring). */
	loadResources?: boolean;
}

async function writeOut(text: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(text, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

/**
 * Run `pi doctor` and return the process exit code: 1 when any check is
 * blocked, 0 otherwise (degraded checks stay 0 — they are reported, not fatal).
 */
export async function runDoctorCommand(invocation: DoctorInvocation, deps: DoctorCommandDeps = {}): Promise<number> {
	if (invocation.kind === "help") {
		await (deps.write ?? writeOut)(helpText());
		return 0;
	}
	if (invocation.kind === "error") {
		reportUserError({ message: invocation.message, remedy: HELP_REMEDY });
		return 1;
	}

	const cwd = deps.cwd ?? process.cwd();
	const agentDir = deps.agentDir ?? getAgentDir();
	const projectTrusted = invocation.options.projectTrusted === true;
	const offline = isTruthyFlag(process.env.PI_OFFLINE);

	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const settingsPath = join(agentDir, "settings.json");
	let resources: ResourceInventory = {
		projectTrusted,
		extensions: [],
		extensionErrors: [],
		extensionWarnings: [],
		skills: [],
		prompts: [],
		themes: [],
		contextFiles: [],
		diagnostics: [],
	};

	if (deps.loadResources !== false) {
		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: invocation.options.noExtensions === true,
			});
			await loader.reload();
			resources = collectResourceInventory(loader, { projectTrusted });
		} catch (error) {
			resources.extensionErrors.push({ path: "(resource loader)", error: formatCauseChain(error).join(": ") });
		}
	}

	const settingsErrors: SettingsErrorReport[] = settingsManager.drainErrors().map(({ scope, path, error }) => ({
		scope,
		path,
		message: error.message,
	}));
	const checks = [...(deps.selfChecks ?? [])];
	if (checks.length === 0) {
		checks.push(
			...(await collectSelfChecks({
				cwd,
				agentDir,
				offline,
				settingsPath,
				probeNetwork: deps.probeNetwork,
				settingsErrors,
			})),
		);
	}

	const report = buildDoctorReport({
		generatedAt: new Date(),
		version: VERSION,
		installMethod: detectInstallMethod(),
		packageDir: getPackageDir(),
		nodeVersion: process.version,
		platform: platform(),
		arch: arch(),
		cwd,
		agentDir,
		offline,
		settingsPath,
		checks,
		resources,
		recentErrors: readStructuredLogTail(20),
		crashes: readCrashLog(),
	});

	await (deps.write ?? writeOut)(report);
	return checks.some((check) => check.status === "blocked") ? 1 : 0;
}
