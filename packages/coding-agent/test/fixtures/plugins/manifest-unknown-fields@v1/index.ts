/**
 * Compatibility fixture: the manifest is the interesting part.
 *
 * Its `package.json` carries five keys under `pi` that this host does not know - `author`, `homepage`,
 * `keywords`, `x-internal-build` and a nested object - plus two it does: `apiVersion` and `capabilities`.
 *
 * The requirement being pinned is E4: a manifest reader must ignore an unknown key *silently*. Not
 * "ignore it and warn" - warn. `test/skills.test.ts` already locks that for skills, and this fixture is
 * the extension-side twin: an ecosystem manifest is data written by a package this host has never seen,
 * so every field it does not recognize has to be tolerated without noise. A host that warned would turn
 * every future field addition in the contract into a warning storm across the installed ecosystem.
 *
 * The fixture also registers a command, so its recorded surface is not empty and an accidental failure to
 * load cannot hide behind "it registered nothing anyway".
 */
import type { ExtensionApi } from "@earendil-works/pi-plugin-sdk";

export default function activate(pi: ExtensionApi): void {
	pi.registerCommand("fixture-unknown-fields", {
		description: "Registered so this fixture has a non-empty recorded surface.",
		handler: async () => {},
	});
}
