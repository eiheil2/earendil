import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, test, vi } from "vitest";
import {
	buildDoctorReport,
	collectSelfChecks,
	type DoctorReportInput,
	runDoctorCommand,
} from "../../src/cli/doctor-command.ts";
import { APP_NAME, ENV_AGENT_DIR, VERSION } from "../../src/config.ts";
import type { ErrorRemedy } from "../../src/core/error-render.ts";
import { credentialEnvNames } from "../../src/core/redact.ts";
import { DIAGNOSTICS_WARNING } from "../../src/core/startup-diagnostics.ts";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../src/experimental/source-resolver.ts")).href;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Captures everything the command would have printed to stderr. */
function captureStderr(fn: () => void): string {
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		fn();
		return spy.mock.calls.map((call) => String(call[0])).join("");
	} finally {
		spy.mockRestore();
	}
}

function reportInput(overrides: Partial<DoctorReportInput> = {}): DoctorReportInput {
	const resources = {
		projectTrusted: false,
		extensions: [],
		extensionErrors: [],
		extensionWarnings: [],
		skills: [],
		prompts: [],
		themes: [],
		contextFiles: [],
		diagnostics: [],
	};
	return {
		generatedAt: new Date("2026-01-02T03:04:05.000Z"),
		version: VERSION,
		installMethod: "npm",
		packageDir: "/opt/pi/packages/coding-agent",
		nodeVersion: process.version,
		platform: "linux",
		arch: "x64",
		cwd: "/work/project",
		agentDir: "/home/u/.pi/agent",
		offline: true,
		settingsPath: "/home/u/.pi/agent/settings.json",
		checks: [{ id: "runtime", status: "ok", detail: `${process.version} (requires >= 22.19.0)` }],
		resources,
		recentErrors: [],
		crashes: [],
		...overrides,
	};
}

/** One remedy as plain text, whichever branch of the union it takes. */
function remedyText(remedy: ErrorRemedy): string {
	return "nextStep" in remedy ? remedy.nextStep : `${remedy.noFix.reason} ${remedy.noFix.impact}`;
}

describe("collectSelfChecks", () => {
	test("offline mode degrades the network check and names what it costs", async () => {
		const checks = await collectSelfChecks({ offline: true });
		const network = checks.find((check) => check.id === "network");
		expect(network?.status).toBe("degraded");
		expect(network?.detail).toContain("offline mode is on");
		expect(network?.detail).toContain("unavailable");
		if (network && network.status !== "ok") {
			expect(remedyText(network.remedy)).toContain("PI_OFFLINE");
		}
	});

	test("a failed probe keeps the underlying cause instead of a bare 'unreachable'", async () => {
		const checks = await collectSelfChecks({
			offline: false,
			probeNetwork: () => Promise.reject(new Error("getaddrinfo ENOTFOUND pi.dev")),
		});
		const network = checks.find((check) => check.id === "network");
		expect(network?.status).toBe("degraded");
		expect(network?.detail).toContain("getaddrinfo ENOTFOUND pi.dev");
	});

	test("a passing probe reports ready", async () => {
		const checks = await collectSelfChecks({ offline: false, probeNetwork: () => Promise.resolve() });
		expect(checks.find((check) => check.id === "network")?.status).toBe("ok");
	});

	test("settings parse errors become a degraded check that names the file", async () => {
		const checks = await collectSelfChecks({
			settingsPath: "/home/u/.pi/agent/settings.json",
			settingsErrors: [{ path: "/home/u/.pi/agent/settings.json", message: "Unexpected token }" }],
		});
		const settings = checks.find((check) => check.id === "settings");
		expect(settings?.status).toBe("degraded");
		expect(settings?.detail).toContain("Unexpected token }");
		if (settings && settings.status !== "ok") {
			expect(remedyText(settings.remedy)).toContain("/home/u/.pi/agent/settings.json");
		}
	});

	test("every non-ok check carries a remedy (AC-F07)", async () => {
		const checks = await collectSelfChecks({ offline: true });
		for (const check of checks) {
			if (check.status === "ok") continue;
			expect(remedyText(check.remedy).length, `check ${check.id} has an empty remedy`).toBeGreaterThan(0);
		}
	});
});

