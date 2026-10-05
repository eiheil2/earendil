/**
 * Fixture integrity: does each fixture still say what it says?
 *
 * The compatibility matrix asserts that these plugins keep working. That assertion is worth exactly as
 * much as the fixtures' immutability, and without a check the immutability is not a property - it is a
 * hope. Someone can make the matrix green by editing the thing the matrix measures, and the edit looks
 * like any other edit in review.
 *
 * So two things are checked here. Every `fixture.json`'s `sha256` must match the directory's actual
 * content hash, which puts the hash in the diff as the reviewable line. And the index must list every
 * fixture directory that exists, which stops a fixture from being added to the tree but quietly left out
 * of the matrix - the failure mode where the matrix is green and covers less than it appears to.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type FixtureMetadata,
	fixtureDigest,
	fixtureDirectory,
	readFixtureIndex,
	readFixtureMetadata,
} from "./fixtures.ts";

const index = readFixtureIndex();
const indexedNames = index.fixtures.map((entry) => `${entry.name}@v${entry.apiVersion}`);

describe("fixture integrity", () => {
	it("indexes every fixture directory that exists", () => {
		const onDisk = [...indexedNames].filter((name) => existsSync(fixtureDirectory(name)));
		expect(onDisk.length, "an indexed fixture directory is missing").toBe(indexedNames.length);
	});

	for (const name of indexedNames) {
		it(`${name} matches its recorded sha256`, () => {
			const metadata = readFixtureMetadata(name) as FixtureMetadata;
			expect(metadata.sha256, `${name} fixture.json has no sha256`).not.toBe("");
			expect(fixtureDigest(name), `${name} content does not match fixture.json`).toBe(metadata.sha256);
		});
	}

	it("records where each fixture came from and when", () => {
		for (const name of indexedNames) {
			const metadata = readFixtureMetadata(name);
			expect(metadata.apiVersion, name).toMatch(/^\d+$/);
			expect(metadata.hostVersionAtCreation, name).toMatch(/^\d+\.\d+\.\d+/);
			expect(metadata.createdAt, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(metadata.source, name).toMatch(/^(?:synthetic|release:[0-9a-f]{7,40})$/);
			expect(metadata.note.length, name).toBeGreaterThan(20);
			expect(metadata.layer, name).toBeGreaterThanOrEqual(1);
			expect(metadata.layer, name).toBeLessThanOrEqual(4);
		}
	});

	it("declares every fixture's api version in the index too", () => {
		for (const entry of index.fixtures) {
			const metadata = readFixtureMetadata(`${entry.name}@v${entry.apiVersion}`);
			expect(metadata.apiVersion, entry.name).toBe(entry.apiVersion);
			expect(entry.note.length, entry.name).toBeGreaterThan(20);
		}
	});

	it("is explicit about which fixtures warn", () => {
		// Silence is the default, so it has to be written down: a fixture that starts warning has changed
		// the host's behaviour, and the record is what makes that visible in review.
		for (const entry of index.fixtures) {
			expect(Array.isArray(entry.expectWarnings), entry.name).toBe(true);
			if (entry.expectWarnings.length > 0) {
				expect(entry.note.toLowerCase(), entry.name).toContain("warn");
			}
		}
	});
});
