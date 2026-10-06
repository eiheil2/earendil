import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../src/config.ts";
import {
	configureStructuredLog,
	logEvent,
	readStructuredLogTail,
	structuredLogPath,
} from "../../src/core/structured-log.ts";

let logDir: string;

beforeEach(() => {
	logDir = mkdtempSync(join(tmpdir(), "pi-structured-log-"));
	configureStructuredLog({ directory: logDir });
});

afterEach(() => {
	rmSync(logDir, { recursive: true, force: true });
});

function logFiles(): string[] {
	return readdirSync(logDir).filter((name) =>
		new RegExp(`^${APP_NAME}\\.\\d{4}-\\d{2}-\\d{2}\\.\\d+\\.jsonl`).test(name),
	);
}

describe("structured log rotation (AC-F06)", () => {
	test("rolls to a numbered copy once the file passes maxBytes, keeping maxFiles", () => {
		configureStructuredLog({ directory: logDir, maxBytes: 1, maxFiles: 3 });
		for (let index = 0; index < 6; index++) logEvent("error", `record ${index}`);

		const files = logFiles();
		const base = structuredLogPath().split(/[\\/]/).pop() ?? "";
		expect(files.length).toBeGreaterThan(1);
		expect(files.length).toBeLessThanOrEqual(3);
		expect(files).toContain(`${base}.1`);
		// The oldest copy is dropped rather than growing the set without bound.
		expect(files).not.toContain(`${base}.3`);
	});

	test("ages out files older than the retention window on first write", () => {
		const stale = join(logDir, `${APP_NAME}.2000-01-01.424242.jsonl`);
		writeFileSync(stale, "{}\n");
		const old = new Date("2000-01-01T00:00:00Z");
		utimesSync(stale, old, old);

		configureStructuredLog({ directory: logDir, retentionDays: 1 });
		logEvent("info", "fresh record");

		expect(existsSync(stale)).toBe(false);
		expect(logFiles().length).toBeGreaterThan(0);
	});

	test("keeps recent files within the retention window", () => {
		const recent = join(logDir, `${APP_NAME}.2000-01-01.424243.jsonl`);
		writeFileSync(recent, "{}\n");

		configureStructuredLog({ directory: logDir, retentionDays: 14 });
		logEvent("info", "fresh record");

		expect(existsSync(recent)).toBe(true);
	});
});

describe("structured log sinks (AC-F06)", () => {
	test("never writes to stdout or stderr", () => {
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			logEvent("error", "quiet failure");
		} finally {
			outSpy.mockRestore();
			errSpy.mockRestore();
		}
		expect(outSpy).not.toHaveBeenCalled();
		expect(errSpy).not.toHaveBeenCalled();
	});

	test("returns the tail oldest record first, for pi doctor", () => {
		logEvent("info", "first record");
		logEvent("warn", "second record");
		logEvent("error", "third record");

		const tail = readStructuredLogTail(10);
		expect(tail.length).toBe(3);
		expect(tail[0]).toContain("first record");
		expect(tail[2]).toContain("third record");
	});
});

describe.skipIf(process.platform === "win32")("structured log permissions (AC-F06)", () => {
	test("creates the log file 0600 in a 0700 directory", () => {
		configureStructuredLog({ directory: join(logDir, "nested"), maxBytes: 1024 });
		logEvent("info", "private record");

		expect(statSync(structuredLogPath()).mode & 0o777).toBe(0o600);
		expect(statSync(join(logDir, "nested")).mode & 0o777).toBe(0o700);
	});
});
