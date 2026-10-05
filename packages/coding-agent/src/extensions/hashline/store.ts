/** Session-scoped snapshots, clipboard registers, and no-op loop state. */

import { fileHash, payloadHash } from "./hash.ts";
import type { Clipboard } from "./types.ts";
import { clipboardCommitFrom, clipboardStartBatch } from "./types.ts";

export const DEFAULT_MAX_PATHS = 256;
export const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
export const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const NOOP_HARD_LIMIT = 3;

export interface Snapshot {
	/** Canonical path this version belongs to. */
	path: string;
	/** Full LF-normalized, BOM-stripped text. */
	text: string;
	/** Four-character content tag. */
	hash: string;
	/** Lines displayed from this version, when provenance was recorded. */
	seen_lines: Set<number> | undefined;
}

interface StoredSnapshot {
	snapshot: Snapshot;
	units: number;
}

interface PathHistory {
	versions: StoredSnapshot[];
	touched: number;
}

function retainedUnits(history: PathHistory): number {
	return 1 + history.versions.reduce((sum, version) => sum + version.units, 0);
}

interface StoreState {
	histories: Map<string, PathHistory>;
	clipboard: Clipboard;
	noop: Map<string, { payload: bigint; count: number }>;
	clock: number;
	maxPaths: number;
	maxVersions: number;
	maxTotalUnits: number;
	retainedUnits: number;
}

function defaultState(): StoreState {
	return {
		histories: new Map(),
		clipboard: { lines: undefined, named: undefined, pending_anon_cuts: undefined },
		noop: new Map(),
		clock: 0,
		maxPaths: DEFAULT_MAX_PATHS,
		maxVersions: DEFAULT_MAX_VERSIONS_PER_PATH,
		maxTotalUnits: DEFAULT_MAX_TOTAL_BYTES,
		retainedUnits: 0,
	};
}

/** Thread-safe state shared for the lifetime of an edit session. */
export class EditStore {
	#state: StoreState;

	constructor(state?: StoreState) {
		this.#state = state ?? defaultState();
	}

	static withLimits(maxPaths: number, maxVersions: number, maxTotalUnits: number): EditStore {
		const state = defaultState();
		state.maxPaths = maxPaths;
		state.maxVersions = maxVersions;
		state.maxTotalUnits = maxTotalUnits;
		return new EditStore(state);
	}

	/** Record normalized text under a canonical path and return its tag. */
	record(path: string, text: string, seenLines: number[] | undefined): string {
		const hash = fileHash(text);
		const state = this.#state;
		state.clock += 1;
		const touched = state.clock;
		const maxVersions = state.maxVersions;
		let previousUnits = 0;
		let history = state.histories.get(path);
		if (history !== undefined) previousUnits = retainedUnits(history);
		else history = { versions: [], touched };
		history.touched = touched;
		const index = history.versions.findIndex(
			(version) => version.snapshot.hash === hash && version.snapshot.text === text,
		);
		if (index !== -1) {
			const [snapshot] = history.versions.splice(index, 1);
			mergeSeen(snapshot.snapshot, seenLines);
			history.versions.unshift(snapshot);
		} else if (maxVersions > 0) {
			const snapshot: Snapshot = { path, text, hash, seen_lines: undefined };
			mergeSeen(snapshot, seenLines);
			history.versions.unshift({ snapshot, units: utf16Length(text) });
			history.versions.length = Math.min(history.versions.length, maxVersions);
		}
		state.histories.set(path, history);
		state.retainedUnits = state.retainedUnits - previousUnits + retainedUnits(history);
		evict(state);
		return hash;
	}

	/** Union displayed lines into the most recent version matching a tag. */
	recordSeenLines(path: string, hash: string, lines: number[]): void {
		const state = this.#state;
		touch(state, path);
		const version = state.histories.get(path)?.versions.find((v) => v.snapshot.hash === hash);
		if (version !== undefined) mergeSeen(version.snapshot, lines);
	}

	head(path: string): Snapshot | undefined {
		const state = this.#state;
		touch(state, path);
		const history = state.histories.get(path);
		return history?.versions[0]?.snapshot;
	}

