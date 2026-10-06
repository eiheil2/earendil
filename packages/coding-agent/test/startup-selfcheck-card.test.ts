import { beforeAll, describe, expect, test, vi } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import {
	OFFLINE_LOST_CAPABILITIES,
	runStartupSelfChecks,
	type StartupSelfCheck,
} from "../src/core/startup-selfcheck.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function normalize(container: Container, width = 500): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n");
}

/** Six checks in AC-D01 order, all ready; tests override the rows they care about. */
function readyChecks(): StartupSelfCheck[] {
	return [
		{ id: "fd", label: "fd", state: "ready", detail: "/usr/bin/fd" },
		{ id: "rg", label: "rg", state: "ready", detail: "/usr/bin/rg" },
		{ id: "git", label: "git", state: "ready", detail: "git version 2.45.0" },
		{ id: "network", label: "network", state: "ready", detail: "reachable (HEAD https://pi.dev/)" },
		{
			id: "terminal-colors",
			label: "terminal colors",
			state: "ready",
			detail: "TERM=xterm-256color COLORTERM=(unset)",
		},
		{ id: "cwd", label: "working directory", state: "ready", detail: "/home/dev/project (writable)" },
	];
}

interface FakeThis {
	chatContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	settingsManager: {
		getPermissionPreset: () => string;
		getConfirmDestructive: () => boolean;
	};
	sessionManager: { getCwd: () => string };
	shouldShowStartupDetails: () => boolean;
}

function createFakeThis(options: {
	showDetails: boolean;
	preset?: string;
	confirmDestructive?: boolean;
	cwd?: string;
}): FakeThis {
	return {
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		settingsManager: {
			getPermissionPreset: () => options.preset ?? "workspace-write",
			getConfirmDestructive: () => options.confirmDestructive ?? true,
		},
		sessionManager: { getCwd: () => options.cwd ?? "/home/dev/project" },
		shouldShowStartupDetails: () => options.showDetails,
	};
}

function renderCard(fakeThis: FakeThis, checks: readonly StartupSelfCheck[]): string {
	(InteractiveMode as any).prototype.showStartupSelfCheckCard.call(fakeThis, checks);
	return normalize(fakeThis.chatContainer);
}

describe("InteractiveMode.showStartupSelfCheckCard (AC-D01)", () => {
	beforeAll(() => initTheme("dark"));

	test("renders all six rows in AC order with a ready/degraded/blocked summary", () => {
		const checks = readyChecks();
		checks[3] = {
			id: "network",
			label: "network",
			state: "degraded",
			detail: "unreachable: ENOTFOUND pi.dev",
			loss: "unavailable offline: fd/rg auto-download (find and grep need a local install instead)",
			fix: "check network or proxy settings, then restart to re-enable them",
		};
		checks[5] = {
			id: "cwd",
			label: "working directory",
			state: "blocked",
			detail: "/home/dev/project is not writable for the current user",
			fix: 'chmod u+w "/home/dev/project"',
		};

		const output = renderCard(createFakeThis({ showDetails: true }), checks);

		expect(output).toContain("Startup self-check");
		expect(output).toContain("4 ready, 1 degraded, 1 blocked");
		const labels = ["fd:", "rg:", "git:", "network:", "terminal colors:", "working directory:"];
		const positions = labels.map((label) => {
			const position = output.indexOf(`] ${label}`);
			expect(position).toBeGreaterThan(-1);
			return position;
		});
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);

		// degraded: loss + fix are spelled out; ready rows carry neither.
		expect(output).toContain("loss: unavailable offline: fd/rg auto-download");
		expect(output).toContain("fix:  check network or proxy settings");
		expect(output).toContain("fix:  chmod u+w");
		expect(output).toContain("✗ [blocked] working directory: /home/dev/project is not writable");
		expect(output).not.toContain("loss: git");
		// doctor hint appears only while something is not ready.
		expect(output).toContain("doctor");
	});

	test("hides the card without a blocked row when startup details are quieted", () => {
		const fakeThis = createFakeThis({ showDetails: false });
		renderCard(fakeThis, readyChecks());
		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still renders a blocked row when startup details are quieted", () => {
		const checks = readyChecks();
		checks[5] = {
			id: "cwd",
			label: "working directory",
			state: "blocked",
			detail: "/gone does not exist and cannot be created",
			fix: 'mkdir -p "/gone"',
		};

		const output = renderCard(createFakeThis({ showDetails: false }), checks);
		expect(output).toContain("✗ [blocked] working directory: /gone does not exist");
		expect(output).toContain("fix:  mkdir -p");
	});
});

