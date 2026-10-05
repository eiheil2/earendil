/**
 * Runtime model-identity taxonomy: classifies wire model ids into
 * `(class, family, revision)` ranks, applies reviewed identity overrides, and
 * exposes the collapse/discovery vocabularies.
 *
 * Faithful port of the OMP reference (`packages/catalog/src/compat/taxonomy.ts`):
 * matchers rank `exact(4) > bounded(3) > namespace(2) > prefix(1) > glob(0)`
 * with token byte length as tiebreak; equal cross-class or cross-family ranks
 * throw unless classification is `lenient` (discovery normalization).
 *
 * The fact base is the compiled `rules.json` copied from OMP. The KDL rule
 * engine that produces it is intentionally NOT ported.
 */
import type { ThinkingLevel } from "../types.ts";
import rulesJson from "./rules.json" with { type: "json" };

type Effort = ThinkingLevel;

/** Class-membership matcher kinds, most to least specific. */
export type MatcherKind = "exact" | "bounded" | "namespace" | "prefix" | "glob";

/** One compiled class-membership matcher (token pre-lowercased). */
export interface CompiledMatcher {
	kind: MatcherKind;
	token: string;
	/** Namespace matchers only: accept dot/colon segments with token boundaries. */
	bounded?: boolean;
}

/** One compiled product-family rule (glob pre-lowercased). */
export interface CompiledFamily {
	id: string;
	glob: string;
	priority: number;
}

/** One compiled revision-extraction prefix (pre-lowercased). */
export interface CompiledRevisionPrefix {
	prefix: string;
	anywhere?: boolean;
}

interface CompiledIdentityOverrideFields {
	id: string;
	provider?: string;
	logical?: string;
	class?: string;
	family?: string;
	/** Canonical `major.minor.patch`. */
	revision?: string;
	effort?: Effort | "off";
	thinkingVariant?: boolean;
	rationale: string;
	provenance: string;
	expiresAtMs?: number;
}

/** One compiled reviewed identity correction with exactly one bare-model selector. */
export type CompiledIdentityOverride = CompiledIdentityOverrideFields &
	(
		| {
				/** Exact bare-model selector. */
				model: string;
				glob?: never;
		  }
		| {
				model?: never;
				/** Anchored, case-insensitive bare-model glob. */
				glob: string;
		  }
	);

/** One compiled model class: matchers, families, revision rules, overrides. */
export interface CompiledClass {
	id: string;
	matchers: CompiledMatcher[];
	families: CompiledFamily[];
	revisionPrefixes: CompiledRevisionPrefix[];
	skipBare: string[];
	overrides: CompiledIdentityOverride[];
}

/** One collapse suffix rule (thinking or effort variant). */
export interface CompiledCollapseSuffix {
	suffix: string;
	effort?: Effort | "off";
	thinking?: boolean;
	exceptBarePrefix?: string;
}

/** One provider-scoped effort-lane suffix rule. */
export interface CompiledEffortLane {
	suffix: string;
	providers: string[];
	barePrefix?: string;
}

/** One provider-scoped routing-variant suffix rule. */
export interface CompiledRoutingVariant {
	suffix: string;
	providers: string[];
}

/** One reviewed provider-scoped effort-sibling family seed. */
export interface CompiledEffortFamily {
	provider: string;
	logical: string;
	aliases: string[];
}

/** The compiled taxonomy slice consumed by this module. */
export interface CompiledTaxonomy {
	classes: CompiledClass[];
	collapse: {
		suffixes: CompiledCollapseSuffix[];
		pairTokens: string[];
		lanes: CompiledEffortLane[];
		routingVariants: CompiledRoutingVariant[];
		effortFamilies: CompiledEffortFamily[];
	};
	discovery: {
		canonicalRecovery: string[];
		responsesHintGroups: string[][];
		responsesRouteModels: Record<string, string[]>;
		billingVariantSuffixes: string[];
	};
}

interface CompiledCompatRules {
	taxonomy: CompiledTaxonomy;
}

/** Structured identity of one classified model. */
export interface ModelIdentity {
	/** Vendor lineage id, `"unknown"` when unclassified. */
	class: string;
	/** Product family within the class, when classified. */
	family?: string;
	/** Canonical `major.minor.patch`, when extracted. */
	revision?: string;
	/** Effort tier collapsed out of the id, when the id was an effort variant. */
	effort?: Effort | "off";
	/** Whether the id carried a thinking-variant suffix. */
	thinkingVariant?: boolean;
	/** Canonical logical id when it differs from the wire id. */
	logicalId?: string;
}

