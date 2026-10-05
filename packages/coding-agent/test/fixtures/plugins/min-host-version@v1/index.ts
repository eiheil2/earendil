/**
 * Compatibility fixture: an unsatisfied `minHostVersion`.
 *
 * The host is 1.0.0 and this requires >=999.0.0, so the check must produce a warning and the plugin must
 * load anyway. That asymmetry is the whole decision: `apiVersion` rejects, `minHostVersion` warns.
 *
 * The reasoning is that the two fields answer different questions. A wrong `apiVersion` means the plugin
 * was written against a contract this host does not implement - it may call methods that do not exist
 * here, so refusing is the safe answer. An unsatisfied `minHostVersion` means the plugin asked for a
 * feature the host may lack, which is a guess about which: rejecting would empty the ecosystem on every
 * host that is behind by a patch release, and the alternative - guessing whether the plugin actually
 * touches the missing feature - needs the complete set of pending commit slots, where one missed slot
 * silently bricks a working plugin. Warning plus loading is the industry consensus and the only option
 * that does not punish a plugin for a host's release cadence.
 *
 * The `warnings` slot on the loader used to be declared and returned but never written to. This fixture
 * is what puts something in it, and it is pinned by the recorded baseline.
 */
import type { ExtensionApi } from "@earendil-works/pi-plugin-sdk";

export default function activate(pi: ExtensionApi): void {
	pi.registerCommand("fixture-min-host-version", {
		description: "Registered so the fixture loads with a non-empty surface despite the version warning.",
		handler: async () => {},
	});
}
