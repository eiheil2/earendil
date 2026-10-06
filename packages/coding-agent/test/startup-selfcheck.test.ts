import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hasBlockedSelfCheck,
	NETWORK_PROBE_TIMEOUT_MS,
	OFFLINE_LOST_CAPABILITIES,
	runStartupSelfChecks,
	type StartupSelfCheck,
	startNetworkProbe,
	summarizeSelfChecks,
} from "../src/core/startup-selfcheck.ts";
import { termuxInstallCommand } from "../src/utils/tools-manager.ts";

/** Network is always injected in tests; no test may open a real connection. */
const noNetwork = async (): Promise<void> => {};

const originalOffline = process.env.PI_OFFLINE;
const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;
const originalColorTerm = process.env.COLORTERM;

let tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
	restore("PI_OFFLINE", originalOffline);
	restore("NO_COLOR", originalNoColor);
	restore("TERM", originalTerm);
	restore("COLORTERM", originalColorTerm);
	vi.unstubAllGlobals();
});

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-selfcheck-"));
	tempDirs.push(dir);
	return dir;
}

function byId(checks: StartupSelfCheck[], id: StartupSelfCheck["id"]): StartupSelfCheck {
	const found = checks.find((check) => check.id === id);
	if (!found) throw new Error(`missing check ${id}`);
	return found;
}

describe("runStartupSelfChecks (AC-D01)", () => {
	it("returns the six checks in order, each in one of the three states", async () => {
		const checks = await runStartupSelfChecks({
			cwd: process.cwd(),
			offline: false,
			probeNetwork: noNetwork,
			toolPath: () => "/usr/local/bin/fd",
		});

		expect(checks.map((check) => check.id)).toEqual(["fd", "rg", "git", "network", "terminal-colors", "cwd"]);
		for (const check of checks) {
			expect(["ready", "degraded", "blocked"]).toContain(check.state);
			expect(check.detail.length).toBeGreaterThan(0);
			expect(check.label.length).toBeGreaterThan(0);
		}
		// A row that is not ready always says what to run (AC-D01: fix command).
		for (const check of checks.filter((entry) => entry.state !== "ready")) {
			expect(check.fix).toBeTruthy();
		}
	});

	it("reports ready for an installed tool and for a writable working directory", async () => {
		const cwd = makeTempDir();
		// vitest runs with PI_OFFLINE=1; this case exercises the online path with a mocked probe.
		const checks = await runStartupSelfChecks({
			cwd,
			offline: false,
			probeNetwork: noNetwork,
			toolPath: () => "/usr/local/bin/fd",
		});

		expect(byId(checks, "fd").state).toBe("ready");
		expect(byId(checks, "fd").detail).toBe("/usr/local/bin/fd");
		expect(byId(checks, "cwd").state).toBe("ready");
		expect(byId(checks, "network").state).toBe("ready");
		expect(summarizeSelfChecks(checks)).toEqual({ ready: 6, degraded: 0, blocked: 0 });
		expect(hasBlockedSelfCheck(checks)).toBe(false);
	});

	it("blocks with a fix command when the working directory does not exist", async () => {
		const missing = join(makeTempDir(), "never-created");
		const checks = await runStartupSelfChecks({ cwd: missing, probeNetwork: noNetwork, toolPath: () => "/bin/fd" });

		const cwd = byId(checks, "cwd");
		expect(cwd.state).toBe("blocked");
		expect(cwd.fix).toBe(`mkdir -p "${missing}"`);
		expect(hasBlockedSelfCheck(checks)).toBe(true);
		expect(summarizeSelfChecks(checks).blocked).toBe(1);
	});
});