const rules: CompiledCompatRules = rulesJson as CompiledCompatRules;

/** Two classes, families, or reviewed override patterns tie for one model id. */
export class AmbiguousIdentityError extends Error {
	readonly model: string;
	readonly first: string;
	readonly second: string;
	readonly kind: "class" | "family" | "override";

	constructor(model: string, first: string, second: string, kind: "class" | "family" | "override") {
		super(`ambiguous ${kind} for \`${model}\`: \`${first}\` and \`${second}\` tie`);
		this.name = "AmbiguousIdentityError";
		this.model = model;
		this.first = first;
		this.second = second;
		this.kind = kind;
	}
}

/** Options for {@link classifyModel}. */
export interface ClassifyOptions {
	/** Observation time for override expiry; absent keeps expiring overrides active. */
	observedAtMs?: number;
	/**
	 * Swallow ambiguity instead of throwing: an ambiguous class resolves to
	 * `unknown`, an ambiguous family to no family. Discovery normalization
	 * uses this; catalog compilation stays strict.
	 */
	lenient?: boolean;
}

const MATCHER_RANK: Record<CompiledMatcher["kind"], number> = {
	exact: 4,
	bounded: 3,
	namespace: 2,
	prefix: 1,
	glob: 0,
};

function bareOf(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

function boundedMatch(value: string, token: string): boolean {
	if (value === token) return true;
	if (!value.startsWith(token)) return false;
	const next = value.charCodeAt(token.length);
	return next === 45 || next === 95 || next === 46 || next === 58 || (next >= 48 && next <= 57); // - _ . : 0-9
}

/** A parsed `major.minor.patch` revision. */
export type Revision = readonly [number, number, number];

function parseComponent(value: string): number | undefined {
	if (!value) return undefined;
	let out = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return undefined;
		out = out * 10 + (code - 48);
		if (out > 255) return undefined;
	}
	return out;
}

/**
 * Extracts a leading revision from an identifier tail that begins with a
 * digit: up to three components separated by `.` or by `-` followed by a
 * digit (`"4-6-turbo"` → `[4, 6, 0]`). A component whose digits run directly
 * into a letter is a parameter-count or size token (`qwen3-32b`,
 * `llama-3.3-70b`), never a revision component.
 */
export function parseRevisionPrefix(value: string): Revision | undefined {
	const out: [number, number, number] = [0, 0, 0];
	let count = 0;
	let index = 0;
	while (count < 3) {
		const start = index;
		while (index < value.length && value.charCodeAt(index) >= 48 && value.charCodeAt(index) <= 57) {
			index++;
		}
		const trailing = index < value.length ? value.charCodeAt(index) : 0;
		const isSizeToken = (trailing >= 97 && trailing <= 122) || (trailing >= 65 && trailing <= 90);
		const component = isSizeToken ? undefined : parseComponent(value.slice(start, index));
		if (component === undefined) {
			return count > 0 ? out : undefined;
		}
		out[count] = component;
		count++;
		const separator = value[index];
		if (separator === undefined) break;
		const next = value.charCodeAt(index + 1);
		if ((separator !== "." && separator !== "-") || !(next >= 48 && next <= 57)) break;
		index++;
	}
	return out;
}

/** Renders a revision as its canonical `major.minor.patch` string. */
export function formatRevision(revision: Revision): string {
	return `${revision[0]}.${revision[1]}.${revision[2]}`;
}

/**
 * Anchored `*`-wildcard match; both sides must be pre-lowercased. `*` spans
 * any substring; non-wildcard text stays anchored in order.
 */
const globSegmentsCache = new Map<string, readonly string[]>();
const GLOB_SEGMENTS_MAX = 4096;

function globSegments(pattern: string): readonly string[] {
	const cached = globSegmentsCache.get(pattern);
	if (cached !== undefined) return cached;
	const segments = pattern.split("*");
	if (globSegmentsCache.size >= GLOB_SEGMENTS_MAX) globSegmentsCache.clear();
	globSegmentsCache.set(pattern, segments);
	return segments;
}

