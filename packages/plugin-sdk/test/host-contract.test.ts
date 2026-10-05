/**
 * The host cannot take a runtime dependency on the SDK without publishing it, so
 * `packages/coding-agent/src/core/extensions/contract.ts` is a second implementation of the rules in
 * `packages/plugin-sdk/src/compat.ts`. This test is what keeps the two copies honest: it runs the same
 * input matrix through both and requires identical verdicts, message for message.
 *
 * A failure here means one of the two was changed without the other.
 */
import { describe, expect, it } from "vitest";
import { VERSION } from "../../coding-agent/src/config.ts";
import {
	checkExtensionContract as checkHostContract,
	type ExtensionLoadOptions,
} from "../../coding-agent/src/core/extensions/contract.ts";
import { checkExtensionContract as checkSdkContract } from "../src/compat.ts";
import type { ExtensionContractEnvelope } from "../src/manifest.ts";

interface Case {
	name: string;
	envelope?: ExtensionContractEnvelope;
	observed?: string[];
	strict?: boolean;
}

const CASES: Case[] = [
	{ name: "no manifest at all", observed: ["command.register"] },
	{
		name: "current apiVersion with matching capabilities",
		envelope: { apiVersion: "1" },
		observed: ["tool.register"],
	},
	{
		name: "current apiVersion with a missing capability",
		envelope: { apiVersion: "1", capabilities: ["tool.register"] },
		observed: ["command.register"],
	},
	{
		name: "current apiVersion with several undeclared capabilities",
		envelope: { apiVersion: "1", capabilities: [] },
		observed: ["tool.register", "command.register", "event.subscribe"],
	},
	{
		name: "empty capability declaration",
		envelope: { apiVersion: "1", capabilities: [] },
		observed: ["tool.register"],
	},
	{
		name: "over-declared capabilities",
		envelope: { apiVersion: "1", capabilities: ["tool.register", "command.register"] },
		observed: ["command.register"],
	},
	{ name: "future apiVersion", envelope: { apiVersion: "2" }, observed: ["tool.register"] },
	{
		name: "future apiVersion with matching capabilities",
		envelope: { apiVersion: "2", capabilities: ["tool.register"] },
		observed: ["tool.register"],
	},
	{ name: "semver minor as apiVersion", envelope: { apiVersion: "1.0.0" } },
	{ name: "legacy apiVersion", envelope: { apiVersion: "0" }, observed: ["command.register"] },
	{
		name: "unsatisfied minHostVersion",
		envelope: { apiVersion: "1", minHostVersion: ">=99" },
		observed: ["tool.register"],
	},
	{
		name: "satisfied minHostVersion",
		envelope: { apiVersion: "1", minHostVersion: ">=0.0.1" },
		observed: ["tool.register"],
	},
	{
		name: "range that excludes this host",
		envelope: { apiVersion: "1", minHostVersion: "<0.1.0" },
		observed: ["tool.register"],
	},
	{
		name: "invalid minHostVersion",
		envelope: { apiVersion: "1", minHostVersion: "newest" },
		observed: ["tool.register"],
	},
	{
		name: "future apiVersion and unsatisfied minHostVersion",
		envelope: { apiVersion: "3", minHostVersion: ">=99" },
		observed: ["tool.register"],
	},
	{
		name: "unknown capability string in the declaration",
		envelope: { apiVersion: "1", capabilities: ["tool.register", "future.capability"] },
		observed: ["tool.register"],
	},
	{
		name: "experimental entries are not enforced",
		envelope: { apiVersion: "1", capabilities: ["tool.register"], experimental: ["experimental.ui.widget"] },
		observed: ["tool.register"],
	},
	{ name: "nothing observed", envelope: { apiVersion: "1" } },
	{
		name: "duplicate observations",
		envelope: { apiVersion: "1", capabilities: ["tool.register"] },
		observed: ["tool.register", "tool.register"],
	},
	{
		name: "strict with a matching declaration",
		envelope: { apiVersion: "1", capabilities: ["tool.register"] },
		observed: ["tool.register"],
		strict: true,
	},
	{
		name: "strict with an undeclared capability",
		envelope: { apiVersion: "1", capabilities: ["tool.register"] },
		observed: ["command.register"],
		strict: true,
	},
	{ name: "strict with no declaration", observed: ["command.register"], strict: true },
	{ name: "envelope without capabilities", envelope: { minHostVersion: ">=0.0.1" }, observed: ["command.register"] },
	{
		name: "envelope with only experimental entries",
		envelope: { experimental: ["experimental.ui.widget"] },
		observed: ["command.register"],
	},
	{ name: "empty envelope without capabilities", envelope: {}, observed: ["command.register"] },
	{ name: "strict with a future apiVersion", envelope: { apiVersion: "2" }, strict: true },
];

describe("host and SDK agree on the contract rules", () => {
	for (const testCase of CASES) {
		it(testCase.name, () => {
			const observed = testCase.observed ?? [];
			const options: ExtensionLoadOptions = { strictCapabilities: testCase.strict };
			const host = checkHostContract(testCase.envelope ?? null, observed, options);
			const sdk = checkSdkContract({
				envelope: testCase.envelope,
				hostVersion: VERSION,
				observedCapabilities: observed,
				strictCapabilities: testCase.strict,
			});
			expect(host).toEqual(sdk);
		});
	}

	it("the matrix covers both severities", () => {
		const verdicts = CASES.map((testCase) =>
			checkHostContract(testCase.envelope ?? null, testCase.observed ?? [], {
				strictCapabilities: testCase.strict,
			}),
		);
		expect(verdicts.some((verdict) => verdict.errors.length > 0)).toBe(true);
		expect(verdicts.some((verdict) => verdict.warnings.length > 0)).toBe(true);
	});
});
