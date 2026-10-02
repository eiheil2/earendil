import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinProviders, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";
import type { KnownProvider, ProviderId } from "../src/types.ts";

/** Provider ids that existed before Phase 1; none of them may disappear. */
const PRE_PHASE1_PROVIDERS = [
	"amazon-bedrock",
	"ant-ling",
	"anthropic",
	"google",
	"google-vertex",
	"openai",
	"azure-openai-responses",
	"openai-codex",
	"radius",
	"typesafe",
	"nvidia",
	"deepseek",
	"github-copilot",
	"xai",
	"groq",
	"cerebras",
	"openrouter",
	"vercel-ai-gateway",
	"zai",
	"zai-coding-cn",
	"mistral",
	"minimax",
	"minimax-cn",
	"moonshotai",
	"moonshotai-cn",
	"huggingface",
	"fireworks",
	"together",
	"baseten",
	"opencode",
	"opencode-go",
	"kimi-coding",
	"meta",
	"cloudflare-workers-ai",
	"cloudflare-ai-gateway",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
] as const satisfies readonly KnownProvider[];

describe("nebius catalog registration", () => {
	it("adds nebius without dropping any pre-existing builtin provider", () => {
		const ids = builtinProviders().map((provider) => provider.id);
		expect(ids).toHaveLength(PRE_PHASE1_PROVIDERS.length + 1);
		for (const id of PRE_PHASE1_PROVIDERS) {
			expect(ids, `${id} must survive Phase 1`).toContain(id);
		}
		expect(ids).toContain("nebius");
		expect(getBuiltinProviders()).toContain("nebius");
	});

	it("exposes nebius chat models with a consistent provider and api", () => {
		const models = getBuiltinModels("nebius");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.provider).toBe("nebius");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.tokenfactory.nebius.com/v1");
			expect(model.contextWindow).toBeGreaterThan(0);
		}
		expect(getBuiltinModel("nebius", "openai/gpt-oss-120b")).toMatchObject({
			provider: "nebius",
			api: "openai-completions",
		});
	});

	it("keeps the open-string fallbacks of ProviderId and the env key mapping", () => {
		const known: ProviderId = "nebius";
		const unknown: ProviderId = "phase1-not-a-known-provider";
		expect(known).toBe("nebius");
		expect(unknown).toBe("phase1-not-a-known-provider");

		expect(findEnvKeys("nebius", { NEBIUS_API_KEY: "key" })).toEqual(["NEBIUS_API_KEY"]);
		expect(findEnvKeys("nebius", {})).toBeUndefined();
		expect(getEnvApiKey("nebius", { NEBIUS_API_KEY: "key" })).toBe("key");
		expect(getEnvApiKey("nebius", {})).toBeUndefined();
	});
});