export function globMatch(pattern: string, value: string): boolean {
	const segments = globSegments(pattern);
	if (segments.length === 1) return value === pattern;
	const head = segments[0] ?? "";
	if (!value.startsWith(head)) return false;
	let remainder = value.slice(head.length);
	for (let i = 1; i < segments.length - 1; i++) {
		const segment = segments[i] ?? "";
		if (!segment) continue;
		const found = remainder.indexOf(segment);
		if (found === -1) return false;
		remainder = remainder.slice(found + segment.length);
	}
	const last = segments[segments.length - 1] ?? "";
	return last === "" || remainder.endsWith(last);
}

function matcherMatches(matcher: CompiledMatcher, lower: string, bare: string): boolean {
	switch (matcher.kind) {
		case "exact":
			return bare === matcher.token;
		case "bounded":
			return boundedMatch(bare, matcher.token);
		case "namespace": {
			const parts = matcher.bounded ? lower.split(/[/.:]/) : lower.split("/");
			for (const part of parts) {
				if (!part) continue;
				if (matcher.bounded ? boundedMatch(part, matcher.token) : part === matcher.token) return true;
			}
			return false;
		}
		case "prefix":
			return bare.startsWith(matcher.token);
		case "glob":
			return globMatch(matcher.token, bare);
	}
}

function nonWildcardBytes(glob: string): number {
	let count = 0;
	for (let i = 0; i < glob.length; i++) {
		if (glob[i] !== "*") count++;
	}
	return count;
}

interface FamilyRanking {
	winner?: { rank: readonly [number, number]; id: string };
	tied?: readonly [string, string];
}

function rankFamilies(cls: CompiledClass, subject: string): FamilyRanking {
	let winner: { rank: readonly [number, number]; id: string } | undefined;
	let tied: readonly [string, string] | undefined;
	for (const family of cls.families) {
		if (!globMatch(family.glob, subject)) continue;
		const rank = [family.priority, nonWildcardBytes(family.glob)] as const;
		if (winner && winner.rank[0] === rank[0] && winner.rank[1] === rank[1] && winner.id !== family.id) {
			tied = [winner.id, family.id];
		} else if (!winner || winner.rank[0] < rank[0] || (winner.rank[0] === rank[0] && winner.rank[1] < rank[1])) {
			winner = { rank, id: family.id };
			tied = undefined;
		}
	}
	return { winner, tied };
}

function stripClassNamespace(cls: CompiledClass, bare: string): string | undefined {
	const separator = bare.search(/[.:]/);
	if (separator <= 0 || separator === bare.length - 1) return undefined;
	const namespace = bare.slice(0, separator);
	if (!cls.matchers.some((matcher) => matcher.token === namespace)) return undefined;
	return bare.slice(separator + 1);
}

function classifyFamily(cls: CompiledClass, bare: string, model: string, lenient: boolean): string | undefined {
	const initial = rankFamilies(cls, bare);
	const tied = initial.tied;
	if (!tied) return initial.winner?.id;

	// A Bedrock-style `vendor.model` id names the product after the class
	// namespace. Rescore only ambiguities so existing classifications stay put.
	const scoped = stripClassNamespace(cls, bare);
	if (scoped !== undefined) {
		const rescored = rankFamilies(cls, scoped);
		if (rescored.winner && !rescored.tied) return rescored.winner.id;
	}
	if (lenient) return undefined;
	throw new AmbiguousIdentityError(model, tied[0], tied[1], "family");
}

function extractRevision(cls: CompiledClass, bare: string): string | undefined {
	if (cls.skipBare.includes(bare)) return undefined;
	for (const rule of cls.revisionPrefixes) {
		let tail: string | undefined;
		if (rule.anywhere) {
			const start = bare.indexOf(rule.prefix);
			if (start !== -1) tail = bare.slice(start + rule.prefix.length);
		} else if (bare.startsWith(rule.prefix)) {
			tail = bare.slice(rule.prefix.length);
		}
		if (tail === undefined) continue;
		const digit = tail.search(/[0-9]/);
		if (digit === -1) return undefined;
		const revision = parseRevisionPrefix(tail.slice(digit));
		return revision ? formatRevision(revision) : undefined;
	}
	return undefined;
}

interface ClassRanks {
	class: string;
	family?: string;
	revision?: string;
}