describe("buildDoctorReport", () => {
	test("leads with the redaction guarantee and the leak warning", () => {
		const report = buildDoctorReport(reportInput());
		expect(report).toContain("Credential redaction guarantee: this report is redacted before it is printed.");
		expect(report).toContain(DIAGNOSTICS_WARNING);
		expect(report).toContain(`${APP_NAME} doctor — diagnostic report`);
		expect(report).toContain(`Generated: 2026-01-02T03:04:05.000Z`);
	});

	test("carries version, install method, environment, self-check, resources, and log tail sections", () => {
		const report = buildDoctorReport(
			reportInput({
				checks: [
					{ id: "runtime", status: "ok", detail: "v22.19.0 (requires >= 22.19.0)" },
					{
						id: "fd",
						status: "degraded",
						detail: "fd not found; the find tool fails instead of searching",
						remedy: { nextStep: "winget install sharkdp.fd" },
					},
					{
						id: "agent-dir",
						status: "blocked",
						detail: "agent directory is not writable: /home/u/.pi/agent",
						remedy: { nextStep: "Make /home/u/.pi/agent writable, then re-run pi doctor" },
					},
				],
				recentErrors: ['{"timestamp":"2026-01-01T00:00:00.000Z","level":"error","message":"boom"}'],
			}),
		);

		expect(report).toContain("== Version ==");
		expect(report).toContain("install method: npm");
		expect(report).toContain("== Environment ==");
		expect(report).toContain("offline mode:   on");
		expect(report).toContain("== Self-check ==");
		expect(report).toContain("[ok]");
		expect(report).toContain("runtime: v22.19.0");
		expect(report).toContain("[degraded] fd: fd not found");
		expect(report).toContain("Next step: winget install sharkdp.fd");
		expect(report).toContain("[blocked]  agent-dir: agent directory is not writable");
		expect(report).toContain("== Loaded resources ==");
		expect(report).toContain("project-local resources: not loaded (project not trusted; re-run with --approve");
		expect(report).toContain("== Recent errors (structured log tail, newest last) ==");
		expect(report).toContain('"level":"error"');
		expect(report).toContain("== Recent crashes (crashes.json) ==");
		expect(report).toContain("blocked checks: 1");
		expect(report).toContain("Result: 1 ok, 1 degraded, 1 blocked");
	});

	test("redacts credentials that arrive through errors and log lines", () => {
		const report = buildDoctorReport(
			reportInput({
				recentErrors: ['{"message":"rejected sk-abcdef123456"}'],
				resources: {
					projectTrusted: false,
					extensions: [],
					extensionErrors: [{ path: "bad.ts", error: "env OPENAI_API_KEY=supersecretvalue" }],
					extensionWarnings: [],
					skills: [],
					prompts: [],
					themes: [],
					contextFiles: [],
					diagnostics: [],
				},
			}),
		);
		expect(report).not.toContain("sk-abcdef123456");
		expect(report).not.toContain("supersecretvalue");
		expect(report).toContain("[redacted]");
	});
});

describe("runDoctorCommand", () => {
	test("--help prints usage and exits 0", async () => {
		let written = "";
		const code = await runDoctorCommand(
			{ kind: "help" },
			{
				write: (text) => {
					written += text;
				},
			},
		);
		expect(code).toBe(0);
		expect(written).toContain(`Usage: ${APP_NAME} doctor [--approve] [--no-extensions]`);
		expect(written).toContain("Options:");
	});

	test("an unknown argument fails with a next step instead of a bare message", async () => {
		const stderr = captureStderr(() => {
			void runDoctorCommand({ kind: "error", message: 'Unknown argument "bogus" for "pi doctor".' });
		});
		expect(stderr).toContain("Error:");
		expect(stderr).toContain("Next step:");
		expect(stderr).toContain(`${APP_NAME} --help`);
	});

	test("a blocked check makes the command exit 1 and prints its remedy", async () => {
		const blocks: string[] = [];
		const code = await runDoctorCommand(
			{ kind: "run", options: {} },
			{
				loadResources: false,
				write: (text) => void blocks.push(text),
				selfChecks: [
					{ id: "runtime", status: "ok", detail: "v22.19.0 (requires >= 22.19.0)" },
					{
						id: "rg",
						status: "blocked",
						detail: "ripgrep (rg) not found; the grep tool fails instead of searching",
						remedy: { nextStep: "winget install BurntSushi.ripgrep.MSVC" },
					},
				],
			},
		);
		const report = blocks.join("");
		expect(code).toBe(1);
		expect(report).toContain("[blocked]  rg:");
		expect(report).toContain("Next step: winget install BurntSushi.ripgrep.MSVC");
		expect(report).toContain("blocked checks: 1");
	});

	test("degraded checks alone stay exit 0", async () => {
		const blocks: string[] = [];
		const code = await runDoctorCommand(
			{ kind: "run", options: {} },
			{
				loadResources: false,
				write: (text) => void blocks.push(text),
				selfChecks: [
					{
						id: "network",
						status: "degraded",
						detail: "offline mode is on, so connectivity was not tested",
						remedy: { nextStep: `${APP_NAME} doctor without PI_OFFLINE` },
					},
				],
			},
		);
		expect(code).toBe(0);
		expect(blocks.join("")).toContain("[degraded] network:");
	});
});

describe("pi doctor as a real command", () => {
	it("prints the report on stdout, keeps stderr empty, and never echoes a credential value", async () => {
		const tempRoot = tempDir("pi-doctor-cmd-");
		const agentDir = join(tempRoot, "agent");
		mkdirSync(agentDir, { recursive: true });

		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
			(resolvePromise, reject) => {
				const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "doctor"], {
					cwd: tempRoot,
					env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				child.on("error", reject);
				child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
			},
		);

		expect(result.stderr).not.toContain("Error:");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`${APP_NAME} doctor — diagnostic report`);
		expect(result.stdout).toContain("Credential redaction guarantee:");
		expect(result.stdout).toContain("== Self-check ==");
		expect(result.stdout).toContain("== Loaded resources ==");
		expect(result.stdout).toContain("agent dir:");
		expect(result.stdout).toContain("project-local resources: not loaded");
		// The machine this runs on may carry real credentials; the report must
		// name them, never print them.
		for (const name of credentialEnvNames()) {
			const value = process.env[name];
			if (value && value.length >= 8) expect(result.stdout).not.toContain(value);
		}
	}, 180_000);
});
