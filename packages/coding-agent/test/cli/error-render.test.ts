import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
	CAUSE_CHAIN_DEPTH,
	formatCauseChain,
	formatRemedy,
	formatUserError,
	formatUserWarning,
	reportUserError,
	reportUserHint,
	reportUserWarning,
} from "../../src/core/error-render.ts";
import { credentialEnvNames, isCredentialEnvName, REDACTED, redactSecrets } from "../../src/core/redact.ts";
import { configureStructuredLog, readStructuredLogTail } from "../../src/core/structured-log.ts";

// One log directory for the whole file: every test that writes a record needs
// a known location, and rotating the config per test would leak directories.
const logDir = mkdtempSync(join(tmpdir(), "pi-error-render-log-"));

/** Run `fn` with stderr captured; returns everything written, unparsed. */
function captureStderr(fn: () => void): string {
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		fn();
		return spy.mock.calls.map((call) => String(call[0])).join("");
	} finally {
		spy.mockRestore();
	}
}

beforeEach(() => {
	configureStructuredLog({ directory: logDir });
});

afterAll(() => {
	rmSync(logDir, { recursive: true, force: true });
});

describe("formatCauseChain", () => {
	test("expands nested causes outermost first, capped at CAUSE_CHAIN_DEPTH", () => {
		let root: Error | undefined;
		let current: Error | undefined;
		for (let index = 1; index <= 8; index++) {
			const next = new Error(`level ${index}`);
			if (current) current.cause = next;
			if (!root) root = next;
			current = next;
		}
		const chain = formatCauseChain(root);
		expect(chain.length).toBe(CAUSE_CHAIN_DEPTH);
		expect(chain[0]).toBe("level 1");
		expect(chain).not.toContain("level 8");
	});

	test("keeps a single message when cause repeats it", () => {
		const error = new Error("same message", { cause: new Error("same message") });
		expect(formatCauseChain(error)).toEqual(["same message"]);
	});

	test("reads duck-typed errors that do not extend Error", () => {
		expect(formatCauseChain({ message: "rpc payload failed" })).toEqual(["rpc payload failed"]);
		expect(formatCauseChain(undefined)).toEqual([]);
	});

	test("appends a trailing string cause", () => {
		const error = new Error("outer", { cause: "socket hang up" });
		expect(formatCauseChain(error)).toEqual(["outer", "socket hang up"]);
	});
});

describe("remedy rendering", () => {
	test("renders a next step as a pasteable line", () => {
		expect(formatRemedy({ nextStep: "pi doctor" })).toEqual(["Next step: pi doctor"]);
	});

	test("renders no-fix with its impact", () => {
		expect(
			formatRemedy({ noFix: { reason: "the file lives on a read-only share", impact: "sessions cannot be saved" } }),
		).toEqual(["No fix available: the file lives on a read-only share", "Impact: sessions cannot be saved"]);
	});

	test("formatUserError carries the cause chain and the remedy", () => {
		const text = formatUserError({
			message: "model catalog failed to load",
			cause: new Error("ENOENT: no such file or directory"),
			remedy: { nextStep: "pi doctor" },
		});
		expect(text).toBe(
			[
				"Error: model catalog failed to load",
				"  caused by: ENOENT: no such file or directory",
				"  Next step: pi doctor",
			].join("\n"),
		);
	});

	test("formatUserWarning prefixes warnings and allows extra details", () => {
		const text = formatUserWarning({
			message: "theme file ignored",
			details: ["path: /tmp/theme.json"],
			remedy: { nextStep: "pi --help" },
		});
		expect(text.split("\n")[0]).toBe("Warning: theme file ignored");
		expect(text).toContain("  path: /tmp/theme.json");
	});
});

