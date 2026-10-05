/**
 * Compatibility fixture: registers a provider with an OAuth login flow.
 *
 * The reason this fixture exists is `usesCallbackServer`. It is `@deprecated` on the host - canonical
 * auth flows ignore it - and it is still declared in `ProviderConfig.oauth`. Deprecated-but-declared is
 * the exact state where a refactor is tempted to delete a field, so the fixture uses it and the
 * bidirectional conformance check in `packages/plugin-sdk/test/host-conformance.test.ts` fails if it goes.
 *
 * The credentials and callback types here are structural. They mirror what the host passes, which is what
 * makes the host's `oauth` block mutually assignable with the SDK's declaration of it; they are not
 * copied host types with their behaviour.
 */
import type { ExtensionApi, ExtensionOAuthCredentials, ExtensionProviderOauth } from "@earendil-works/pi-plugin-sdk";

const PROVIDER_NAME = "fixture-oauth-provider";

export default function activate(pi: ExtensionApi): void {
	pi.registerProvider(PROVIDER_NAME, {
		name: "Fixture OAuth Provider",
		baseUrl: "https://api.example.com/v1",
		// The host interpolates `$NAME` in an api key literal at read time, so this stays a plain string
		// rather than a template - the placeholder is the value, not an interpolation.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is the host's env-interpolation syntax
		apiKey: "${FIXTURE_OAUTH_API_KEY}",
		oauth: oauthFixture,
	});
}

/**
 * A login flow that is never invoked by the compatibility suite - it exists to be type-checked and
 * registered, not to reach a network. Returning fixed credentials is what a real plugin would not do and
 * a fixture must.
 */
export const oauthFixture: ExtensionProviderOauth = {
	name: "Fixture OAuth",
	// Deprecated on the host, retained for source compatibility. See the file header.
	usesCallbackServer: false,
	async login(callbacks) {
		callbacks.onAuth({
			url: "https://auth.example.com/authorize?client_id=fixture",
			instructions: "Compatibility fixture; no real login is performed.",
		});
		return fixtureCredentials();
	},
	async refreshToken(credentials) {
		return { ...credentials, access: `${credentials.access}-refreshed` };
	},
	getApiKey(credentials) {
		return credentials.access;
	},
};

function fixtureCredentials(): ExtensionOAuthCredentials {
	return { access: "fixture-access-token", refresh: "fixture-refresh-token", expires: 0 };
}
