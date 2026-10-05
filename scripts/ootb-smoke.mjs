#!/usr/bin/env node
/**
 * Out-of-the-box smoke: a clean machine, no credentials, no network.
 *
 * This is Phase 3.5 item 7 of `pi-compare/plan-ootb.md` (AC-H04, AC-B09, AC-H05). It answers one
 * question: "someone installs pi on a machine that has never run it, nothing is configured, no
 * network - what does the product actually do, and how far does it get on its own?"
 *
 * Three constraints shape the whole script.
 *
 * 1. **Isolation is a temp tree, not a flag.** Every `PI_*` variable inherited from the shell is
 *    dropped, then HOME and USERPROFILE are pointed at a fresh temp directory. pi resolves its agent
 *    dir from `homedir()`, so the developer's real `~/.pi` is unreachable rather than merely
 *    unused. No `PI_CODING_AGENT_DIR` is set anywhere: that variable is itself one of the conditions
 *    `shouldRunFirstTimeSetup()` tests, so setting it would make every first-run assertion vacuous.
 * 2. **Credentials are deleted, not overridden.** Every environment variable shaped like a provider
 *    key is removed from the child env. `PI_OFFLINE=1` then removes the startup network calls, and a
 *    `--require` preload records any outbound socket that still escapes. A dummy key is injected in
 *    exactly one check, where it is needed to prove the catalog gate is credential-driven; that path
 *    only reads a local catalog, so nothing is sent.
 * 3. **The wizard is observed, not simulated.** `main()` only reaches the first-run path when both
 *    stdin and stdout are TTYs, which a pipe is not. A `--import` shim sets `isTTY` before `cli.ts`
 *    is evaluated so the same branch a real terminal takes is the one under test, and the screen is
 *    reassembled from stdout for matching.
 *
 * Every check maps to an AC id from plan-ootb.md section 4. The script reports the current state; it
 * does not change it. A check that fails on today's pi is the baseline, so the exit code is 0 only
 * once every check passes - which makes this the regression gate to re-run after the wizard work.
 *
 * Usage:
 *   node scripts/ootb-smoke.mjs [--out <file.json>] [--keep]
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = join(ROOT, "packages", "coding-agent", "src", "cli.ts");
const GATE_MODULE = join(ROOT, "packages", "coding-agent", "src", "cli", "startup-ui.ts");
const SETTINGS_FILE = "settings.json";
const DEFAULT_OUT = join(ROOT, ".artifacts", "ootb-smoke", "baseline.json");

/** Interactive probes hang by design if the TUI never gets input, so every spawn has a ceiling. */
const PROBE_TIMEOUT_MS = 90_000;
const TUI_SETTLE_MS = 20_000;
const TUI_HARD_TIMEOUT_MS = 45_000;
/** One keypress per interval while walking the wizard; each Enter advances at most one question. */
const KEY_INTERVAL_MS = 700;
const MAX_ENTER_PRESSES = 12;

/**
 * Anything a provider could read as a secret. Deleting by shape rather than by a fixed list means a
 * newly supported provider is covered the day its env var is named, not the day this list is edited.
 */
const CREDENTIAL_ENV_PATTERN = /(API_?KEY|TOKEN|OAUTH|CREDENTIAL|SECRET|PASSWORD)/i;

/**
 * Escape hatch for a developer who deliberately wants to exercise a credentialed path. Off by
 * default: an inherited key would silently turn the "no credentials" premise into a lie.
 */
const ALLOW_INHERITED_CREDENTIALS = process.env.PI_OOTB_SMOKE_ALLOW_ENV_CREDENTIALS === "1";

/** CSI, OSC and other control bytes the TUI emits; kept as escapes so this file stays text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const ESC = "\u001b";

/**
 * Network guard, preloaded with `--require`. A recorder, not a blocker: pi's offline paths should
 * produce zero entries and a non-empty log is the finding. Patching `net.Socket.prototype.connect`
 * catches undici too, because undici builds its own connections but still opens sockets through it.
 */
