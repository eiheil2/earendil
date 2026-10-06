/**
 * Browse view over the full generated model catalog, as opposed to the
 * credential-filtered list the model selector offers.
 *
 * `/model` shows what the current credentials can actually use (AC-C05). That is the
 * right default, but it makes an entire catalog unreachable: a user cannot answer
 * "does my provider even have a 1M-context model, and what does it cost?" without
 * first logging in to a second provider. This module is the data side of that
 * question — every model pi knows about, filterable along the axes a user
 * actually chooses on: transport API, vendor/provider, capability, and price.
 *
 * Deliberately pure: no TUI, no runtime, no I/O. The component owns rendering and
 * key handling, so the filter semantics stay testable without a terminal.
 */
import { type AnyModel, type Api, isModelType, type Model, type ModelType } from "@earendil-works/pi-ai";

/** One row of the catalog browse view. */
export interface CatalogEntry {
	model: AnyModel;
	provider: string;
	id: string;
	name: string;
	/**
	 * Which catalog section this entry came from. Named `modelType` rather than `type`
	 * because a bare `type` on a chat model means "type or default", and this field is
	 * always resolved.
	 */
	modelType: ModelType;
	api: string;
	/** Cheapest input price per million tokens; 0 for free models. */
	inputCost: number;
	/** Cheapest output price per million tokens; 0 for free models. */
	outputCost: number;
	/** Context window for chat models, undefined for image/classifier entries. */
	contextWindow?: number;
	/**
	 * Reasoning support for chat models, undefined elsewhere. Undefined rather than
	 * `false` because "no reasoning level" and "not a chat model" are different facts,
	 * and a `reasoning:false` filter should not sweep in image models.
	 */
	reasoning?: boolean;
	images: boolean;
}

export interface CatalogFacetCounts {
	providers: number;
	apis: number;
	types: number;
	reasoning: number;
	images: number;
	free: number;
	/** Cheapest input price per million tokens across the matching set. */
	minInputCost: number;
	/** Most expensive input price per million tokens across the matching set. */
	maxInputCost: number;
}

/**
 * Filter facets a query can constrain. Every supplied facet must hold; omitted
 * facets do not constrain. Free text (see {@link parseCatalogQuery}) is separate
 * because it is a fuzzy match rather than an axis match.
 */
export interface CatalogFilter {
	provider?: string;
	api?: string;
	type?: ModelType;
	/** Require a model that accepts image input. */
	images?: boolean;
	/** Require a chat model whose reasoning/thinking level is exactly this. Excludes non-chat rows. */
	reasoning?: boolean;
	/** Require a model whose input price is at most this (USD per million tokens). */
	maxInputCost?: number;
	/** Require a chat model whose context window is at least this. */
	minContextWindow?: number;
}

/** A parsed catalog query: `key:value` facets plus the remaining free text. */
export interface CatalogQuery {
	filter: CatalogFilter;
	/** Space-separated words the fuzzy match runs against; empty when the query was pure facets. */
	text: string;
	/** Facet keys the query used that this module does not implement, for surfacing typos. */
	unknownKeys: string[];
}

/** Chat models cheaper than this are treated as free for the `free:` facet. */
const FREE_COST_CEILING = 0;

/**
 * Build browse rows from a flat model list. Every model type is kept: a user
 * asking "does my provider have an image model" deserves the same answer as one
 * asking about chat models, and collapsing to chat would hide it.
 */
export function buildCatalogEntries(models: readonly AnyModel[]): CatalogEntry[] {
	return models.map((model) => ({
		model,
		provider: model.provider,
		id: model.id,
		name: model.name,
		modelType: modelTypeOf(model),
		api: model.api,
		inputCost: model.cost.input,
		outputCost: model.cost.output,
		contextWindow: isModelType(model, "chat") ? (model as Model<Api>).contextWindow : undefined,
		reasoning: isModelType(model, "chat") ? (model as Model<Api>).reasoning : undefined,
		images: model.input.includes("image"),
	}));
}

function modelTypeOf(model: AnyModel): ModelType {
	if (isModelType(model, "image")) return "image";
	if (isModelType(model, "classifier")) return "classifier";
	return "chat";
}

/**
 * Parse a browse query. Recognized facets:
 *
 * - `provider:<id>` — exact provider id, case-insensitive
 * - `api:<id>` — exact transport api id, case-insensitive
 * - `type:chat|image|classifier`
 * - `images` / `images:true` / `images:false` — image input support
 * - `reasoning` / `reasoning:true` / `reasoning:false`
 * - `free` — input and output price both 0
 * - `under:<usd>` — input price at most this, USD per million tokens
 * - `ctx:<tokens>` — chat context window at least this (`128k`, `1m`, or plain digits)
 *
 * Anything else is free text for the fuzzy match, so a bare model id still works.
 * Unknown `key:value` pairs are reported rather than silently ignored, so a typo
 * surfaces instead of quietly returning the unfiltered catalog.
 */
