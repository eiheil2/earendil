/**
 * `pi doctor` argument parsing.
 *
 * Kept free of runtime imports so `args.ts` can intercept the subcommand at
 * the parser surface (pi has no central command registry) without pulling the
 * resource loader, settings, and extension graph into every `parseArgs` call.
 * The dispatch side lives in `doctor-command.ts`.
 */
import { APP_NAME } from "../config.ts";

export interface DoctorRunOptions {
	/** Load project-local resources: the root `--approve`/`-a` flag. */
	projectTrusted?: boolean;
	/** Skip extension execution: the root `--no-extensions`/`-ne` flag. */
	noExtensions?: boolean;
}

export type DoctorInvocation =
	| { kind: "run"; options: DoctorRunOptions }
	| { kind: "help" }
	| { kind: "error"; message: string };

/** Usage line shared by `--help` and the error path. */
export function doctorUsage(): string {
	return `Usage: ${APP_NAME} doctor [--approve] [--no-extensions]`;
}

/**
 * Interpret an argv prefix as a `doctor` invocation.
 *
 * Returns `undefined` when the argv is not a doctor invocation. Pure and
 * side-effect free so it can be unit-tested; the caller performs the I/O.
 */
export function parseDoctorArgs(args: readonly string[]): DoctorInvocation | undefined {
	if (args[0] !== "doctor") return undefined;
	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };
	const options: DoctorRunOptions = {};
	for (const arg of rest) {
		if (arg === "--approve" || arg === "-a") {
			options.projectTrusted = true;
		} else if (arg === "--no-extensions" || arg === "-ne") {
			options.noExtensions = true;
		} else {
			return { kind: "error", message: `Unknown argument "${arg}" for "${APP_NAME} doctor".` };
		}
	}
	return { kind: "run", options };
}