function classifyRanks(model: string, lenient: boolean): ClassRanks {
	const lower = model.trim().toLowerCase();
	const bare = bareOf(lower);
	let winner: { rank: readonly [number, number]; cls: CompiledClass } | undefined;
	let tied: readonly [string, string] | undefined;
	for (const cls of rules.taxonomy.classes) {
		for (const matcher of cls.matchers) {
			if (!matcherMatches(matcher, lower, bare)) continue;
			const rank = [MATCHER_RANK[matcher.kind], matcher.token.length] as const;
			if (winner && winner.rank[0] === rank[0] && winner.rank[1] === rank[1] && winner.cls.id !== cls.id) {
				tied = [winner.cls.id, cls.id];
			} else if (!winner || winner.rank[0] < rank[0] || (winner.rank[0] === rank[0] && winner.rank[1] < rank[1])) {
				winner = { rank, cls };
				tied = undefined;
			}
		}
	}
	if (tied) {
		if (lenient) return { class: "unknown" };
		throw new AmbiguousIdentityError(lower, tied[0], tied[1], "class");
	}
	if (!winner) return { class: "unknown" };
	const ranks: ClassRanks = { class: winner.cls.id };
	const family = classifyFamily(winner.cls, bare, lower, lenient);
	if (family !== undefined) ranks.family = family;
	const revision = extractRevision(winner.cls, bare);
	if (revision !== undefined) ranks.revision = revision;
	return ranks;
}

function ranksInClass(classId: string, model: string, lenient: boolean): Omit<ClassRanks, "class"> {
	const cls = rules.taxonomy.classes.find((candidate) => candidate.id === classId);
	if (!cls) return {};
	const lower = model.trim().toLowerCase();
	const bare = bareOf(lower);
	const out: Omit<ClassRanks, "class"> = {};
	const family = classifyFamily(cls, bare, lower, lenient);
	if (family !== undefined) out.family = family;
	const revision = extractRevision(cls, bare);
	if (revision !== undefined) out.revision = revision;
	return out;
}

// Exact overrides retain a direct lowercase index. Pattern overrides are few
// and remain in one static list, ranked only after exact lookup misses.
interface OverrideBucket {
	byProvider: Map<string, CompiledIdentityOverride>;
	agnostic: CompiledIdentityOverride | undefined;
}

interface IndexedPatternOverride {
	override: CompiledIdentityOverride;
	glob: string;
	provider?: string;
	specificity: number;
}

interface OverrideIndexes {
	exact: Map<string, OverrideBucket>;
	patterns: IndexedPatternOverride[];
}

let overrideIndexes: OverrideIndexes | undefined;

function getOverrideIndexes(): OverrideIndexes {
	if (overrideIndexes !== undefined) return overrideIndexes;
	const exact = new Map<string, OverrideBucket>();
	const patterns: IndexedPatternOverride[] = [];
	const classes: readonly CompiledClass[] = rules.taxonomy.classes;
	for (const cls of classes) {
		for (const override of cls.overrides) {
			if (override.model === undefined) {
				if (override.glob !== undefined) {
					patterns.push({
						override,
						glob: override.glob,
						provider: override.provider?.toLowerCase(),
						specificity: nonWildcardBytes(override.glob),
					});
				}
				continue;
			}
			const key = override.model.toLowerCase();
			let bucket = exact.get(key);
			if (bucket === undefined) {
				bucket = { byProvider: new Map(), agnostic: undefined };
				exact.set(key, bucket);
			}
			if (override.provider !== undefined) {
				const providerKey = override.provider.toLowerCase();
				if (!bucket.byProvider.has(providerKey)) bucket.byProvider.set(providerKey, override);
			} else {
				bucket.agnostic ??= override;
			}
		}
	}
	overrideIndexes = { exact, patterns };
	return overrideIndexes;
}

function overrideIsActive(override: CompiledIdentityOverride, observedAtMs: number | undefined): boolean {
	return override.expiresAtMs === undefined || observedAtMs === undefined || observedAtMs < override.expiresAtMs;
}

interface PatternOverrideRanking {
	winner?: { specificity: number; override: CompiledIdentityOverride };
	tied?: readonly [CompiledIdentityOverride, CompiledIdentityOverride];
}

