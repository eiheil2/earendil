import { describe, expect, it } from "vitest";
import {
	AmbiguousIdentityError,
	billingVariantPlain,
	classifyModel,
	collapseVariantId,
	routingVariantPlain,
} from "../src/compat/classify-model.ts";
import golden from "./data/compat-classify-model-golden.json" with { type: "json" };

// Golden fixture generated from the OMP reference implementation
// (oh-my-pi packages/catalog/src/compat/taxonomy.ts bundled with esbuild and
// executed under Node); see PHASE2-CLASSIFYMODEL.md for the exact command.
const fixture = golden as {
	classify: Array<{
		provider: string;
		modelId: string;
		strict: unknown;
		lenient: unknown;
	}>;
	routingVariantPlain: Array<{ provider: string; model: string; out: string | null }>;
	billingVariantPlain: Array<{ model: string; out: string | null }>;
	collapseVariantId: Array<{ provider: string; model: string; out: unknown }>;
	strictThrows: Array<{
		provider: string;
		modelId: string;
		strict: { error?: string; message?: string; out?: unknown };
		lenient: { out?: unknown };
	}>;
};

describe("classifyModel parity with OMP reference", () => {
	for (const row of fixture.classify) {
		it(`classifies ${row.provider}/${row.modelId} identically (strict and lenient)`, () => {
			expect(classifyModel(row.provider, row.modelId)).toEqual(row.strict);
			expect(classifyModel(row.provider, row.modelId, { lenient: true })).toEqual(row.lenient);
		});
	}

	it("strict mode throws AmbiguousIdentityError on the family tie, lenient degrades to bare class", () => {
		const row = fixture.strictThrows[0];
		expect(row.strict.error).toBe("AmbiguousIdentityError");
		expect(() => classifyModel(row.provider, row.modelId)).toThrow(AmbiguousIdentityError);
		expect(classifyModel(row.provider, row.modelId, { lenient: true })).toEqual(row.lenient.out);
	});

	it("routingVariantPlain matches the OMP reference", () => {
		for (const row of fixture.routingVariantPlain) {
			expect(routingVariantPlain(row.provider, row.model) ?? null).toBe(row.out);
		}
	});

	it("billingVariantPlain matches the OMP reference", () => {
		for (const row of fixture.billingVariantPlain) {
			expect(billingVariantPlain(row.model) ?? null).toBe(row.out);
		}
	});

	it("collapseVariantId matches the OMP reference", () => {
		for (const row of fixture.collapseVariantId) {
			expect(collapseVariantId(row.provider, row.model)).toEqual(row.out);
		}
	});
});