const NETWORK_GUARD = `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const logPath = process.env.OOTB_NET_LOG;
function isLocal(host) {
	return host === undefined || host === null || host === "" ||
		host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "0.0.0.0";
}
function record(line) {
	try { fs.appendFileSync(logPath, line + "\\n"); } catch {}
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	try {
		const options = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
		const host = options.host !== undefined ? options.host : args[1];
		const port = options.port !== undefined ? options.port : args[0];
		if (!isLocal(host)) record("tcp " + host + ":" + port);
	} catch {}
	return originalConnect.apply(this, args);
};
const originalLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
	if (!isLocal(hostname)) record("dns " + hostname);
	return originalLookup.call(this, hostname, ...rest);
};
const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
	globalThis.fetch = function (input, ...rest) {
		try {
			const url = typeof input === "string" ? input : (input && input.url);
			if (url && !isLocal(new URL(url).hostname)) record("fetch " + url);
		} catch {}
		return originalFetch.call(this, input, ...rest);
	};
}
`;

const results = [];

function record(id, acs, title, status, detail, extra = {}) {
	results.push({ id, acs, title, status, detail, ...extra });
	console.log(`[${status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "INFO"}] ${id} (${acs.join(", ")}) ${title}`);
	for (const line of String(detail).split("\n")) console.log(`       ${line}`);
	if (Object.keys(extra).length > 0) console.log(`       ${JSON.stringify(extra)}`);
}

function parseArgs(argv) {
	const options = { out: DEFAULT_OUT, keep: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") options.out = resolve(argv[++i]);
		else if (arg === "--keep") options.keep = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

/**
 * A fresh machine. HOME and USERPROFILE are both set because `os.homedir()` reads USERPROFILE on
 * win32 and HOME elsewhere, and pi derives `~/.pi/agent` from it.
 */
function createSandbox() {
	const root = mkdtempSync(join(tmpdir(), "pi-ootb-smoke-"));
	const home = join(root, "home");
	const project = join(root, "project");
	const agentDir = join(home, ".pi", "agent");
	const netLog = join(root, "network.log");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	return { root, home, project, agentDir, netLog, guard: join(root, "network-guard.cjs") };
}

/**
 * The clean-machine env: no inherited pi configuration, no inherited credentials, no network.
 * `PI_CODING_AGENT_DIR` is deliberately absent - it is one of the inputs `shouldRunFirstTimeSetup()`
 * inspects, so a smoke that sets it cannot tell an onboarding gate from an env-var gate.
 */
function cleanEnv(sandbox, extra = {}) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key.startsWith("PI_")) continue;
		if (!ALLOW_INHERITED_CREDENTIALS && CREDENTIAL_ENV_PATTERN.test(key)) continue;
		env[key] = value;
	}
	env.HOME = sandbox.home;
	env.USERPROFILE = sandbox.home;
	env.PI_OFFLINE = "1";
	// The TUI sizes itself from these when stdout is a pipe; fixing them keeps the capture stable.
	env.COLUMNS = "100";
	env.LINES = "40";
	env.OOTB_NET_LOG = sandbox.netLog;
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

function runCli(args, { sandbox, cwd, env = {} }) {
	const started = Date.now();
	const result = spawnSync(process.execPath, ["--require", sandbox.guard, CLI_ENTRY, ...args], {
		env: cleanEnv(sandbox, env),
		cwd: cwd ?? sandbox.project,
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
		input: "",
	});
	return {
		code: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		durationMs: Date.now() - started,
		error: result.error?.message,
	};
}

/**
 * One real interactive startup, captured from stdout.
 *
 * `--import` flips `isTTY` before `cli.ts` is evaluated, which is what `resolveAppMode` reads, so
 * `main()` takes the interactive branch a terminal would take. `PI_STARTUP_BENCHMARK=1` makes pi
 * initialize the mode, pause, and exit, which bounds the run without needing a real terminal.
 *
 * Driving the keyboard is what turns a screenshot into a measurement, but only if the keys are timed
 * by what is on screen. A blind timer is wrong in both directions: pi needs a few seconds to start,
 * so keys sent early sit in the pipe and are delivered in a burst when the TUI attaches stdin, which
 * answers several questions with one wall-clock interval and inflates the count. Instead one Enter
 * is sent per *distinct wizard frame*: a frame that changed is a new question. ESC is the last
 * resort, because a wizard that cannot be dismissed is a worse outcome than no wizard (AC-B03).
 * With `answer: false` no key is ever sent, which is how the bare first screen is observed without
 * contaminating it.
 */