function rankPatternOverrides(
	patterns: readonly IndexedPatternOverride[],
	provider: string | undefined,
	bareModel: string,
	observedAtMs: number | undefined,
): PatternOverrideRanking {
	let winner: { specificity: number; override: CompiledIdentityOverride } | undefined;
	let tied: readonly [CompiledIdentityOverride, CompiledIdentityOverride] | undefined;
	for (const pattern of patterns) {
		const { override, specificity } = pattern;
		if (pattern.provider !== provider || !overrideIsActive(override, observedAtMs)) continue;
		if (!globMatch(pattern.glob, bareModel)) continue;
		if (winner?.specificity === specificity) {
			tied = [winner.override, override];
		} else if (winner === undefined || winner.specificity < specificity) {
			winner = { specificity, override };
			tied = undefined;
		}
	}
	return { winner, tied };
}

function findIdentityOverride(
	provider: string,
	bareModel: string,
	observedAtMs: number | undefined,
	lenient: boolean,
): CompiledIdentityOverride | undefined {
	const lowerProvider = provider.toLowerCase();
	const lowerBareModel = bareModel.toLowerCase();
	const indexes = getOverrideIndexes();
	const bucket = indexes.exact.get(lowerBareModel);
	if (bucket !== undefined) {
		const scoped = bucket.byProvider.get(lowerProvider);
		if (scoped !== undefined && overrideIsActive(scoped, observedAtMs)) return scoped;
		const agnostic = bucket.agnostic;
		if (agnostic !== undefined && overrideIsActive(agnostic, observedAtMs)) return agnostic;
	}

	const scoped = rankPatternOverrides(indexes.patterns, lowerProvider, lowerBareModel, observedAtMs);
	const ranked =
		scoped.winner === undefined && scoped.tied === undefined
			? rankPatternOverrides(indexes.patterns, undefined, lowerBareModel, observedAtMs)
			: scoped;
	if (ranked.tied !== undefined) {
		if (lenient) return undefined;
		throw new AmbiguousIdentityError(lowerBareModel, ranked.tied[0].id, ranked.tied[1].id, "override");
	}
	return ranked.winner?.override;
}

/** Result of collapsing a wire id through the suffix vocabulary. */
export interface CollapsedVariant {
	/** Logical id after suffix collapse (original bytes preserved where possible). */
	logicalId: string;
	/** Effort tier collapsed out of the id, when it was an effort variant. */
	effort?: Effort | "off";
	/** Whether the id carried a thinking-variant suffix. */
	thinkingVariant: boolean;
}

/**
 * Collapses a declared thinking or effort suffix from a model identifier.
 * Exact `effort-family` aliases collapse to the family's logical model
 * without assigning an effort; provider-scoped effort lanes additionally
 * collapse an effort suffix wedged before the lane token.
 */
export function collapseVariantId(provider: string, model: string): CollapsedVariant {
	const { collapse } = rules.taxonomy;
	const lower = model.toLowerCase();
	for (const family of collapse.effortFamilies) {
		if (family.provider === provider.toLowerCase() && family.aliases.includes(lower)) {
			return { logicalId: family.logical, thinkingVariant: false };
		}
	}
	const bare = bareOf(lower);
	let winner: (typeof collapse.suffixes)[number] | undefined;
	for (const rule of collapse.suffixes) {
		if (!lower.endsWith(rule.suffix)) continue;
		if (rule.exceptBarePrefix !== undefined && bare.startsWith(rule.exceptBarePrefix)) continue;
		if (!winner || rule.suffix.length > winner.suffix.length) winner = rule;
	}
	if (winner) {
		const collapsed: CollapsedVariant = {
			logicalId: model.slice(0, model.length - winner.suffix.length),
			thinkingVariant: winner.thinking === true,
		};
		if (winner.effort !== undefined) collapsed.effort = winner.effort;
		return collapsed;
	}
	for (const lane of collapse.lanes) {
		if (!lane.providers.some((candidate) => candidate === provider.toLowerCase()) || !lower.endsWith(lane.suffix)) {
			continue;
		}
		const trimmed = lower.slice(0, lower.length - lane.suffix.length);
		const trimmedBare = bareOf(trimmed);
		if (lane.barePrefix !== undefined && !trimmedBare.startsWith(lane.barePrefix)) continue;
		// The lane wraps effort tiers only; thinking variants never lane.
		let effortRule: (typeof collapse.suffixes)[number] | undefined;
		for (const rule of collapse.suffixes) {
			if (rule.effort === undefined || !trimmed.endsWith(rule.suffix)) continue;
			if (rule.exceptBarePrefix !== undefined && trimmedBare.startsWith(rule.exceptBarePrefix)) continue;
			if (!effortRule || rule.suffix.length > effortRule.suffix.length) effortRule = rule;
		}
		if (!effortRule) continue;
		const base = model.slice(0, trimmed.length - effortRule.suffix.length);
		if (!base || base.endsWith("/")) continue;
		// Preserve the caller's original lane bytes on the logical id.
		return {
			logicalId: `${base}${model.slice(trimmed.length)}`,
			effort: effortRule.effort,
			thinkingVariant: false,
		};
	}
	return { logicalId: model, thinkingVariant: false };
}