describe("self-check card offline row (AC-D03)", () => {
	beforeAll(() => initTheme("dark"));

	test("lists every capability lost to offline mode on the degraded network row", async () => {
		const checks = await runStartupSelfChecks({
			offline: true,
			toolPath: () => "/usr/local/bin/tool",
			probeNetwork: () => Promise.resolve(),
		});

		const output = renderCard(createFakeThis({ showDetails: true }), checks);
		expect(output).toContain("[degraded] network: offline mode (PI_OFFLINE or --offline) is on");
		for (const capability of OFFLINE_LOST_CAPABILITIES) {
			expect(output).toContain(capability);
		}
		expect(output).toContain("fix:  unset PI_OFFLINE and restart pi");
	});

	test("does not open a connection in offline mode", async () => {
		const probeNetwork = vi.fn(() => Promise.resolve());
		await runStartupSelfChecks({ offline: true, toolPath: () => null, probeNetwork });
		expect(probeNetwork).not.toHaveBeenCalled();
	});
});

describe("self-check card Termux install commands (AC-D04)", () => {
	beforeAll(() => initTheme("dark"));

	test("carries the exact pkg install commands for missing fd/rg on Android", async () => {
		const checks = await runStartupSelfChecks({
			platform: "android",
			offline: false,
			toolPath: () => null,
			probeNetwork: () => Promise.resolve(),
		});

		const output = renderCard(createFakeThis({ showDetails: true }), checks);
		expect(output).toContain("[degraded] fd: fd is not installed; the downloaded glibc binary cannot run on Termux");
		expect(output).toContain("fix:  pkg install fd");
		expect(output).toContain("[degraded] rg: rg is not installed; the downloaded glibc binary cannot run on Termux");
		expect(output).toContain("fix:  pkg install ripgrep");
		// git on Termux has no pkg hint row here because it is installed in this environment;
		// the fd/rg rows are the AC-D04 target.
		expect(output).toContain("[ok] git:");
	});
});

describe("permission/sandbox boundary on the card (AC-D07)", () => {
	beforeAll(() => initTheme("dark"));

	test("states preset, confirmation state, cwd and the no-OS-sandbox boundary", () => {
		const output = renderCard(
			createFakeThis({ showDetails: true, preset: "workspace-write", confirmDestructive: true }),
			readyChecks(),
		);

		expect(output).toContain("Permissions & sandbox");
		expect(output).toContain('Permissions: preset "workspace-write" (confirmation on)');
		expect(output).toContain(
			"Sandbox: no built-in OS sandbox - commands run with your user's permissions in /home/dev/project",
		);
		expect(output).toContain("README: Permissions & Containerization");
		expect(output).toContain("project-local skills, prompts and extensions stay unloaded");
		// Everything ready: no doctor hint below the boundary block.
		expect(output).not.toContain("doctor");
	});

	test("reports confirmation off when the one-click switch or preset disables it", () => {
		const switchedOff = renderCard(createFakeThis({ showDetails: true, confirmDestructive: false }), readyChecks());
		expect(switchedOff).toContain('preset "workspace-write" (confirmation off)');

		const presetOff = renderCard(createFakeThis({ showDetails: true, preset: "danger-full-access" }), readyChecks());
		expect(presetOff).toContain('preset "danger-full-access" (confirmation off)');
		expect(presetOff).toContain("Full file access without approval prompts.");
	});
});
