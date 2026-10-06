import type { AnyModel, ImageApi, ImageModel, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildCatalogEntries,
	type CatalogEntry,
	catalogSearchText,
	matchesCatalogFilter,
	parseCatalogQuery,
	parseTokenCount,
	summarizeCatalog,
} from "../src/modes/interactive/model-catalog-view.ts";

// These entries stand in for the generated catalog. They defend the filter semantics a
// user relies on to answer "can my provider do X, and at what price", so each one
// differs on exactly the axis under test.

function chat(provider: string, id: string, overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id,
		name: `${id} name`,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
		...overrides,
	};
}

function image(provider: string, id: string): ImageModel<ImageApi> {
	return {
		id,
		name: `${id} image`,
		api: "openai-images",
		type: "image",
		provider,
		baseUrl: "https://example.invalid",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const MODELS: AnyModel[] = [
	chat("openai", "gpt-5.4", {
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.1, cacheWrite: 0 },
	}),
	chat("openai", "gpt-5.4-mini", {
		input: ["text"],
		contextWindow: 400_000,
		cost: { input: 0.25, output: 2, cacheRead: 0.02, cacheWrite: 0 },
	}),
	chat("groq", "openai/gpt-oss-120b", {
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}),
	chat("anthropic", "claude-sonnet-4-5", {
		api: "anthropic-messages",
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
	}),
	image("openai", "gpt-image-1"),
];

const entries = buildCatalogEntries(MODELS);
const byId = (id: string): CatalogEntry => {
	const entry = entries.find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`no entry ${id}`);
	return entry;
};

describe("buildCatalogEntries", () => {
	it("keeps non-chat models so an image-model lookup is answerable", () => {
		expect(entries).toHaveLength(5);
		expect(byId("gpt-image-1").modelType).toBe("image");
		// A context floor must exclude non-chat rows, so their window is undefined.
		expect(byId("gpt-image-1").contextWindow).toBeUndefined();
	});

	it("reads the axes the filters constrain", () => {
		expect(byId("gpt-5.4").inputCost).toBe(1.25);
		expect(byId("gpt-5.4").images).toBe(true);
		expect(byId("gpt-5.4").reasoning).toBe(true);
		expect(byId("openai/gpt-oss-120b").reasoning).toBe(false);
		expect(byId("gpt-5.4-mini").contextWindow).toBe(400_000);
		// Non-chat rows carry no reasoning or context fact at all.
		expect(byId("gpt-image-1").reasoning).toBeUndefined();
	});
});

describe("parseCatalogQuery", () => {
	it("parses each supported facet", () => {
		expect(parseCatalogQuery("provider:groq").filter).toEqual({ provider: "groq" });
		expect(parseCatalogQuery("api:anthropic-messages").filter).toEqual({ api: "anthropic-messages" });
		expect(parseCatalogQuery("type:image").filter).toEqual({ type: "image" });
		expect(parseCatalogQuery("images").filter).toEqual({ images: true });
		expect(parseCatalogQuery("reasoning:false").filter).toEqual({ reasoning: false });
		expect(parseCatalogQuery("free").filter).toEqual({ maxInputCost: 0 });
		expect(parseCatalogQuery("under:1.5").filter).toEqual({ maxInputCost: 1.5 });
		expect(parseCatalogQuery("ctx:1m").filter).toEqual({ minContextWindow: 1_000_000 });
	});

	it("combines facets and keeps the remaining text for fuzzy matching", () => {
		const parsed = parseCatalogQuery("provider:openai images ctx:1m gpt-5");
		expect(parsed.filter).toEqual({ provider: "openai", images: true, minContextWindow: 1_000_000 });
		expect(parsed.text).toBe("gpt-5");
	});

	it("does not treat free as a search term", () => {
		expect(parseCatalogQuery("free").text).toBe("");
	});

	it("reports an unknown facet key instead of silently returning everything", () => {
		const parsed = parseCatalogQuery("providr:openai");
		expect(parsed.unknownKeys).toEqual(["providr"]);
		// The token stays searchable, so a typo degrades to a fuzzy search.
		expect(parsed.text).toBe("providr:openai");
	});

	it("rejects an unusable value rather than filtering on nonsense", () => {
		expect(parseCatalogQuery("type:video").unknownKeys).toEqual(["type"]);
		expect(parseCatalogQuery("under:abc").unknownKeys).toEqual(["under"]);
		expect(parseCatalogQuery("ctx:big").unknownKeys).toEqual(["ctx"]);
	});
});

