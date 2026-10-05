/** Content-hash helpers. Port of `crates/pi-edit/src/store.rs` file_hash/payload_hash. */

import { xxh64 } from "./xxhash.ts";

const encoder = new TextEncoder();

/**
 * Compute the four-hex uppercase hashline content tag.
 *
 * Hashes the text with trailing spaces, tabs, and CRs stripped from every
 * line. Unchanged runs between stripped spans are fed straight from `text`,
 * so no normalized copy is built.
 */
export function fileHash(text: string): string {
	const bytes = encoder.encode(text);
	// xxh32 is streaming; feed segment slices via an incremental wrapper.
	const hasher = new Xxh32Incremental();
	let runStart = 0;
	let lineStart = 0;
	for (const segment of splitInclusive(text, "\n")) {
		const segBytes = encoder.encode(segment);
		const line = segment.endsWith("\n") ? segment.slice(0, -1) : segment;
		const keptSegment = line.replace(/[ \t\r]+$/u, "");
		const kept = encoder.encode(keptSegment).length;
		if (kept < segBytes.length - (segment.endsWith("\n") ? 1 : 0)) {
			hasher.update(bytes.subarray(runStart, lineStart + kept));
			runStart = lineStart + segBytes.length;
		}
		lineStart += segBytes.length;
	}
	hasher.update(bytes.subarray(runStart));
	return (hasher.digest() & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

/** Compute a stable 64-bit key for raw patch input. */
export function payloadHash(text: string): bigint {
	return xxh64(text, 0n);
}

function splitInclusive(text: string, delimiter: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let index = text.indexOf(delimiter, start);
	while (index !== -1) {
		parts.push(text.slice(start, index + delimiter.length));
		start = index + delimiter.length;
		index = text.indexOf(delimiter, start);
	}
	if (start < text.length) parts.push(text.slice(start));
	return parts;
}

/** Incremental XXH32 wrapper mirroring the streaming `xxhash_rust::Xxh32`. */
class Xxh32Incremental {
	#buffer = new Uint8Array(0);
	#total = 0;
	#v1 = 0;
	#v2 = 0;
	#v3 = 0;
	#v4 = 0;
	#initialized = false;

	update(bytes: Uint8Array): void {
		this.#total += bytes.length;
		const combined = concat(this.#buffer, bytes);
		let offset = 0;
		if (!this.#initialized && combined.length >= 16) {
			this.#v1 = (0 + 0x9e3779b1 + 0x85ebca77) >>> 0;
			this.#v2 = 0x85ebca77 >>> 0;
			this.#v3 = 0 >>> 0;
			this.#v4 = (0 - 0x9e3779b1) >>> 0;
			this.#initialized = true;
		}
		if (this.#initialized) {
			const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
			for (; offset + 16 <= combined.length; offset += 16) {
				this.#v1 = round(this.#v1, view.getUint32(offset, true));
				this.#v2 = round(this.#v2, view.getUint32(offset + 4, true));
				this.#v3 = round(this.#v3, view.getUint32(offset + 8, true));
				this.#v4 = round(this.#v4, view.getUint32(offset + 12, true));
			}
		}
		this.#buffer = combined.slice(offset);
	}

	digest(): number {
		const rest = this.#buffer;
		let h32: number;
		if (this.#initialized) {
			h32 = (rotl(this.#v1, 1) + rotl(this.#v2, 7) + rotl(this.#v3, 12) + rotl(this.#v4, 18)) >>> 0;
		} else {
			h32 = (0 + 0x165667b1) >>> 0;
		}
		h32 = (h32 + this.#total) >>> 0;
		const view = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
		let offset = 0;
		while (offset + 4 <= rest.length) {
			h32 = (h32 + Math.imul(view.getUint32(offset, true), 0xc2b2ae3d)) >>> 0;
			h32 = Math.imul(rotl(h32, 17), 0x27d4eb2f) >>> 0;
			offset += 4;
		}
		while (offset < rest.length) {
			h32 = (h32 + Math.imul(rest[offset], 0x165667b1)) >>> 0;
			h32 = Math.imul(rotl(h32, 11), 0x9e3779b1) >>> 0;
			offset += 1;
		}
		h32 = (h32 ^ (h32 >>> 15)) >>> 0;
		h32 = Math.imul(h32, 0x85ebca77) >>> 0;
		h32 = (h32 ^ (h32 >>> 13)) >>> 0;
		h32 = Math.imul(h32, 0xc2b2ae3d) >>> 0;
		h32 = (h32 ^ (h32 >>> 16)) >>> 0;
		return h32 >>> 0;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function rotl(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function round(acc: number, input: number): number {
	acc = (acc + Math.imul(input, 0x85ebca77)) >>> 0;
	acc = rotl(acc, 13);
	return Math.imul(acc, 0x9e3779b1) >>> 0;
}

export { Xxh32Incremental };