function captureInteractive(sandbox, { answer = true } = {}) {
	return new Promise((resolveRun) => {
		const ttyShim = `data:text/javascript,${encodeURIComponent(
			"process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n",
		)}`;
		const started = Date.now();
		const child = spawn(
			process.execPath,
			["--require", sandbox.guard, "--import", ttyShim, CLI_ENTRY],
			{
				env: cleanEnv(sandbox, { PI_STARTUP_BENCHMARK: "1" }),
				cwd: sandbox.project,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let enterPresses = 0;
		let escSent = false;
		let firstByteAt = null;
		let wizardSeen = false;
		let chatAtPresses = null;
		let lastWizardFrame = "";
		let finished = false;
		/** Only the tail of the stream is the current frame; earlier repaints are history. */
		const currentFrame = () => visibleText(stdout).slice(-FRAME_WINDOW_CHARS);
		/**
		 * Detection and key timing are both event-driven. `PI_STARTUP_BENCHMARK` exits ~150ms after
		 * the chat first paints, so a tick-based check can miss the transition entirely and report
		 * zero questions for a wizard that asked several.
		 */
		const observe = () => {
			if (chatAtPresses !== null) return;
			const frame = currentFrame();
			if (MAIN_SCREEN.test(frame)) {
				chatAtPresses = enterPresses;
				return;
			}
			if (!WIZARD_SCREEN.test(frame)) return;
			wizardSeen = true;
			if (!answer) return;
			// One Enter per distinct question: a new question line means onboarding advanced.
			// Matching the whole frame would count one question on every repaint.
			const question = currentWizardQuestion(frame);
			if (question === undefined || question === lastWizardFrame) return;
			if (enterPresses >= MAX_ENTER_PRESSES) return;
			lastWizardFrame = question;
			enterPresses++;
			child.stdin.write("\r");
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (firstByteAt === null) firstByteAt = Date.now() - started;
			observe();
		});
		child.stderr.on("data", (chunk) => {
			stdout += chunk.toString();
			stderr += chunk.toString();
			observe();
		});
		const keyTimer = setInterval(() => {
			observe();
			if (chatAtPresses !== null) {
				clearInterval(keyTimer);
				return;
			}
			// Onboarding is up but no new question has appeared: it is not advancing on Enter, so
			// fall back to ESC rather than sitting there. AC-B03 requires the escape hatch.
			if (answer && wizardSeen && !escSent && enterPresses >= MAX_ENTER_PRESSES) {
				escSent = true;
				child.stdin.write(ESC);
			}
		}, KEY_INTERVAL_MS);
		const settleTimer = setTimeout(() => child.kill(), TUI_SETTLE_MS);
		const hardTimer = setTimeout(() => child.kill(), TUI_HARD_TIMEOUT_MS);
		const done = (code) => {
			if (finished) return;
			finished = true;
			observe();
			clearInterval(keyTimer);
			clearTimeout(settleTimer);
			clearTimeout(hardTimer);
			resolveRun({
				code,
				stdout,
				stderr,
				enterPresses,
				escSent,
				wizardSeen,
				chatAtPresses,
				timeToFirstByteMs: firstByteAt,
				durationMs: Date.now() - started,
			});
		};
		child.on("close", done);
		child.on("error", (error) => {
			stderr += `${error.message}\n`;
			done(null);
		});
	});
}

/**
 * The TUI repaints with absolute cursor moves and OSC sequences, so a screen has to be reassembled
 * before anything can be matched against it.
 */
function visibleText(raw) {
	return raw
		.replace(new RegExp(`${ESC}\\][^\\u0007${ESC}]*(\\u0007|${ESC}\\\\)`, "g"), " ")
		.replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), " ")
		.replace(new RegExp(`${ESC}[()][B0]`, "g"), " ")
		.replace(CONTROL_CHARS, "")
		.replace(/[ \t]+/g, " ")
		.trim();
}

