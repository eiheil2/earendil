/**
 * Startup failure diagnostics.
 *
 * The terminal gets the short reason (AC-F03); the full report goes to a
 * private file under the agent directory with 0600 permissions and its path is
 * echoed (AC-F04). When the write fails the report is printed in full instead
 * of a path that does not exist — the DSH `startup-diagnostics.ts:57-67`
 * branch.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { APP_NAME, VERSION } from "../config.ts";
import { redactSecrets } from "./redact.ts";
import { logEvent } from "./structured-log.ts";

/**
 * First line of every report, and the guarantee `pi doctor` states in the
 * package itself (AC-F02).
 */
export const DIAGNOSTICS_WARNING =
	"WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.";

export interface StartupFailureContext {
	/** Private directory the report is written under (`<home>/logs`). */
	home: string;
	version?: string;
	/** Startup phase or command that failed. */
	phase?: string;
}

export interface StartupFailureOptions {
	/** Terminal sink; awaited before returning, defaults to stderr. */
	write?: (text: string) => void | Promise<void>;
	/** Print the short reason line before the path (DSH default: true). */
	printReason?: boolean;
}

/** Wait for the stream to finish the write before the failed process exits. */
function writeStderr(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stderr.write(text, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function reasonOf(error: unknown): string {
	if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
	return String(error);
}

/**
 * Build the redacted full report: sharing warning first, then versions and the
 * inspected error with its complete cause chain.
 */
export function formatStartupFailureReport(error: unknown, context: StartupFailureContext, now = new Date()): string {
	const body = inspect(
		{
			timestamp: now.toISOString(),
			piVersion: context.version ?? VERSION,
			phase: context.phase ?? "startup",
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			cwd: process.cwd(),
			error,
		},
		{
			depth: null,
			maxArrayLength: null,
			maxStringLength: null,
			showHidden: true,
			customInspect: false,
			getters: false,
			colors: false,
		},
	);
	return `${DIAGNOSTICS_WARNING}\n\n${redactSecrets(body)}\n`;
}

/**
 * Print the short reason, save the full report to a private uniquely named
 * file, and echo its path. A failed write prints the complete report instead
 * of claiming a path.
 *
 * @returns the saved report path, or `undefined` when the report was printed
 * instead of written.
 */
export async function reportStartupFailure(
	error: unknown,
	context: StartupFailureContext,
	options: StartupFailureOptions = {},
): Promise<string | undefined> {
	const write = options.write ?? writeStderr;
	const now = new Date();
	const report = formatStartupFailureReport(error, context, now);
	if (options.printReason !== false) {
		await write(`${reasonOf(error)}\n`);
	}
	const logDir = join(context.home, "logs");
	const logPath = join(logDir, `startup-${now.toISOString().replaceAll(":", "-")}-${randomUUID()}.log`);
	try {
		await mkdir(logDir, { recursive: true, mode: 0o700 });
		await writeFile(logPath, report, { flag: "wx", mode: 0o600 });
	} catch (writeError) {
		logEvent("error", "startup diagnostics could not be written", { path: logDir, error: writeError });
		await write(
			`\n${APP_NAME}: warning: could not write startup diagnostics: ${String(writeError)}\n` +
				`Full diagnostics:\n${report}`,
		);
		return undefined;
	}
	await write(`\nFull diagnostics: ${logPath}\n`);
	return logPath;
}
