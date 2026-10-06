#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { getAgentDir } from "./config.ts";
import { reportStartupFailure } from "./core/startup-diagnostics.ts";
import { main } from "./main.ts";

setupCli();
// An error that escapes main() is a startup failure: the terminal gets the
// short reason plus the path of the private full report (AC-F04) instead of a
// bare stack trace.
main(process.argv.slice(2)).catch(async (error: unknown) => {
	await reportStartupFailure(error, { home: getAgentDir(), phase: "startup" });
	process.exitCode = 1;
});
