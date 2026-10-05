/**
 * Names are the part of the contract that can be checked mechanically without the host's payload
 * types. The SDK lists the event names and the capability-governed registration methods; the host
 * declares them in `ExtensionAPI`. These tests compare the two listings against the host source, so
 * an SDK that drifts from the host fails here instead of misleading plugin authors.
 *
 * The extraction is textual on purpose: a compiler-level enumeration of the overloads would pin the
 * payload types too, which is the milestone-B host-conformance test, not this one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_API_CAPABILITIES } from "../src/api.ts";
import { EXTENSION_CAPABILITIES } from "../src/capabilities.ts";
import { EXTENSION_EVENT_NAMES } from "../src/events.ts";

const hostTypes = readFileSync(new URL("../../coding-agent/src/core/extensions/types.ts", import.meta.url), "utf8");
const hostLoader = readFileSync(new URL("../../coding-agent/src/core/extensions/loader.ts", import.meta.url), "utf8");

function hostApiMethodNames(): string[] {
	const start = hostTypes.indexOf("export interface ExtensionAPI {");
	const body = hostTypes.slice(start);
	let depth = 0;
	let end = 0;
	for (let index = body.indexOf("{"); index < body.length; index++) {
		if (body[index] === "{") depth++;
		else if (body[index] === "}" && --depth === 0) {
			end = index;
			break;
		}
	}
	// One tab of indentation keeps nested members such as `events.emit` out of the top-level surface.
	return [...body.slice(0, end).matchAll(/^\t([A-Za-z]\w*)(?=[(<])/gm)].map((match) => match[1]);
}

describe("event names", () => {
	it("match the host on() overloads, in the same order", () => {
		const hostEvents = [...hostTypes.matchAll(/on\(\s*event:\s*"([^"]+)"/g)].map((match) => match[1]);
		expect(EXTENSION_EVENT_NAMES).toEqual(hostEvents);
	});

	it("has no duplicates", () => {
		expect(new Set(EXTENSION_EVENT_NAMES).size).toBe(EXTENSION_EVENT_NAMES.length);
	});
});

describe("registration surface", () => {
	it("names only methods the host declares", () => {
		const hostMethods = new Set(hostApiMethodNames());
		for (const method of Object.keys(EXTENSION_API_CAPABILITIES)) {
			expect(hostMethods.has(method)).toBe(true);
		}
	});

	it("maps every method to a declared capability", () => {
		const declared: readonly string[] = EXTENSION_CAPABILITIES;
		for (const [method, capability] of Object.entries(EXTENSION_API_CAPABILITIES)) {
			expect(declared, `${method}`).toContain(capability);
		}
	});

	it("observes only declared capabilities while loading an extension", () => {
		const observed = new Set(
			[...hostLoader.matchAll(/observedCapabilities\.add\("([^"]+)"\)/g)].map((match) => match[1]),
		);
		const declared: readonly string[] = EXTENSION_CAPABILITIES;
		expect(observed.size).toBeGreaterThan(0);
		for (const capability of observed) {
			expect(declared).toContain(capability);
		}
	});

	it("covers every capability except the event bus, which is reached through pi.events", () => {
		const covered = new Set<string>(Object.values(EXTENSION_API_CAPABILITIES));
		const unreachable = EXTENSION_CAPABILITIES.filter((capability) => !covered.has(capability));
		expect(unreachable).toEqual(["eventbus.publish"]);
	});
});
