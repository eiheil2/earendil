import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { VERSION } from "../../src/config.ts";
import { REDACTED } from "../../src/core/redact.ts";
import {
	DIAGNOSTICS_WARNING,
	formatStartupFailureReport,
	reportStartupFailure,
} from "../../src/core/startup-diagnostics.ts";

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempRoots.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Collects what would have been printed to stderr. */
function sink(): { lines: string[]; write: (text: string) => void } {
	const lines: string[] = [];
	return { lines, write: (text: string) => void lines.push(text) };
}

describe("formatStartupFailureReport", () => {
	test("leads with the sharing warning and carries versions, phase, and cause chain", () => {
		const error = Object.assign(new Error("extension loader exploded"), {
			cause: new Error("Unexpected token } in JSON"),
		});
		const report = formatStartupFailureReport(error, { home: "/home/u/.pi/agent", phase: "startup" });

		expect(report.startsWith(DIAGNOSTICS_WARNING)).toBe(true);
		expect(report).toContain(`piVersion: '${VERSION}'`);
		expect(report).toContain("phase: 'startup'");
		expect(report).toContain("extension loader exploded");
		expect(report).toContain("Unexpected token } in JSON");
	});

	test("redacts credentials embedded in the failing error", () => {
		const report = formatStartupFailureReport(
			new Error("request to https://api.example/v1 failed with api_key=supersecret123"),
			{ home: "/home/u/.pi/agent" },
		);
		expect(report).not.toContain("supersecret123");
		expect(report).toContain(REDACTED);
	});
});

describe("reportStartupFailure", () => {
	test("writes the report to a private file and echoes its path", async () => {
		const home = tempDir("pi-startup-diag-");
		const captured = sink();

		const path = await reportStartupFailure(
			new Error("boom: no such file"),
			{ home, phase: "startup" },
			{
				write: captured.write,
			},
		);

		expect(path).toBeDefined();
		expect(captured.lines.join("")).toContain("boom: no such file");
		expect(captured.lines.join("")).toContain(`Full diagnostics: ${path}`);

		const content = readFileSync(path!, "utf8");
		expect(content.startsWith(DIAGNOSTICS_WARNING)).toBe(true);
		expect(content).toContain("boom: no such file");
		expect(path).toContain(home);

		// 0600 on POSIX; Windows does not model POSIX modes, so this assertion
		// only carries where the permission bit means something.
		if (process.platform !== "win32") {
			expect(statSync(path!).mode & 0o777).toBe(0o600);
		}
	});

	test("prints the full report instead of a path when the write fails", async () => {
		const home = tempDir("pi-startup-diag-fail-");
		// A file where the log directory should be: mkdir <home>/logs fails.
		writeFileSync(join(home, "logs"), "occupied", "utf8");
		const captured = sink();

		const path = await reportStartupFailure(
			new Error("boom when no dir can be made"),
			{ home },
			{
				write: captured.write,
			},
		);

		expect(path).toBeUndefined();
		const printed = captured.lines.join("");
		expect(printed).toContain("could not write startup diagnostics");
		expect(printed).toContain("Full diagnostics:\n");
		expect(printed).toContain(DIAGNOSTICS_WARNING);
		expect(printed).toContain("boom when no dir can be made");
	});

	test("can omit the short reason line", async () => {
		const home = tempDir("pi-startup-diag-quiet-");
		const captured = sink();

		await reportStartupFailure(new Error("quiet failure"), { home }, { write: captured.write, printReason: false });

		expect(captured.lines.join("")).not.toContain("quiet failure\n");
		expect(captured.lines.join("")).toContain("Full diagnostics: ");
	});
});
