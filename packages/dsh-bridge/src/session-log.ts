/**
 * Minimal session-log journal for the dsh-bridge.
 *
 * In-memory record of bridge-relevant entries (plugin start, apply enter/exit,
 * service provide/get, fail-soft markers) for the offline Phase 3-① demo.
 * Entries are flat JSON-compatible objects; no file I/O, no @deepseek-ai/*
 * imports, no network.
 */

/** One journal entry — flat fields only. */
export type SessionEntry = {
	/** Monotonically increasing entry identifier. */
	seq: number;
	/** Journal format version. */
	version: number;
	/** Entry kind: "plugin_start" | "apply_enter" | "apply_exit" | "apply_exit_fail" | "provide" | "get". */
	kind: string;
	/** Plugin name, e.g. "command-compact". */
	plugin: string;
	/** Optional free-form detail string. */
	detail?: string;
	/** Optional ISO timestamp, set by the caller. */
	timestamp?: string;
};

/** In-memory journal store. */
export class SessionLog {
	private items: SessionEntry[] = [];
	private nextSeq = 1;
	private readonly baseVersion: number;

	/**
	 * @param baseVersion - version stamped on every entry (default 1).
	 */
	constructor(baseVersion: number = 1) {
		this.baseVersion = baseVersion;
	}

	/** Record a new entry and return it. */
	push(entry: Omit<SessionEntry, "seq" | "version">): SessionEntry {
		const record: SessionEntry = {
			seq: this.nextSeq++,
			version: this.baseVersion,
			...entry,
		};
		this.items.push(record);
		return record;
	}

	/** All entries (read-only view). */
	entries(): Readonly<SessionEntry[]> {
		return this.items;
	}

	/** The last entry, or undefined when empty. */
	last(): SessionEntry | undefined {
		return this.items[this.items.length - 1];
	}

	/** Clear all entries (between demo runs). */
	reset(): void {
		this.items = [];
		this.nextSeq = 1;
	}
}

/** Convenience entry factories (seq assigned on push; 0 here marks "unpushed"). */
export function pluginStart(pluginName: string): SessionEntry {
	return { seq: 0, version: 1, kind: "plugin_start", plugin: pluginName };
}

export function applyEnter(pluginName: string): SessionEntry {
	return { seq: 0, version: 1, kind: "apply_enter", plugin: pluginName };
}

export function applyExit(pluginName: string, ok: boolean, detail?: string): SessionEntry {
	return {
		seq: 0,
		version: 1,
		kind: ok ? "apply_exit" : "apply_exit_fail",
		plugin: pluginName,
		detail: detail ?? undefined,
	};
}

export function serviceProvide(pluginName: string, svcName: string): SessionEntry {
	return { seq: 0, version: 1, kind: "provide", plugin: pluginName, detail: svcName };
}

export function serviceGet(pluginName: string, svcName: string, found: boolean): SessionEntry {
	return {
		seq: 0,
		version: 1,
		kind: "get",
		plugin: pluginName,
		detail: found ? svcName : `missing:${svcName}`,
	};
}
