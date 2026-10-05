/**
 * Bridge smoke test for Phase 3-① acceptance.
 *
 * Runs the faithful command-compact snapshot through the bridge: apply(ctx)
 * drives the plugin's generator effect, registers `/compact` on the host, and
 * executes the real handler logic (usage rejection + empty-history success).
 * Also proves fail-soft degradation when the host lacks a capability.
 *
 * Targeted unit test (not the full vitest suite):
 *   node <repo>/node_modules/vitest/dist/cli.js --run test/bridge-smoke.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apply, inject, name } from "../snapshots/command-compact-index.ts";
import { type Context, createCordisContext, type ExtensionApi } from "../src/index.ts";
import { SessionLog } from "../src/session-log.ts";

describe("dsh-bridge Phase 3-① smoke", () => {
	const on = vi.fn().mockReturnValue(() => {});
	const registerCommand = vi.fn();
	let ext: ExtensionApi;
	let ctx: Context;

	beforeEach(() => {
		vi.clearAllMocks();
		ext = { on, registerCommand };
		ctx = createCordisContext(ext);
	});

	it("(a1) real plugin metadata and apply(ctx) registers /compact via the bridge", () => {
		// Snapshot exports match the real DSH plugin's identity.
		expect(name).toBe("command-compact");
		expect(inject).toEqual(["commands", "compaction"]);

		// apply drives ctx.effect (generator), which registers the command.
		expect(() => apply(ctx)).not.toThrow();
		expect(registerCommand).toHaveBeenCalledTimes(1);
		expect(registerCommand).toHaveBeenCalledWith(
			"compact",
			expect.objectContaining({ description: "Compact older conversation history" }),
		);

		// Duck-typed context exposes every field the plugin requires.
		expect(typeof ctx.events.on).toBe("function");
		expect(typeof ctx.compaction.compactNow).toBe("function");
		expect(typeof ctx.commands.register).toBe("function");
		expect(typeof ctx.effect).toBe("function");
		expect(typeof ctx.reflect.provide).toBe("function");
	});

	it("(a2) the registered handler executes the real plugin logic", async () => {
		apply(ctx);

		// Handler captured from the host registration.
		const options = registerCommand.mock.calls[0][1] as {
			handler: (args: string) => Promise<{ kind: string; text?: string }>;
		};

		// Non-empty input hits the plugin's usage guard (original logic).
		const usage = await options.handler("please compact now");
		expect(usage).toEqual({ kind: "error", text: "Usage: /compact (no arguments)" });

		// Empty input reaches ctx.compaction.compactNow through the bridge,
		// which honestly reports no compactable history (null).
		const empty = await options.handler("");
		expect(empty).toEqual({ kind: "success", text: "No compactable history yet." });
	});

	it("(b) missing registerCommand degrades fail-soft: readable warn, apply does not throw", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const extNoCommands: ExtensionApi = { on };
		const ctxNoCommands = createCordisContext(extNoCommands);

		expect(() => apply(ctxNoCommands)).not.toThrow();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('dsh-bridge: commands service unavailable, "compact"'));
		// Host untouched: nothing registered.
		expect(registerCommand).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("(c) ctx.events.on delegates to ext.on and unsubscribes", () => {
		const handler = () => {};
		const unsub = ctx.events.on("test-event", handler);
		expect(on).toHaveBeenCalledWith("test-event", handler);
		unsub(); // host mock returns its own disposer; must not throw
	});

	it("(d) missing event bus degrades fail-soft with a readable warn", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctxNoBus = createCordisContext({ registerCommand });
		const unsub = ctxNoBus.events.on("agent_start", () => {});
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("host has no event bus"));
		unsub();
		warn.mockRestore();
	});

	it("(e) snapshot provenance: origin path, commit, and real plugin logic present", () => {
		const snapshotPath = path.resolve(import.meta.dirname, "../snapshots/command-compact-index.ts");
		const content = fs.readFileSync(snapshotPath, "utf-8");
		expect(content).toMatch(/commit `?639ed015/);
		expect(content).toMatch(/packages\/compaction\/command-compact\/src\/index\.ts/);
		// Proof the snapshot carries the original logic, not a hollow shell:
		expect(content).toMatch(/Usage: \/compact \(no arguments\)/);
		expect(content).toMatch(/shadowedSeqs\.length/);
		expect(content).toMatch(/command-compact lifecycle/);
	});

	it("(f) SessionLog journal records and resets", () => {
		const journal = new SessionLog();
		journal.push({ kind: "plugin_start", plugin: "command-compact" });
		expect(journal.entries()).toHaveLength(1);
		expect(journal.last()?.seq).toBe(1);
		journal.reset();
		expect(journal.entries()).toHaveLength(0);
	});
});