/**
 * Removes the first declared thinking-variant suffix token from a model id.
 *
 * Unlike {@link collapseVariantId}, this vocabulary-only helper also handles an
 * infix token used to pair live discovery siblings. Negated forms such as
 * `non-thinking` and `no-thinking` are not variants.
 */
export function stripThinkingVariantSuffix(model: string): string | undefined {
	const lower = model.toLowerCase();
	for (const token of rules.taxonomy.collapse.pairTokens) {
		const needle = `-${token}`;
		let searchFrom = 0;
		while (searchFrom < lower.length) {
			const index = lower.indexOf(needle, searchFrom);
			if (index === -1) break;
			const end = index + needle.length;
			const next = lower.charCodeAt(end);
			const followedByTokenCharacter = (next >= 48 && next <= 57) || (next >= 97 && next <= 122);
			let wordStart = index;
			while (wordStart > 0) {
				const code = lower.charCodeAt(wordStart - 1);
				if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 122))) break;
				wordStart--;
			}
			const preceding = lower.slice(wordStart, index);
			if (!followedByTokenCharacter && preceding !== "non" && preceding !== "no") {
				const stripped = model.slice(0, index) + model.slice(end);
				return stripped.length > 0 ? stripped : undefined;
			}
			searchFrom = index + 1;
		}
	}
	return undefined;
}

/**
 * Classifies a model into its structured identity: reviewed override first,
 * then suffix collapse, then class/family/revision ranks over the logical id.
 *
 * Results are memoized per (provider, model, lenient) — the rule tree is
 * static per process. Cached identities are frozen and each caller receives
 * a shallow copy, so a consumer that mutates its copy cannot poison the
 * cache or any other model classified under the same key. Calls with an
 * explicit observedAtMs skip the memo so override expiry stays exact.
 *
 * @throws AmbiguousIdentityError on equal-rank cross-class, cross-family, or
 * reviewed-pattern matches unless `opts.lenient`.
 */
const classifyMemo = new Map<string, ModelIdentity>();
const CLASSIFY_MEMO_MAX = 4096;

function classifyMemoKey(provider: string, modelId: string, lenient: boolean): string {
	return `${provider.length}:${provider}${modelId.length}:${modelId}${lenient ? 1 : 0}`;
}

export function classifyModel(provider: string, modelId: string, opts?: ClassifyOptions): ModelIdentity {
	if (opts?.observedAtMs === undefined) {
		const key = classifyMemoKey(provider, modelId, opts?.lenient === true);
		const cached = classifyMemo.get(key);
		if (cached !== undefined) return { ...cached };
		const identity = classifyModelUncached(provider, modelId, opts);
		if (classifyMemo.size >= CLASSIFY_MEMO_MAX) classifyMemo.clear();
		classifyMemo.set(key, Object.freeze(identity));
		return { ...identity };
	}
	return classifyModelUncached(provider, modelId, opts);
}

function classifyModelUncached(provider: string, modelId: string, opts?: ClassifyOptions): ModelIdentity {
	const lenient = opts?.lenient === true;
	const trimmed = modelId.trim();
	const bare = bareOf(trimmed);
	const override = findIdentityOverride(provider, bare, opts?.observedAtMs, lenient);
	if (override) {
		const logical = override.logical ?? trimmed;
		const cls = override.class ?? classifyRanks(logical, lenient).class;
		const inferred = ranksInClass(cls, logical, lenient);
		const identity: ModelIdentity = { class: cls };
		const family = override.family ?? inferred.family;
		if (family !== undefined) identity.family = family;
		const revision = override.revision ?? inferred.revision;
		if (revision !== undefined) identity.revision = revision;
		if (override.effort !== undefined) identity.effort = override.effort;
		if (override.thinkingVariant) identity.thinkingVariant = true;
		if (logical !== trimmed) identity.logicalId = logical;
		return identity;
	}
	const collapsed =
		trimmed.length === modelId.length
			? collapseVariantId(provider, trimmed)
			: ({ logicalId: trimmed, thinkingVariant: false } satisfies CollapsedVariant);
	const ranks = classifyRanks(collapsed.logicalId, lenient);
	const identity: ModelIdentity = { class: ranks.class };
	if (ranks.family !== undefined) identity.family = ranks.family;
	if (ranks.revision !== undefined) identity.revision = ranks.revision;
	if (collapsed.effort !== undefined) identity.effort = collapsed.effort;
	if (collapsed.thinkingVariant) identity.thinkingVariant = true;
	if (collapsed.logicalId !== trimmed) identity.logicalId = collapsed.logicalId;
	return identity;
}

