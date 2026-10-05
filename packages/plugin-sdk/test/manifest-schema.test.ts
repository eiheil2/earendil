import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ExtensionContractSchema } from "../src/manifest.ts";

describe("manifest contract schema", () => {
	it("locks apiVersion to the exact contract version", () => {
		expect(Check(ExtensionContractSchema, { apiVersion: "1" })).toBe(true);
		expect(Check(ExtensionContractSchema, { apiVersion: "2" })).toBe(false);
		expect(Check(ExtensionContractSchema, { apiVersion: 1 })).toBe(false);
	});

	it("rejects capability typos but accepts the whole enumeration", () => {
		expect(Check(ExtensionContractSchema, { capabilities: ["tool.register", "event.subscribe"] })).toBe(true);
		expect(Check(ExtensionContractSchema, { capabilities: ["tool.regsiter"] })).toBe(false);
		expect(Check(ExtensionContractSchema, { capabilities: ["command.register", "experimental.ui.widget"] })).toBe(
			false,
		);
	});

	it("ignores unknown keys, because the host must stay forward compatible", () => {
		expect(Check(ExtensionContractSchema, { apiVersion: "1", futureField: true })).toBe(true);
		expect(Check(ExtensionContractSchema, { extensions: ["./dist/index.js"] })).toBe(true);
	});

	it("accepts experimental entries, which are never checked against the enumeration", () => {
		expect(Check(ExtensionContractSchema, { experimental: ["experimental.ui.widget"] })).toBe(true);
	});

	it("rejects envelope fields of the wrong type", () => {
		expect(Check(ExtensionContractSchema, { minHostVersion: 1 })).toBe(false);
		expect(Check(ExtensionContractSchema, { capabilities: "tool.register" })).toBe(false);
	});
});