describe("AC-D04 Termux install commands", () => {
	it("gives the exact pkg command for a missing tool on Android", async () => {
		const checks = await runStartupSelfChecks({
			cwd: process.cwd(),
			platform: "android",
			offline: true,
			probeNetwork: noNetwork,
			toolPath: () => null,
		});

		const fd = byId(checks, "fd");
		const rg = byId(checks, "rg");
		expect(fd.state).toBe("degraded");
		expect(fd.fix).toBe("pkg install fd");
		expect(rg.fix).toBe("pkg install ripgrep");
		expect(fd.detail).toContain("Termux");
		expect(fd.loss).toContain("@file autocomplete");
		expect(rg.loss).toContain("grep tool");
	});

	it("never suggests pkg outside Android", async () => {
		expect(termuxInstallCommand("fd", "win32")).toBeNull();
		expect(termuxInstallCommand("fd", "darwin")).toBeNull();
		expect(termuxInstallCommand("fd", "linux")).toBeNull();
		expect(termuxInstallCommand("fd", "android")).toBe("pkg install fd");

		for (const platform of ["win32", "darwin", "linux"]) {
			const checks = await runStartupSelfChecks({
				cwd: process.cwd(),
				platform,
				offline: true,
				probeNetwork: noNetwork,
				toolPath: () => null,
			});
			expect(byId(checks, "fd").fix).not.toMatch(/^pkg /);
			expect(byId(checks, "rg").fix).not.toMatch(/^pkg /);
		}
		expect(
			byId(
				await runStartupSelfChecks({
					cwd: process.cwd(),
					platform: "win32",
					offline: true,
					probeNetwork: noNetwork,
					toolPath: () => null,
				}),
				"fd",
			).fix,
		).toBe("winget install sharkdp.fd");
	});
});

describe("AC-D03 offline degradation", () => {
	it("degrades the network check, skips the probe, and lists every lost capability", async () => {
		process.env.PI_OFFLINE = "1";
		const probe = vi.fn(noNetwork);

		const checks = await runStartupSelfChecks({
			cwd: process.cwd(),
			probeNetwork: probe,
			toolPath: () => "/bin/fd",
		});

		expect(probe).not.toHaveBeenCalled();
		const network = byId(checks, "network");
		expect(network.state).toBe("degraded");
		expect(network.detail).toContain("offline mode");
		expect(network.loss).toContain("fd/rg auto-download");
		expect(network.loss).toContain("model catalog refresh");
		expect(network.loss).toContain("new-version check");
		expect(network.loss).toContain("extension/skill/prompt/theme package install");
		expect(network.loss).toContain("provider sign-in and token refresh");
		expect(network.fix).toContain("PI_OFFLINE");
	});

	it("lists the offline losses even when the tool checks are ready", async () => {
		const checks = await runStartupSelfChecks({
			cwd: process.cwd(),
			offline: true,
			probeNetwork: noNetwork,
			toolPath: () => "/bin/fd",
		});

		const loss = byId(checks, "network").loss ?? "";
		expect(OFFLINE_LOST_CAPABILITIES).toHaveLength(loss.split("; ").length);
		expect(byId(checks, "fd").state).toBe("ready");
		expect(byId(checks, "network").state).toBe("degraded");
	});

	it("degrades (never blocks) when the probe cannot reach the network", async () => {
		const checks = await runStartupSelfChecks({
			cwd: process.cwd(),
			offline: false,
			probeNetwork: async () => {
				throw new Error("getaddrinfo ENOTFOUND example.invalid");
			},
			toolPath: () => "/bin/fd",
		});

		const network = byId(checks, "network");
		expect(network.state).toBe("degraded");
		expect(network.detail).toContain("ENOTFOUND");
		expect(network.loss).toContain("fd/rg auto-download");
		expect(summarizeSelfChecks(checks).blocked).toBe(0);
	});
});

describe("network probe constraints (AC-D01)", () => {
	it("stays under the2s budget", () => {
		expect(NETWORK_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
	});

	it("sends one credential-free HEAD request and never an API call", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		await startNetworkProbe();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://pi.dev/");
		expect(init.method).toBe("HEAD");
		expect(init.redirect).toBe("manual");
		expect(init.credentials).toBe("omit");
		expect(JSON.stringify(init.headers ?? {})).toBe("{}");
	});

	it("resolves on any HTTP answer and rejects only on transport failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);
		await expect(startNetworkProbe()).resolves.toBeUndefined();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		await expect(startNetworkProbe()).rejects.toThrow("fetch failed");
	});
});