describe("parseTokenCount", () => {
	it("accepts k/m suffixes and plain counts", () => {
		expect(parseTokenCount("128k")).toBe(128_000);
		expect(parseTokenCount("1m")).toBe(1_000_000);
		expect(parseTokenCount("200000")).toBe(200_000);
		expect(parseTokenCount("1.5m")).toBe(1_500_000);
		expect(parseTokenCount("nope")).toBeUndefined();
	});
});

describe("matchesCatalogFilter", () => {
	it("constrains on provider, api, and type", () => {
		expect(entries.filter((e) => matchesCatalogFilter(e, { provider: "groq" }))).toHaveLength(1);
		expect(entries.filter((e) => matchesCatalogFilter(e, { api: "anthropic-messages" }))).toHaveLength(1);
		expect(entries.filter((e) => matchesCatalogFilter(e, { type: "image" }))).toHaveLength(1);
	});

	it("narrows by image and reasoning support, including negatively", () => {
		expect(entries.filter((e) => matchesCatalogFilter(e, { images: true })).map((e) => e.id)).toEqual([
			"gpt-5.4",
			"claude-sonnet-4-5",
		]);
		// An image model has no reasoning fact at all, so it must not satisfy
		// `reasoning:false`; only a chat model that opted out does.
		expect(entries.filter((e) => matchesCatalogFilter(e, { reasoning: false })).map((e) => e.id)).toEqual([
			"openai/gpt-oss-120b",
		]);
		expect(entries.filter((e) => matchesCatalogFilter(e, { reasoning: true })).map((e) => e.id)).toEqual([
			"gpt-5.4",
			"gpt-5.4-mini",
			"claude-sonnet-4-5",
		]);
	});

	it("treats a price ceiling as inclusive", () => {
		// 1.25 sits exactly on the ceiling and must survive; 3 must not. gpt-5.4-mini (0.25)
		// and the free rows are under it too, so the ceiling is what excludes claude only.
		expect(entries.filter((e) => matchesCatalogFilter(e, { maxInputCost: 1.25 })).map((e) => e.id)).toEqual([
			"gpt-5.4",
			"gpt-5.4-mini",
			"openai/gpt-oss-120b",
			"gpt-image-1",
		]);
	});

	it("excludes non-chat rows from a context floor rather than passing them", () => {
		const matched = entries.filter((e) => matchesCatalogFilter(e, { minContextWindow: 400_000 }));
		expect(matched.map((e) => e.id)).toEqual(["gpt-5.4-mini"]);
	});

	it("intersects supplied facets", () => {
		const matched = entries.filter((e) => matchesCatalogFilter(e, { provider: "openai", images: true }));
		expect(matched.map((e) => e.id)).toEqual(["gpt-5.4"]);
	});
});

describe("summarizeCatalog", () => {
	it("reports the range a filter produced", () => {
		const summary = summarizeCatalog(
			entries.filter((e) => matchesCatalogFilter(e, { provider: "openai", type: "chat" })),
		);
		expect(summary.providers).toBe(1);
		expect(summary.apis).toBe(1);
		expect(summary.types).toBe(1);
		expect(summary.minInputCost).toBe(0.25);
		expect(summary.maxInputCost).toBe(1.25);
		expect(summary.images).toBe(1);
		expect(summary.free).toBe(0);
	});

	it("reports zeros for an empty result set instead of an empty price range", () => {
		const summary = summarizeCatalog([]);
		expect(summary).toMatchObject({ providers: 0, apis: 0, types: 0, minInputCost: 0, maxInputCost: 0 });
	});
});

describe("catalogSearchText", () => {
	it("puts provider, provider-qualified id, and api ahead of the bare id", () => {
		const text = catalogSearchText(byId("gpt-5.4"));
		expect(text.startsWith("openai openai/gpt-5.4")).toBe(true);
		expect(text).toContain("openai-responses");
	});

	it("keeps the display name searchable", () => {
		expect(catalogSearchText(byId("gpt-5.4"))).toContain("gpt-5.4 name");
	});
});
