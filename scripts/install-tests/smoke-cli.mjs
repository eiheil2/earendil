#!/usr/bin/env node
/**
 * Smoke-test an installed `pi` launcher.
 *
 * Usage:
 *   node scripts/install-tests/smoke-cli.mjs <label> <command> [args...]
 *
 * `<command> [args...]` is the runner for `pi` (e.g. `pi`, `node dist/bundle/cli.js`,
 * `node_modules/.bin/pi`). Every invocation runs with an isolated HOME and
 * PI_CODING_AGENT_DIR so no real user state is touched.
 *
 * Legs (mirrors omp scripts/install-tests/run-ci.sh smoke_cli):
 *   1. `--version` prints a real semver (AC-A05)
 *   2. `--help` exits 0 and prints Usage:
 *   3. one real offline session through the mock provider (PI_OFFLINE=1)
 *   4. one mock-provider session
 *   5. `completions bash` emits a script derived from the command metadata
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [label, command, ...commandArgs] = process.argv.slice(2);
if (!label || !command) {
	console.error("Usage: node scripts/install-tests/smoke-cli.mjs <label> <command> [args...]");
	process.exit(2);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const mockProvider = resolve(here, "mock-provider.ts");
const sandbox = mkdtempSync(join(tmpdir(), "pi-install-smoke-"));
const home = join(sandbox, "home");
const agentDir = join(sandbox, "agent");

function run(args, env = {}) {
	const childEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		...env,
	};
	// A .cmd launcher needs a shell on Windows, but node 26 deprecates passing an
	// argv array alongside shell:true (DEP0190: args are concatenated, unescaped).
	// Pass one pre-quoted command line instead; quoting also makes spaced paths work,
	// which the unquoted concatenation would silently split.
	if (process.platform === "win32") {
		const line = [command, ...commandArgs, ...args]
			.map((part) => (/[\s"]/u.test(part) ? `"${part.replace(/"/g, '""')}"` : part))
			.join(" ");
		return spawnSync(line, { encoding: "utf8", shell: true, env: childEnv });
	}
	return spawnSync(command, [...commandArgs, ...args], { encoding: "utf8", env: childEnv });
}

function check(name, ok, detail = "") {
	if (ok) {
		console.log(`  ok   ${name}`);
		return;
	}
	console.error(`  FAIL ${name}`);
	if (detail) console.error(detail);
	process.exitCode = 1;
}

console.log(`[${label}] smoke: ${command} ${commandArgs.join(" ")}`);

try {
	const version = run(["--version"]);
	check(
		"--version prints a real semver",
		version.status === 0 && /^\s*\d+\.\d+\.\d+(-[\w.]+)?\s*$/.test(version.stdout),
		`status=${version.status} stdout=${JSON.stringify(version.stdout)} stderr=${JSON.stringify(version.stderr)}`,
	);

	const help = run(["--help"]);
	check("--help exits 0 with Usage:", help.status === 0 && help.stdout.includes("Usage:"), `status=${help.status}`);

	const offlineSession = run(["--offline", "-e", mockProvider, "--provider", "faux-local", "--model", "mock-1", "-p", "ping"], {
		PI_OFFLINE: "1",
	});
	check(
		"one real offline session (mock provider, PI_OFFLINE=1)",
		offlineSession.status === 0 && offlineSession.stdout.includes("MOCK_RESPONSE_OK"),
		`status=${offlineSession.status} stdout=${JSON.stringify(offlineSession.stdout)} stderr=${JSON.stringify(offlineSession.stderr)}`,
	);

	const mockSession = run(["-e", mockProvider, "--provider", "faux-local", "--model", "mock-1", "-p", "ping"]);
	check(
		"one mock provider session",
		mockSession.status === 0 && mockSession.stdout.includes("MOCK_RESPONSE_OK"),
		`status=${mockSession.status} stdout=${JSON.stringify(mockSession.stdout)} stderr=${JSON.stringify(mockSession.stderr)}`,
	);

	const completions = run(["completions", "bash"]);
	check(
		"completions bash emits a generated script",
		completions.status === 0 && completions.stdout.includes("complete -F") && completions.stdout.includes("install"),
		`status=${completions.status} stderr=${JSON.stringify(completions.stderr)}`,
	);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

if (process.exitCode) {
	console.error(`[${label}] smoke FAILED`);
} else {
	console.log(`[${label}] smoke passed`);
}
