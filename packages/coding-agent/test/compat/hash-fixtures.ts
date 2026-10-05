/**
 * Print the content hash of every compatibility fixture.
 *
 * Run after changing a fixture on purpose: it prints the `sha256` to paste into that fixture's
 * `fixture.json`. It writes nothing itself, because the hash only does its job if a human copies it into
 * the file - then the diff contains both the content change and the new hash, which is the review point.
 *
 * Usage: node test/compat/hash-fixtures.ts
 */
import { fixtureDigest, indexedFixtures } from "./fixtures.ts";

for (const name of indexedFixtures()) {
	console.log(`${name}\t${fixtureDigest(name)}`);
}
