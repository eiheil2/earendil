/**
 * Minimal duck-typed Context proxy that delegates to pi's ExtensionAPI.
 *
 * Purpose: allow Cordis-style plugins (e.g. command-compact) to run through pi
 * without importing @deepseek-ai/cordis at runtime. The proxy satisfies the
 * structural shape of snapshots/cordis-context-ts.ts; missing host capabilities
 * trigger fail-soft downgrade (warn + no-op) instead of throwing.
 *
 * Constraint: chord facet path is CLOSED (plan-plugin-contract §5, MERGE-FINAL
 * §3 R4). Only the ExtensionAPI narrow path is used.
 */

/** Result of a command handler; mirrors DSH CommandResult (see snapshot). */
export type CommandResult =
	| { kind: "success"; text?: string; sourceEventSeq?: number }
	| { kind: "error"; text: string };

/** One command execution handed to a plugin handler (DSH CommandInvocation subset). */
export type CommandInvocation = {
	commandId: string;
	agent: unknown;
	rawInput: string;
	signal: AbortSignal;
};

/** What `compactNow` resolves with; `null` means nothing compactable yet. */
export type CompactionSummary = {
	readonly shadowedSeqs: readonly number[];
	readonly shadowedTokenCount: number;
	readonly summarySeq: number;
};

/**
 * Host-facing seam. Capabilities are optional: the bridge degrades per missing
 * member (fail-soft) instead of requiring a complete host.
 */
export type ExtensionApi = {
	/** Subscribe to a named event. Returns an unsubscribe function. */
	on?: (event: string, handler: (...args: unknown[]) => void) => () => void;
	/** Register a slash-style command; receives the raw argument string. */
	registerCommand?: (
		name: string,
		options: { description?: string; handler: (args: string) => Promise<CommandResult> },
	) => void;
};

/** Bridge Context — the shape `apply(ctx)` receives. Matches the snapshot Context. */
export type Context = {
	events: {
		on: (event: string, handler: (...args: unknown[]) => void) => () => void;
	};
	compaction: {
		compactNow: (agent: unknown, signal: AbortSignal, commandId: string) => Promise<CompactionSummary | null>;
	};
	commands: {
		register: (opts: {
			definitionId: string;
			name: string;
			description: string;
			handler: (invocation: CommandInvocation) => Promise<CommandResult>;
		}) => () => void;
	};
	effect: (factory: () => Generator<unknown, void, unknown>, key: string) => () => void;
	reflect: {
		provide: (name: string, impl: unknown) => void;
		get: (name: string) => unknown;
	};
};

/**
 * Create a Cordis-like ctx delegating to the pi ExtensionAPI.
 *
 * Fail-soft contract: every host capability is checked at call time; a missing
 * one logs a readable warning and degrades to a no-op (disposer for
 * registrations), never throwing out of `apply(ctx)`.
 *
 * @param ext - host ExtensionAPI object; missing members degrade per feature.
 * @returns a Context satisfying the snapshot plugin's structural type.
 */
export function createCordisContext(ext: ExtensionApi): Context {
	// Per-context service store backing ctx.reflect.
	const services = new Map<string, unknown>();

	return {
		events: {
			on: (event, handler) => {
				if (typeof ext.on !== "function") {
					console.warn(`dsh-bridge: event "${event}" dropped; host has no event bus (fail-soft)`);
					return () => {};
				}
				return ext.on(event, handler);
			},
		},
		compaction: {
			// The minimal bridge owns this seam: no session history is attached,
			// so compaction honestly reports "nothing to compact" (null).
			compactNow: async () => null,
		},
		commands: {
			register: (opts) => {
				if (typeof ext.registerCommand !== "function") {
					console.warn(
						`dsh-bridge: commands service unavailable, "${opts.name}" command not registered (fail-soft)`,
					);
					return () => {};
				}
				const signal = new AbortController().signal;
				ext.registerCommand(opts.name, {
					description: opts.description,
					handler: (args: string) =>
						opts.handler({
							commandId: `bridge:${opts.name}`,
							agent: undefined,
							rawInput: args,
							signal,
						}),
				});
				return () => {};
			},
		},
		effect: (factory, key) => {
			// Drive the generator like a cordis fiber: each yielded value is a
			// teardown; run them in reverse order on dispose.
			const teardowns: Array<() => unknown> = [];
			const runTeardowns = (): void => {
				for (let i = teardowns.length - 1; i >= 0; i--) {
					const t = teardowns[i];
					try {
						const r = t();
						if (r instanceof Promise) r.catch(() => {});
					} catch {
						// A failing teardown must not take down the host (fail-soft).
					}
				}
				teardowns.length = 0;
			};
			try {
				const iterator = factory();
				let step = iterator.next();
				while (!step.done) {
					// Generator yields are untyped (`Generator<unknown, void, unknown>`); by
					// cordis convention yielded functions are teardowns.
					if (typeof step.value === "function") teardowns.push(step.value as () => unknown);
					step = iterator.next();
				}
			} catch (error) {
				console.error(`dsh-bridge: effect "${key}" failed: ${String(error)} (fail-soft)`);
				runTeardowns();
				return () => {};
			}
			return runTeardowns;
		},
		reflect: {
			provide: (svcName, impl) => {
				services.set(svcName, impl);
			},
			get: (svcName) => services.get(svcName),
		},
	};
}