	byHash(path: string, hash: string): Snapshot | undefined {
		const state = this.#state;
		touch(state, path);
		return state.histories.get(path)?.versions.find((v) => v.snapshot.hash === hash)?.snapshot;
	}

	byContent(path: string, text: string): Snapshot | undefined {
		const state = this.#state;
		touch(state, path);
		return state.histories.get(path)?.versions.find((v) => v.snapshot.text === text)?.snapshot;
	}

	findByHash(hash: string): Snapshot[] {
		const out: Snapshot[] = [];
		for (const history of this.#state.histories.values()) {
			for (const version of history.versions) {
				if (version.snapshot.hash === hash) out.push(version.snapshot);
			}
		}
		return out;
	}

	invalidate(path: string): void {
		const state = this.#state;
		const history = state.histories.get(path);
		if (history !== undefined) {
			state.histories.delete(path);
			state.retainedUnits -= retainedUnits(history);
		}
	}

	relocate(from: string, to: string): void {
		const state = this.#state;
		state.clock += 1;
		const touched = state.clock;
		const maxVersions = state.maxVersions;
		const source = state.histories.get(from);
		if (source === undefined) return;
		state.histories.delete(from);
		state.retainedUnits -= retainedUnits(source);
		for (const version of source.versions) version.snapshot.path = to;
		const merged = source.versions;
		const destination = state.histories.get(to);
		if (destination !== undefined) {
			state.histories.delete(to);
			state.retainedUnits -= retainedUnits(destination);
			merged.push(...destination.versions);
		}
		const seen = new Set<string>();
		const retained: StoredSnapshot[] = [];
		for (const version of merged) {
			if (seen.has(version.snapshot.hash)) continue;
			seen.add(version.snapshot.hash);
			retained.push(version);
		}
		retained.length = Math.min(retained.length, maxVersions);
		const history: PathHistory = { versions: retained, touched };
		state.retainedUnits += retainedUnits(history);
		state.histories.set(to, history);
		evict(state);
	}

	clear(): void {
		this.#state = defaultState();
	}

	/** Start a clipboard batch with persisted named registers. */
	startClipboardBatch(): Clipboard {
		return clipboardStartBatch(this.#state.clipboard);
	}

	/** Publish named registers from a batch fork. */
	commitClipboard(fork: Clipboard): void {
		clipboardCommitFrom(this.#state.clipboard, fork);
	}

	/** Record an identical no-op and return its consecutive count and escalation state. */
	recordNoop(path: string, payload: bigint): [number, boolean] {
		const state = this.#state;
		const existing = state.noop.get(path);
		const count = existing !== undefined && existing.payload === payload ? existing.count + 1 : 1;
		state.noop.set(path, { payload, count });
		return [count, count >= NOOP_HARD_LIMIT];
	}

	resetNoop(path: string): void {
		this.#state.noop.delete(path);
	}
}

function mergeSeen(snapshot: Snapshot, lines: number[] | undefined): void {
	if (lines === undefined) return;
	if (snapshot.seen_lines === undefined) snapshot.seen_lines = new Set();
	for (const line of lines) snapshot.seen_lines.add(line);
}

function touch(state: StoreState, path: string): void {
	const history = state.histories.get(path);
	if (history !== undefined) {
		state.clock += 1;
		history.touched = state.clock;
	}
}

function evict(state: StoreState): void {
	while (state.histories.size > state.maxPaths || state.retainedUnits > state.maxTotalUnits) {
		let oldest: string | undefined;
		let oldestTouched = Number.POSITIVE_INFINITY;
		for (const [path, history] of state.histories) {
			if (history.touched < oldestTouched) {
				oldest = path;
				oldestTouched = history.touched;
			}
		}
		if (oldest === undefined) return;
		const history = state.histories.get(oldest);
		state.histories.delete(oldest);
		if (history !== undefined) state.retainedUnits -= retainedUnits(history);
	}
}

function utf16Length(text: string): number {
	return text.length;
}

export { payloadHash };
