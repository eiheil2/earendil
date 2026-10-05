/**
 * Minimal XXH32 / XXH64 (seed 0) implementations.
 *
 * The OMP engine computes hashline content tags with `xxhash-rust`;
 * pi has no xxhash dependency, so the exact upstream algorithm is
 * re-implemented here. Constants follow the reference implementation
 * (github.com/Cyan4973/xxHash).
 */

const P32_1 = 0x9e3779b1;
const P32_2 = 0x85ebca77;
const P32_3 = 0xc2b2ae3d;
const P32_4 = 0x27d4eb2f;
const P32_5 = 0x165667b1;

const P64_1 = 0x9e3779b185ebca87n;
const P64_2 = 0xc2b2ae3d27d4eb4fn;
const P64_3 = 0x165667b19e3779f9n;
const P64_4 = 0x85ebca77c2b2ae63n;
const P64_5 = 0x27d4eb2f165667c5n;

const MASK64 = 0xffffffffffffffffn;

const encoder = new TextEncoder();

function toBytes(input: string | Uint8Array): Uint8Array {
	return typeof input === "string" ? encoder.encode(input) : input;
}

function rotl32(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function round32(acc: number, input: number): number {
	acc = (acc + Math.imul(input, P32_2)) >>> 0;
	acc = rotl32(acc, 13);
	return Math.imul(acc, P32_1) >>> 0;
}

/** XXH32 of `input` with seed 0. */
export function xxh32(input: string | Uint8Array, seed = 0): number {
	const bytes = toBytes(input);
	const len = bytes.length;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	let h32: number;
	if (len >= 16) {
		let v1 = (seed + P32_1 + P32_2) >>> 0;
		let v2 = (seed + P32_2) >>> 0;
		let v3 = seed >>> 0;
		let v4 = (seed - P32_1) >>> 0;
		for (; offset + 16 <= len; offset += 16) {
			v1 = round32(v1, view.getUint32(offset, true));
			v2 = round32(v2, view.getUint32(offset + 4, true));
			v3 = round32(v3, view.getUint32(offset + 8, true));
			v4 = round32(v4, view.getUint32(offset + 12, true));
		}
		h32 = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
	} else {
		h32 = (seed + P32_5) >>> 0;
	}
	h32 = (h32 + len) >>> 0;
	while (offset + 4 <= len) {
		h32 = (h32 + Math.imul(view.getUint32(offset, true), P32_3)) >>> 0;
		h32 = Math.imul(rotl32(h32, 17), P32_4) >>> 0;
		offset += 4;
	}
	while (offset < len) {
		h32 = (h32 + Math.imul(bytes[offset], P32_5)) >>> 0;
		h32 = Math.imul(rotl32(h32, 11), P32_1) >>> 0;
		offset += 1;
	}
	h32 = (h32 ^ (h32 >>> 15)) >>> 0;
	h32 = Math.imul(h32, P32_2) >>> 0;
	h32 = (h32 ^ (h32 >>> 13)) >>> 0;
	h32 = Math.imul(h32, P32_3) >>> 0;
	h32 = (h32 ^ (h32 >>> 16)) >>> 0;
	return h32 >>> 0;
}

function rotl64(value: bigint, bits: bigint): bigint {
	return ((value << bits) | (value >> (64n - bits))) & MASK64;
}

function round64(acc: bigint, input: bigint): bigint {
	acc = (acc + input * P64_2) & MASK64;
	acc = rotl64(acc, 31n);
	return (acc * P64_1) & MASK64;
}

function mergeRound64(acc: bigint, value: bigint): bigint {
	acc ^= round64(0n, value);
	return (acc * P64_1 + P64_4) & MASK64;
}

/** XXH64 of `input` with seed 0, returned as a 64-bit unsigned integer. */
export function xxh64(input: string | Uint8Array, seed = 0n): bigint {
	const bytes = toBytes(input);
	const len = bytes.length;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const seedBig = typeof seed === "bigint" ? seed : BigInt(seed);
	let offset = 0;
	let h64: bigint;
	if (len >= 32) {
		let v1 = (seedBig + P64_1 + P64_2) & MASK64;
		let v2 = (seedBig + P64_2) & MASK64;
		let v3 = seedBig & MASK64;
		let v4 = (seedBig - P64_1) & MASK64;
		for (; offset + 32 <= len; offset += 32) {
			v1 = round64(v1, view.getBigUint64(offset, true));
			v2 = round64(v2, view.getBigUint64(offset + 8, true));
			v3 = round64(v3, view.getBigUint64(offset + 16, true));
			v4 = round64(v4, view.getBigUint64(offset + 24, true));
		}
		h64 = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & MASK64;
		h64 = mergeRound64(h64, v1);
		h64 = mergeRound64(h64, v2);
		h64 = mergeRound64(h64, v3);
		h64 = mergeRound64(h64, v4);
	} else {
		h64 = (seedBig + P64_5) & MASK64;
	}
	h64 = (h64 + BigInt(len)) & MASK64;
	while (offset + 8 <= len) {
		const k1 = round64(0n, view.getBigUint64(offset, true));
		h64 ^= k1;
		h64 = (rotl64(h64, 27n) * P64_1 + P64_4) & MASK64;
		offset += 8;
	}
	if (offset + 4 <= len) {
		h64 ^= BigInt(view.getUint32(offset, true)) * P64_1;
		h64 = (rotl64(h64, 23n) * P64_2 + P64_3) & MASK64;
		offset += 4;
	}
	while (offset < len) {
		h64 ^= BigInt(bytes[offset]) * P64_5;
		h64 = (rotl64(h64, 11n) * P64_1) & MASK64;
		offset += 1;
	}
	h64 ^= h64 >> 33n;
	h64 = (h64 * P64_2) & MASK64;
	h64 ^= h64 >> 29n;
	h64 = (h64 * P64_3) & MASK64;
	h64 ^= h64 >> 32n;
	return h64 & MASK64;
}