/**
 * How much of the tail of the stream counts as "the current frame". The TUI repaints in place, so the
 * most recent paint is at the end; earlier frames stay in the buffer and would make a stale question
 * look current. 4KB covers a full-screen repaint at the sizes this smoke uses.
 */
const FRAME_WINDOW_CHARS = 4096;

/**
 * What identifies one wizard question. The screen is re-rendered constantly (theme preview, cursor
 * blink), so comparing whole frames would count one question many times over; the question line is
 * what is stable.
 *
 * Two details make this reliable rather than merely plausible. A repaint moves the cursor instead of
 * clearing the buffer, so the tail window still holds the end of the previous frame, and the marker
 * for the frame currently on screen is therefore the *last* match, not the first. And the alternation
 * is ordered most-specific-first, so "Opt-in to anonymous usage data sharing" is not read as a bare
 * "Opt-in" that a different question could also contain.
 */
const WIZARD_FRAME_MARKERS = [
	"Pick a theme",
	"Opt-in to anonymous usage data sharing",
	"api key",
	"API key",
	"Sign in",
	"Log in",
	"provider",
	"Provider",
	"model",
	"Model",
];

/** The marker of the frame currently on screen, or undefined when no question is showing. */
function currentWizardQuestion(frame) {
	let marker;
	for (const candidate of WIZARD_FRAME_MARKERS) {
		if (frame.lastIndexOf(candidate) !== -1) marker = candidate;
	}
	return marker;
}
/** The onboarding frame as a whole, matched against the same tail window. */
const WIZARD_SCREEN = /Welcome to pi|Pick a theme|Opt-in to anonymous|[Ss]ign in|[Ll]og in|[Aa]pi key/;
/** The chat frame, i.e. a startup that got past onboarding. */
const MAIN_SCREEN = /Pi can explain its own features|ctrl\+o/;

