import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { formatTokens } from "./components/footer.ts";

/**
 * Kimi Coding bills subscription usage through API-key auth, so the provider-level
 * OAuth check alone would label it as metered.
 */
export function isSubscriptionBackedProvider(modelRuntime: ModelRuntime, providerId: string): boolean {
	return providerId === "kimi-coding" || modelRuntime.isUsingSubscription(providerId);
}

export interface ModelCandidateMetaOptions {
	/** Whether the current credentials for this model's provider are subscription-backed. */
	subscription: boolean;
}

/**
 * One-line annotation for a selectable model: context window, image support, and billing
 * (`131k ctx · images · subscription`). Model rows are the only consumer, so it stays compact.
 */
export function formatModelCandidateMeta(model: Model<Api>, options: ModelCandidateMetaOptions): string {
	const context = `${formatTokens(model.contextWindow)} ctx`;
	const images = model.input.includes("image") ? "images" : "text only";
	let billing: string;
	if (options.subscription) {
		billing = "subscription";
	} else if (model.cost.input === 0 && model.cost.output === 0) {
		billing = "free";
	} else {
		billing = `$${model.cost.input}/$${model.cost.output}`;
	}
	return [context, images, billing].join(" · ");
}
