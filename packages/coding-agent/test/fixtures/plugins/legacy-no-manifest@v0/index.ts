/**
 * Compatibility fixture: a plugin from before the contract existed.
 *
 * Two things make it legacy. There is no `pi` block in its manifest, and it imports nothing from the SDK
 * - which is what every plugin in the ecosystem looked like when the contract shipped. It uses no
 * parameter annotations either, because there was no type to annotate them with.
 *
 * The legacy tier is the reason the contract could ship at all. If a missing `apiVersion` were an error,
 * every existing plugin would stop loading on upgrade and the ecosystem would be emptied in one release.
 * So an undeclared version means "always loadable", and it is silent: no warning, because a warning per
 * legacy plugin on every startup is noise that trains people to ignore warnings.
 *
 * This is the fixture that would catch a change making the contract mandatory. It must keep loading
 * silently on every host, including hosts that implement a later `PLUGIN_API_VERSION`.
 */
export default function activate(pi: {
	registerCommand(name: string, options: { handler: () => Promise<void> }): void;
	registerFlag(name: string, options: { type: "boolean"; description: string }): void;
}): void {
	pi.registerCommand("fixture-legacy", {
		handler: async () => {},
	});
	pi.registerFlag("fixture-legacy-flag", {
		type: "boolean",
		description: "Registered to give this fixture a non-empty recorded surface.",
	});
}