/**
 * Strips a declared billing-variant suffix (`-free`, `-contributor`) from a
 * wire identifier, returning the base id it shares a transport with.
 */
export function billingVariantPlain(wireModel: string): string | undefined {
	for (const suffix of rules.taxonomy.discovery.billingVariantSuffixes) {
		const split = wireModel.length - suffix.length;
		if (split <= 0) continue;
		if (wireModel.slice(split).toLowerCase() === suffix) return wireModel.slice(0, split);
	}
	return undefined;
}

/**
 * Returns the plain wire identifier when `wireModel` is a declared
 * provider-scoped routing variant (`gpt-5.6-luna-wm` → `gpt-5.6-luna`).
 */
export function routingVariantPlain(provider: string, wireModel: string): string | undefined {
	const lowerProvider = provider.toLowerCase();
	for (const rule of rules.taxonomy.collapse.routingVariants) {
		if (!rule.providers.includes(lowerProvider)) continue;
		const split = wireModel.length - rule.suffix.length;
		if (split <= 0) continue;
		if (wireModel.slice(split).toLowerCase() === rule.suffix) return wireModel.slice(0, split);
	}
	return undefined;
}

/** Whether any routing-variant suffix is declared for `provider`. */
export function hasRoutingVariants(provider: string): boolean {
	const lower = provider.toLowerCase();
	return rules.taxonomy.collapse.routingVariants.some((rule) => rule.providers.includes(lower));
}

/** Whether `provider`'s discovery recovers canonical intrinsic parameters. */
export function recoversCanonicalParams(provider: string): boolean {
	const lower = provider.toLowerCase();
	return rules.taxonomy.discovery.canonicalRecovery.includes(lower);
}

/** The full responses-route hint group containing `provider`, when declared. */
export function responsesHintGroup(provider: string): readonly string[] | undefined {
	const lower = provider.toLowerCase();
	return rules.taxonomy.discovery.responsesHintGroups.find((group) => group.includes(lower));
}

/** Exact model ids authored onto a provider's responses route. */
export function responsesRouteModels(provider: string): readonly string[] | undefined {
	return rules.taxonomy.discovery.responsesRouteModels[provider.toLowerCase()];
}

/** Whether `provider` declares dynamic effort-sibling families. */
export function supportsDynamicEffortSiblings(provider: string): boolean {
	const lower = provider.toLowerCase();
	return rules.taxonomy.collapse.effortFamilies.some(
		(family) => family.provider === lower && family.logical.length > 0,
	);
}

/** The reviewed effort-family seeds declared for `provider`. */
export function effortFamiliesFor(provider: string): readonly { logical: string; aliases: readonly string[] }[] {
	const lower = provider.toLowerCase();
	return rules.taxonomy.collapse.effortFamilies.filter((family) => family.provider === lower);
}

/** The standard-lane id when `model` ends in a declared effort lane for `provider`. */
export function stripEffortLane(provider: string, model: string): string {
	const lowerProvider = provider.toLowerCase();
	for (const lane of rules.taxonomy.collapse.lanes) {
		if (!lane.providers.includes(lowerProvider)) continue;
		const split = model.length - lane.suffix.length;
		if (split < 0) continue;
		if (model.slice(split).toLowerCase() === lane.suffix) return model.slice(0, split);
	}
	return model;
}

/** The declared collapse suffix vocabulary (read-only view for collapse logic). */
export function collapseVocabulary() {
	return rules.taxonomy.collapse;
}

/** The declared discovery vocabulary (read-only view). */
export function discoveryVocabulary() {
	return rules.taxonomy.discovery;
}
