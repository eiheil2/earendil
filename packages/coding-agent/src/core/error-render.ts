/**
 * Unified rendering for user-visible errors.
 *
 * Everything pi prints as an error goes through here instead of writing to a
 * stream directly: the renderer expands the cause chain (AC-F05), demands a
 * remedy (AC-F07), writes to stderr only so piped stdout stays clean and the
 * TUI's screen is not corrupted (AC-F06), and mirrors the record into the
 * rotating structured log.
 */
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { logEvent } from "./structured-log.ts";

/** Depth cap for cause chains, matching `utils/tools-manager.ts:386-393`. */
export const CAUSE_CHAIN_DEPTH = 5;

/**
 * What the reader should do next.
 *
 * `nextStep` is the actionable case: a command (or, when the fix is an edit to
 * the user's own argv/config, the exact edit) that moves the failure forward.
 * `noFix` is the honest case: nothing to run, plus what the failure costs.
 */
export type ErrorRemedy = { nextStep: string } | { noFix: { reason: string; impact: string } };

export interface ErrorDetails {
	/** One-line summary printed after the severity prefix. */
	message: string;
	/** Underlying errors, expanded one `caused by:` line each. */
	cause?: unknown;
	/** Extra context lines: paths, counts, affected scope. */
	details?: readonly string[];
}

export interface UserErrorOptions extends ErrorDetails {
	remedy: ErrorRemedy;
}

export interface UserWarningOptions extends ErrorDetails {
	remedy?: ErrorRemedy;
}

/**
 * Walk `error.cause` and return each distinct message, outermost first.
 *
 * Fetch and fs failures hide the actionable detail (DNS, TLS, EACCES) behind a
 * bare outermost message; a depth cap guards against circular chains.
 */
export function formatCauseChain(error: unknown, maxDepth = CAUSE_CHAIN_DEPTH): string[] {
	if (error === undefined || error === null) return [];
	if (!(error instanceof Error)) {
		// Duck-typed errors (RPC payloads, provider SDK failures) carry a message
		// without extending Error.
		const message = (error as { message?: unknown }).message;
		const text = typeof message === "string" && message.length > 0 ? message : String(error);
		return text.length > 0 ? [text] : [];
	}
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < maxDepth; depth++) {
		if (current.message.length > 0 && !messages.includes(current.message)) messages.push(current.message);
		current = current.cause;
	}
	if (typeof current === "string" && current.length > 0 && !messages.includes(current)) messages.push(current);
	return messages;
}

function remedyLines(remedy: ErrorRemedy): string[] {
	if ("nextStep" in remedy) return [`Next step: ${remedy.nextStep}`];
	return [`No fix available: ${remedy.noFix.reason}`, `Impact: ${remedy.noFix.impact}`];
}

/** Render a remedy as its `Next step:` / `No fix available:` + `Impact:` lines. */
export function formatRemedy(remedy: ErrorRemedy): string[] {
	return remedyLines(remedy);
}

function buildLines(options: ErrorDetails, remedy: ErrorRemedy | undefined, label: string): string[] {
	const lines = [`${label}: ${options.message}`];
	for (const message of formatCauseChain(options.cause)) lines.push(`  caused by: ${message}`);
	for (const detail of options.details ?? []) lines.push(`  ${detail}`);
	// Indented under the message: the remedy belongs to the error it answers.
	if (remedy) lines.push(...remedyLines(remedy).map((line) => `  ${line}`));
	return lines;
}

/** Render an error block as plain text (no color), for tests and log mirrors. */
export function formatUserError(options: UserErrorOptions): string {
	return buildLines(options, options.remedy, "Error").join("\n");
}

/** Render a warning block; warnings may pass a remedy but do not require one. */
export function formatUserWarning(options: UserWarningOptions): string {
	return buildLines(options, options.remedy, "Warning").join("\n");
}

function write(text: string): void {
	process.stderr.write(`${text}\n`);
}

/**
 * Print an error and mirror it to the structured log.
 *
 * The remedy is required by the type: an error shown to a user either carries
 * the next action or states that there is none and what that costs.
 */
export function reportUserError(options: UserErrorOptions): void {
	const lines = buildLines(options, options.remedy, "Error");
	write(chalk.red(lines[0]) + (lines.length > 1 ? `\n${lines.slice(1).join("\n")}` : ""));
	logEvent("error", options.message, {
		remedy: options.remedy,
		cause: formatCauseChain(options.cause).join(": "),
		details: options.details ? [...options.details] : undefined,
	});
}

/** Print a warning and mirror it to the structured log. */
export function reportUserWarning(options: UserWarningOptions): void {
	const lines = buildLines(options, options.remedy, "Warning");
	write(chalk.yellow(lines[0]) + (lines.length > 1 ? `\n${lines.slice(1).join("\n")}` : ""));
	logEvent("warn", options.message, {
		remedy: options.remedy,
		cause: formatCauseChain(options.cause).join(": "),
		details: options.details ? [...options.details] : undefined,
	});
}

/**
 * Print a hint verbatim (no severity prefix) plus its optional remedy line.
 *
 * Startup hints are authored as complete sentences — `Hint: Start without
 * extensions using "pi -ne".` — and prefixing them with `Warning:` would break
 * the quoted command. They still land in the structured log so `pi doctor`
 * sees them.
 */
export function reportUserHint(message: string, remedy?: ErrorRemedy): void {
	const lines = [message, ...(remedy ? remedyLines(remedy) : [])];
	write(lines.map((line) => chalk.yellow(line)).join("\n"));
	logEvent("warn", message, { remedy });
}

/** Remedy for CLI usage errors: the help output lists every valid spelling. */
export const HELP_REMEDY: ErrorRemedy = { nextStep: `${APP_NAME} --help` };

/** Remedy for failures that need a full diagnostic pass before they can be fixed. */
export const DOCTOR_REMEDY: ErrorRemedy = { nextStep: `${APP_NAME} doctor` };
