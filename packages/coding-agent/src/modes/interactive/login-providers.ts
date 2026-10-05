import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { AuthSelectorProvider } from "./components/oauth-selector.ts";

/**
 * Build the `/login` provider choices for a runtime: one entry per provider and auth
 * method it supports, each labeled with its current configuration status.
 */
export function buildLoginProviderOptions(
	modelRuntime: ModelRuntime,
	authType?: "oauth" | "api_key",
): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of modelRuntime.getProviders()) {
		const authStatus = modelRuntime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		const subscription = provider.auth.oauth?.isSubscription === true;
		if ((!authType || authType === "oauth") && provider.auth.oauth) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: provider.auth.oauth,
				status,
				subscription,
			});
		}
		if ((!authType || authType === "api_key") && provider.auth.apiKey) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
				subscription,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}