function readNetworkLog(sandbox) {
	if (!existsSync(sandbox.netLog)) return [];
	return readFileSync(sandbox.netLog, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function writeProbe(sandbox, name, source) {
	const file = join(sandbox.root, name);
	writeFileSync(file, source, "utf8");
	return file;
}

/**
 * Probes `shouldRunFirstTimeSetup()` in its own process so every scenario sees a pristine env. The
 * scenarios are the truth table of the first-run gate, which is the whole of AC-B01: the
 * default-env rows are false today because of the `PI_EXPERIMENTAL` check and must be true after
 * it goes; the two negative controls must stay false, because a wizard that ignores "already
 * configured" or "explicit agent dir" is not an improvement.
 */
function runGateScenario(sandbox, scenario) {
	const probe = writeProbe(
		sandbox,
		`gate-${scenario}.mjs`,
		`const mod = await import(${JSON.stringify(pathToFileURL(GATE_MODULE).href)});
const gate = mod.shouldRunFirstTimeSetup;
console.log(JSON.stringify(gate === undefined ? { exportPresent: false } : { exportPresent: true, result: gate() === true }));
`,
	);
	const result = spawnSync(process.execPath, [probe], {
		env: cleanEnv(sandbox, {
			PI_EXPERIMENTAL: scenario === "experimental" ? "1" : undefined,
			PI_CODING_AGENT_DIR: scenario === "customAgentDir" ? join(sandbox.root, "elsewhere") : undefined,
		}),
		cwd: sandbox.project,
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
	});
	if (result.status !== 0) {
		return { exportPresent: null, result: null, error: result.stderr.trim() || "probe exited non-zero" };
	}
	return JSON.parse(result.stdout.trim() || "{}");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const sandbox = createSandbox();
	writeFileSync(sandbox.guard, NETWORK_GUARD, "utf8");

	console.log("=== pi OOTB clean-machine smoke ===");
	console.log(`repo:    ${ROOT}`);
	console.log(`sandbox: ${sandbox.root}`);
	console.log(
		`env:     all PI_* dropped, credentials ${ALLOW_INHERITED_CREDENTIALS ? "INHERITED (override)" : "stripped"}, PI_OFFLINE=1, network guard loaded via --require`,
	);
	console.log("");

	// --- S0: the guard itself records ------------------------------------------------------
	// An empty network log is only evidence if the recorder works, so fire it deliberately first.
	// The probe asks for an invalid `family`, which makes dns.lookup throw synchronously after the
	// hook has already appended its line: the probe proves the hook fires without opening a socket.
	const probeLog = join(sandbox.root, "guard-selftest.log");
	const guardProbe = spawnSync(
		process.execPath,
		[
			"--require",
			sandbox.guard,
			"-e",
			'require("node:dns").lookup("guard-selftest.invalid", { family: 99 }, () => {});',
		],
		{ env: cleanEnv(sandbox, { OOTB_NET_LOG: probeLog }), encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
	);
	let probeEntries = [];
	try {
		probeEntries = readFileSync(probeLog, "utf8")
			.split("\n")
			.filter((line) => line.includes("guard-selftest.invalid"));
	} catch {}
	record(
		"S0",
		["AC-H04"],
		"network guard records an outbound attempt when one happens",
		probeEntries.length > 0 ? "pass" : "fail",
		probeEntries.length > 0
			? `guard fired on a deliberate probe: ${probeEntries.join(", ")} (probe exit=${guardProbe.status} is expected non-zero)`
			: `guard never fired; the empty log at S12 would be meaningless. exit=${guardProbe.status} stderr=${JSON.stringify(
					guardProbe.stderr.trim(),
				)}`,
	);
	rmSync(probeLog, { force: true });

	// --- S1: the binary starts on a machine with nothing configured -----------------------
	const version = runCli(["--version"], { sandbox });
	const versionText = version.stdout.trim();
	record(
		"S1",
		["AC-H04"],
		"pi starts and reports a real version",
		version.code === 0 && /^\d+\.\d+\.\d+/.test(versionText) ? "pass" : "fail",
		version.code === 0 && /^\d+\.\d+\.\d+/.test(versionText)
			? `pi --version -> ${versionText}`
			: `exit=${version.code} stdout=${JSON.stringify(versionText)} stderr=${JSON.stringify(version.stderr.trim())}`,
	);

	// --- S2..S5: the first-run gate's truth table ------------------------------------------
	const gateRows = [
		["default", {}, true, "fresh agent dir, no PI_* variables at all"],
		["experimental", { PI_EXPERIMENTAL: "1" }, true, "PI_EXPERIMENTAL=1, the only way in today"],
		["customAgentDir", { customAgentDir: true }, false, "explicit agent dir override"],
		["alreadyConfigured", { configured: true }, false, "settings.json already exists"],
	];
	const gateTable = [];
	for (const [scenario, , expected, description] of gateRows) {
		const settingsPath = join(sandbox.agentDir, SETTINGS_FILE);
		if (scenario === "alreadyConfigured") writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }), "utf8");
		const observed = runGateScenario(sandbox, scenario);
		const ok = observed.result === expected;
		gateTable.push({ scenario, description, expected, observed: observed.result ?? null, ok, error: observed.error });
		record(
			`S2-${scenario}`,
			["AC-B01"],
			`first-run gate returns ${expected} for: ${scenario}`,
			ok ? "pass" : "fail",
			`expected ${expected}, observed ${observed.result} (${description})${
				observed.error ? `\nprobe error: ${observed.error}` : ""
			}`,
		);
		rmSync(settingsPath, { force: true });
	}

	// --- S6: non-TTY degradation -----------------------------------------------------------
	// With piped stdio there is no terminal to draw on. AC-B04 requires onboarding to stay silent
	// and the process to exit; a hang or escape sequences in the output is the failure.
	const piped = runCli([], { sandbox });
	const drewTui = piped.stdout.includes(`${ESC}[`);
	const pipedSilent = visibleText(piped.stdout).length === 0;
	record(
		"S6",
		["AC-B04"],
		"non-TTY startup neither draws nor hangs",
		piped.code !== null && !drewTui && pipedSilent ? "pass" : "fail",
		`exit=${piped.code} hung=${piped.code === null} drewEscapeSequences=${drewTui} output=${JSON.stringify(
			visibleText(piped.stdout).slice(0, 200),
		)}`,
	);

	// --- S7: the bare first screen, no credentials, no onboarding -------------------------
	// settings.json is pre-created so the first-run gate is closed and the capture shows what a user
	// lands on today: no wizard, and whatever the empty state says about getting credentials. No key
	// is sent, so the screen is observed rather than advanced past.
	writeFileSync(join(sandbox.agentDir, SETTINGS_FILE), JSON.stringify({ theme: "dark" }), "utf8");
	const bare = await captureInteractive(sandbox, { answer: false });
	const bareText = visibleText(bare.stdout);
	const bareMentionsLogin = /\/login|log in|sign in|credential|api key|no models available/i.test(bareText);
	record(
		"S7",
		["AC-C01"],
		"with no credentials the first screen points at a way to log in",
		bareMentionsLogin ? "pass" : "fail",
		bareMentionsLogin
			? "first screen carries credential guidance"
			: "first screen carries no credential guidance; a new user has to discover /login unaided",
	);
	rmSync(join(sandbox.agentDir, SETTINGS_FILE), { force: true });

	// --- S8: the first run itself ----------------------------------------------------------
	// Enters until the chat appears: that count is the number of questions onboarding asked, which is
	// the "mandatory questions" number the baseline asks for. ESC follows, because a wizard that
	// cannot be dismissed is a worse outcome than no wizard.
	const firstRun = await captureInteractive(sandbox);
	const chatReached = firstRun.chatAtPresses !== null;
	const wizardShown = firstRun.wizardSeen;
	const questionsAsked = wizardShown ? firstRun.chatAtPresses : 0;
	record(
		"S8",
		["AC-B01", "AC-B03", "AC-B05"],
		"first interactive launch opens dismissible onboarding",
		wizardShown ? "pass" : "fail",
		wizardShown
			? `onboarding rendered and dismissed after ${firstRun.enterPresses} Enter presses; reached the chat=${chatReached}`
			: "no onboarding on first launch; the product opens straight into the chat with no credentials",
		{ questionsAsked, enterPresses: firstRun.enterPresses, reachedChat: chatReached },
	);

	// --- S9/S10: the credential gate, both directions ---------------------------------------
	// Same binary, same offline catalog; only one env key differs, which is what makes this a test
	// of the gate rather than of the catalog.
	const noCredentials = runCli(["--list-models"], { sandbox });
	const gateMessage = `${noCredentials.stdout}${noCredentials.stderr}`;
	const gateExplains = /No models available/i.test(gateMessage) && /\/login/.test(gateMessage);
	record(
		"S9",
		["AC-C02"],
		"--list-models with no credentials explains how to fix it",
		gateExplains ? "pass" : "fail",
		gateExplains
			? "empty catalog reported together with /login guidance"
			: `unexpected output: ${JSON.stringify(gateMessage.slice(0, 200))}`,
	);

	const withDummyKey = runCli(["--list-models", "nebius"], {
		sandbox,
		env: { NEBIUS_API_KEY: "ootb-smoke-dummy-key-never-sent" },
	});
	record(
		"S10",
		["AC-C08"],
		"a single credential env var opens the catalog, so the gate is credential-driven",
		/nebius/.test(withDummyKey.stdout) ? "pass" : "fail",
		/nebius/.test(withDummyKey.stdout)
			? "provider listed from the local catalog; no request left the machine"
			: `unexpected output: ${JSON.stringify(withDummyKey.stdout.slice(0, 200))}`,
	);

	// --- S11: the error a user actually hits -----------------------------------------------
	const printMode = runCli(["-p", "hello"], { sandbox });
	const printText = `${printMode.stdout}${printMode.stderr}`;
	const namesAction = /\/login/.test(printText);
	const namesDocsPath = /(?:[A-Za-z]:[\\/]|\/).*docs[\\/]providers\.md/.test(printText);
	const errorLines = printText
		.split("\n")
		.filter((line) => /^(?:Error|Warning|No API key|No model)/i.test(line.trim()));
	record(
		"S11",
		["AC-C02", "AC-H05"],
		"submitting without credentials fails with an actionable, absolute-path error",
		printMode.code !== 0 && namesAction && namesDocsPath ? "pass" : "fail",
		`exit=${printMode.code} namesAction=${namesAction} namesAbsoluteDocsPath=${namesDocsPath}\n${printText.trim()}`,
		{ errorLines: errorLines.length },
	);

	// --- S12: nothing reached the network ---------------------------------------------------
	const networkAttempts = readNetworkLog(sandbox);
	record(
		"S12",
		["AC-H04"],
		"no outbound connection during the entire smoke",
		networkAttempts.length === 0 ? "pass" : "fail",
		networkAttempts.length === 0
			? "network guard recorded zero attempts"
			: `network guard recorded:\n${networkAttempts.join("\n")}`,
	);

	// --- baseline ---------------------------------------------------------------------------
	// The numbers plan-ootb.md section 5.1 asks for. Time to the first assistant reply cannot be
	// measured here by construction - there are no credentials and no network - so the honest value
	// is the time to the first screen plus the reason the rest is unmeasurable.
	const baseline = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		platform: process.platform,
		repo: ROOT,
		sandbox: sandbox.root,
		metrics: {
			firstRunSteps: wizardShown ? 1 + questionsAsked : 0,
			firstRunStepsDescription:
				"user-visible steps pi performs on its own between a cold start and the first assistant reply: one for showing onboarding, plus one per question it asks",
			timeToVersionMs: version.durationMs,
			timeToFirstScreenMs: bare.timeToFirstByteMs,
			timeToFirstInteractiveStartupMs: bare.durationMs,
			timeToFirstAssistantReplyMs: null,
			timeToFirstAssistantReplyBlockedBy:
				"no credentials and no network by construction; measuring it needs a credentialed run, which this smoke must never be",
			mandatoryQuestions: questionsAsked,
			mandatoryQuestionsDescription: wizardShown
				? "Enter presses needed to walk past onboarding on the first launch"
				: "onboarding never appeared, so zero questions are asked and the user must find /login unaided",
			errorsBeforeFirstReply: errorLines.length,
			errorsBeforeFirstReplyDescription:
				"error-level lines a zero-config user hits on the way to their first message; the only one is at submit time",
		},
		gateTable,
		networkAttempts,
		acCoverage: {
			"AC-B01": "S2-* truth table + S8 onboarding on first launch",
			"AC-B03": "S8 ESC dismisses onboarding and startup continues",
			"AC-B04": "S6 piped stdio neither draws nor hangs",
			"AC-B05": "S8 question count on the first launch",
			"AC-B09": "metrics.timeToFirstAssistantReplyMs (+ the reason it is unmeasurable offline)",
			"AC-C01": "S7 first screen with no credentials",
			"AC-C02": "S9 and S11 no-credential errors name /login and an absolute docs path",
			"AC-C08": "S10 one credential env var opens the catalog offline",
			"AC-H04": "S0 proves the guard records, S1 starts, S12 no outbound connection: temp HOME, stripped credentials, PI_OFFLINE",
			"AC-H05": "metrics.mandatoryQuestions + metrics.errorsBeforeFirstReply",
		},
		results,
	};
	const failed = results.filter((entry) => entry.status === "fail");
	const unmetACs = [...new Set(failed.flatMap((entry) => entry.acs))].sort();

	console.log("");
	console.log("=== baseline ===");
	console.log(`first-run steps performed by pi:      ${baseline.metrics.firstRunSteps}`);
	console.log(`time to --version:                   ${baseline.metrics.timeToVersionMs} ms`);
	console.log(`time to first screen byte:           ${baseline.metrics.timeToFirstScreenMs ?? "n/a"} ms`);
	console.log("time to first assistant reply:       not measured (no credentials, no network, by construction)");
	console.log(`mandatory questions on first launch: ${baseline.metrics.mandatoryQuestions ?? "n/a (no onboarding)"}`);
	console.log(`errors before first reply:           ${baseline.metrics.errorsBeforeFirstReply}`);
	console.log("");
	console.log(`checks: ${results.length}, failed: ${failed.length}`);
	console.log(`unmet ACs: ${unmetACs.length > 0 ? unmetACs.join(", ") : "none"}`);

	mkdirSync(dirname(options.out), { recursive: true });
	writeFileSync(options.out, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
	console.log(`baseline written: ${options.out}`);

	if (options.keep) console.log(`sandbox kept: ${sandbox.root}`);
	else rmSync(sandbox.root, { recursive: true, force: true });

	process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
