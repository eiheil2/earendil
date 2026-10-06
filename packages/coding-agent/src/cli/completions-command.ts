/**
 * `pi completions <bash|zsh|fish>` — print a shell completion script.
 *
 * Wired into `parseArgs` (see args.ts): pi has no central command registry, so
 * the subcommand is intercepted at the parser surface and dispatched here.
 */

import { APP_NAME } from "../config.ts";
import { generateCompletion, isShell, type Shell, shellList } from "./completion-gen.ts";

export type CompletionsParse =
	| { kind: "script"; shell: Shell }
	| { kind: "help" }
	| { kind: "error"; message: string }
	| undefined;

/**
 * Interpret an argv prefix as a `completions` invocation.
 *
 * Returns `undefined` when the argv is not a completions invocation. Pure and
 * side-effect free so it can be unit-tested; the caller performs the I/O.
 */
export function parseCompletionsArgs(args: readonly string[]): CompletionsParse {
	if (args[0] !== "completions") return undefined;
	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };
	if (rest.length !== 1) {
		return { kind: "error", message: `Usage: ${APP_NAME} completions <${shellList().join("|")}>` };
	}
	const shell = rest[0];
	if (!isShell(shell)) {
		return { kind: "error", message: `Unknown shell "${shell}". Valid values: ${shellList().join(", ")}` };
	}
	return { kind: "script", shell };
}

/** Handle `pi completions ...` argv. Returns the process exit code. */
export function runCompletionsCommand(args: readonly string[]): number {
	const parsed = parseCompletionsArgs(args);
	if (parsed === undefined) return 2;
	if (parsed.kind === "help") {
		process.stdout.write(
			`Usage: ${APP_NAME} completions <${shellList().join("|")}>\nPrint a shell completion script generated from the active command metadata.\n`,
		);
		return 0;
	}
	if (parsed.kind === "error") {
		process.stderr.write(`${parsed.message}\n`);
		return 1;
	}
	process.stdout.write(generateCompletion(parsed.shell));
	return 0;
}