export function parseCatalogQuery(query: string): CatalogQuery {
	const filter: CatalogFilter = {};
	const unknownKeys: string[] = [];
	const words: string[] = [];

	for (const token of query.trim().split(/\s+/)) {
		if (token.length === 0) continue;
		const colon = token.indexOf(":");
		if (colon <= 0) {
			// A shorthand consumes the token; anything it did not claim is search text.
			if (!applyShorthand(token, filter)) words.push(token);
			continue;
		}
		const key = token.slice(0, colon).toLowerCase();
		const value = token.slice(colon + 1);
		switch (key) {
			case "provider":
				if (value) filter.provider = value.toLowerCase();
				break;
			case "api":
				if (value) filter.api = value.toLowerCase();
				break;
			case "type":
				if (value === "chat" || value === "image" || value === "classifier") filter.type = value;
				else unknownKeys.push(key);
				break;
			case "images":
				filter.images = parseBoolean(value, true);
				break;
			case "reasoning":
				filter.reasoning = parseBoolean(value, true);
				break;
			case "free":
				if (filter.maxInputCost === undefined) filter.maxInputCost = FREE_COST_CEILING;
				break;
			case "under": {
				const usd = parseNumber(value);
				if (usd === undefined) unknownKeys.push(key);
				else filter.maxInputCost = usd;
				break;
			}
			case "ctx": {
				const tokens = parseTokenCount(value);
				if (tokens === undefined) unknownKeys.push(key);
				else filter.minContextWindow = tokens;
				break;
			}
			default:
				unknownKeys.push(key);
				words.push(token);
				break;
		}
	}

	return { filter, text: words.join(" "), unknownKeys };
}

/**
 * Bare capability words are facets, not search terms: `free` is a price query, and
 * `images`/`reasoning` are the same axes their `key:value` forms set.
 */
function applyShorthand(token: string, filter: CatalogFilter): boolean {
	switch (token.toLowerCase()) {
		case "free":
			filter.maxInputCost = FREE_COST_CEILING;
			return true;
		case "images":
			filter.images = true;
			return true;
		case "reasoning":
			filter.reasoning = true;
			return true;
		default:
			return false;
	}
}

function parseBoolean(value: string, whenEmpty: boolean): boolean {
	if (value === "") return whenEmpty;
	return value !== "false" && value !== "no" && value !== "0";
}

function parseNumber(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Accepts `128k`, `1m`, or a plain token count. */
export function parseTokenCount(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return undefined;
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

export function matchesCatalogFilter(entry: CatalogEntry, filter: CatalogFilter): boolean {
	if (filter.provider !== undefined && entry.provider.toLowerCase() !== filter.provider) return false;
	if (filter.api !== undefined && entry.api.toLowerCase() !== filter.api) return false;
	if (filter.type !== undefined && entry.modelType !== filter.type) return false;
	if (filter.images !== undefined && entry.images !== filter.images) return false;
	// `reasoning` is undefined for non-chat rows, so a reasoning facet excludes them
	// rather than treating "not a chat model" as "no reasoning".
	if (filter.reasoning !== undefined && entry.reasoning !== filter.reasoning) return false;
	if (filter.maxInputCost !== undefined && entry.inputCost > filter.maxInputCost) return false;
	if (filter.minContextWindow !== undefined) {
		// Non-chat entries have no context window, so a context floor excludes them.
		if (entry.contextWindow === undefined || entry.contextWindow < filter.minContextWindow) return false;
	}
	return true;
}

/** Fuzzy-match text used by the component; kept here so ranking matches the selector's. */
export function catalogSearchText(entry: CatalogEntry): string {
	return `${entry.provider} ${entry.provider}/${entry.id} ${entry.provider} ${entry.id} ${entry.name} ${entry.api}`;
}

/** Face counts for the header line, so a filter that empties the list explains itself. */
export function summarizeCatalog(entries: readonly CatalogEntry[]): CatalogFacetCounts {
	const providers = new Set<string>();
	const apis = new Set<string>();
	const types = new Set<ModelType>();
	let reasoning = 0;
	let images = 0;
	let free = 0;
	let minInputCost = Number.POSITIVE_INFINITY;
	let maxInputCost = 0;

	for (const entry of entries) {
		providers.add(entry.provider);
		apis.add(entry.api);
		types.add(entry.modelType);
		if (entry.reasoning) reasoning++;
		if (entry.images) images++;
		if (entry.inputCost === 0 && entry.outputCost === 0) free++;
		if (entry.inputCost < minInputCost) minInputCost = entry.inputCost;
		if (entry.inputCost > maxInputCost) maxInputCost = entry.inputCost;
	}

	return {
		providers: providers.size,
		apis: apis.size,
		types: types.size,
		reasoning,
		images,
		free,
		// An empty set has no meaningful range; 0 keeps the header renderable.
		minInputCost: entries.length === 0 ? 0 : minInputCost,
		maxInputCost,
	};
}