describe("report sinks", () => {
	test("reportUserError writes to stderr only and mirrors a redacted log record", () => {
		const stderr = captureStderr(() => {
			reportUserError({ message: "login failed", remedy: { nextStep: "pi doctor" } });
		});
		expect(stderr).toContain("Error: login failed");
		expect(stderr).toContain("Next step: pi doctor");

		const tail = readStructuredLogTail(5);
		expect(tail.some((line) => line.includes("login failed") && line.includes('"level":"error"'))).toBe(true);
	});

	test("structured log records are redacted before they hit the disk", () => {
		captureStderr(() => {
			reportUserError({ message: "rejected token sk-abcdef123456", remedy: { nextStep: "pi doctor" } });
		});

		const tail = readStructuredLogTail(5);
		const record = tail.find((line) => line.includes("rejected token"));
		expect(record).toBeDefined();
		expect(record).toContain(REDACTED);
		expect(record).not.toContain("sk-abcdef123456");
	});

	test("reportUserWarning renders a warning block", () => {
		const stderr = captureStderr(() => {
			reportUserWarning({ message: "package settings ignored", remedy: { nextStep: "pi doctor" } });
		});
		expect(stderr).toContain("Warning: package settings ignored");
	});

	test("reportUserHint prints the hint verbatim, without a severity prefix", () => {
		const stderr = captureStderr(() => {
			reportUserHint('Hint: Start without extensions using "pi -ne".');
		});
		expect(stderr).toContain('Hint: Start without extensions using "pi -ne".');
		expect(stderr).not.toContain("Warning:");
		expect(readStructuredLogTail(5).some((line) => line.includes("Start without extensions"))).toBe(true);
	});
});

describe("redactSecrets", () => {
	test("masks well-known key shapes", () => {
		const text = "key=sk-proj-ABCDEFGH1234 ghp_ABCDEFG12345 AKIAABCDEFGHIJKLMNOP AIzaSyXXXXXXXXXXXXX";
		const redacted = redactSecrets(text);
		expect(redacted).not.toMatch(/sk-proj-ABCDEFGH1234|ghp_ABCDEFG12345|AKIAABCDEFGHIJKLMNOP|AIzaSyXXXXXXXXXXXXX/);
		expect(redacted).toContain(REDACTED);
	});

	test("masks credentials smuggled through query strings", () => {
		expect(redactSecrets("https://api.example/v1?api_key=supersecret&limit=10")).toBe(
			`https://api.example/v1?api_key=${REDACTED}&limit=10`,
		);
	});

	test('masks credentials written as NAME=value or "NAME": "value" pairs', () => {
		expect(redactSecrets("env OPENAI_API_KEY=supersecretvalue")).toBe(`env OPENAI_API_KEY=${REDACTED}`);
		expect(redactSecrets('"OPENAI_API_KEY": "supersecretvalue"')).toBe(`"OPENAI_API_KEY": "${REDACTED}"`);
		expect(redactSecrets("plain OPENAI_API_KEY and a path C:\\work")).toContain("OPENAI_API_KEY");
	});

	test("masks values of credential environment variables and leaves other text alone", () => {
		process.env.PI_TEST_SECRET_VALUE = "hunter2hunter2";
		try {
			expect(redactSecrets("value is hunter2hunter2")).toBe(`value is ${REDACTED}:PI_TEST_SECRET_VALUE`);
			expect(redactSecrets("plain message")).toBe("plain message");
		} finally {
			delete process.env.PI_TEST_SECRET_VALUE;
		}
	});

	test("credentialEnvNames reports names only", () => {
		process.env.PI_TEST_CREDENTIAL_NAME = "hunter2hunter2";
		try {
			expect(credentialEnvNames()).toContain("PI_TEST_CREDENTIAL_NAME");
			expect(credentialEnvNames().join(" ")).not.toContain("hunter2hunter2");
		} finally {
			delete process.env.PI_TEST_CREDENTIAL_NAME;
		}
	});

	test("isCredentialEnvName recognizes credential names only", () => {
		expect(isCredentialEnvName("OPENAI_API_KEY")).toBe(true);
		expect(isCredentialEnvName("GITHUB_TOKEN")).toBe(true);
		expect(isCredentialEnvName("PATH")).toBe(false);
	});
});
