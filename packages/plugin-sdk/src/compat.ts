/**
 * Envelope evaluation: what a host does with the `pi` contract fields at load time.
 *
 * Two levels, and they are not the same thing:
 * - Collection level: one extension failing must not affect the others. The caller keeps loading and
 *   collects `errors[]` / `warnings[]`.
 * - Inside one extension: the checks run after the factory and before the atomic `commit()`, so a
 *   rejected extension leaves no half-registered state behind.
 *
 * The rules are pure functions of their input so that the host implementation and this
 * specification cannot drift: `packages/plugin-sdk/test/host-contract.test.ts` runs the same matrix
 * through both.
 *
 * Severity mapping:
 * - E0 `errors[]`: an `apiVersion` this host does not implement. A contract version that is wrong is
 *   wrong; an extension written for another contract may call methods that do not exist here.
 * - E3 `warnings[]`: `minHostVersion` not satisfied, and capability declarations that disagree with
 *   what was observed. Both load anyway.
 * - E4: unknown manifest keys, unknown capability strings, unknown experimental entries. Silently
 *   ignored, never warned about.
 *
 * `strictCapabilities` escalates the capability findings from E3 to E0 for CI runs. It is opt-in
 * because observation only sees what the factory does through the API during loading: a capability
 * that cannot be observed produces no finding, while a capability that is merely mis-declared would
 * otherwise reject a working extension.
 */
import { satisfies, validRange } from "semver";
import type { ExtensionContractEnvelope } from "./manifest.ts";
import { PLUGIN_API_VERSION, SUPPORTED_API_VERSIONS } from "./version.ts";

export interface ExtensionContractVerdict {
	/** E0: the extension must not load. */
	errors: string[];
	/** E3: the extension loads, but something about the contract deserves a mention. */
	warnings: string[];
}

/** An extension is bound by the contract rules only once it declares part of the envelope. */
export function hasContractEnvelope(envelope?: ExtensionContractEnvelope): boolean {
	return (
		envelope !== undefined &&
		(envelope.apiVersion !== undefined ||
			envelope.minHostVersion !== undefined ||
			envelope.capabilities !== undefined ||
			envelope.experimental !== undefined)
	);
}

export interface ExtensionContractCheck {
	/** The manifest envelope, or undefined for an extension without a manifest (legacy tier). */
	envelope?: ExtensionContractEnvelope;
	/** Host version, i.e. the `version` of the host package. */
	hostVersion: string;
	/** Capabilities positively observed while the factory ran. Absent means "could not observe". */
	observedCapabilities?: readonly string[];
	/** Turn capability findings from E3 into E0. */
	strictCapabilities?: boolean;
}

export function checkExtensionContract(check: ExtensionContractCheck): ExtensionContractVerdict {
	const errors: string[] = [];
	const warnings: string[] = [];
	const { envelope, hostVersion, strictCapabilities = false } = check;
	const reportCapability = (message: string) => {
		(strictCapabilities ? errors : warnings).push(message);
	};

	const apiVersion = envelope?.apiVersion?.trim();
	if (apiVersion !== undefined && !SUPPORTED_API_VERSIONS.includes(apiVersion)) {
		errors.push(
			`requires extension API version "${apiVersion}"; this host implements version "${PLUGIN_API_VERSION}"`,
		);
	}

	const minHostVersion = envelope?.minHostVersion?.trim();
	if (minHostVersion) {
		if (validRange(minHostVersion) === null) {
			warnings.push(
				`declares minHostVersion "${minHostVersion}", which is not a valid semver range; the host requirement was not checked`,
			);
		} else if (!satisfies(hostVersion, minHostVersion, { includePrerelease: true })) {
			warnings.push(`requires host ${minHostVersion}; host version is ${hostVersion}`);
		}
	}

	const observed = [...new Set(check.observedCapabilities ?? [])].sort();
	// Capability findings only apply to an extension that joined the contract by declaring part of the
	// envelope. A legacy extension is not nagged about a field it never had a way to declare, and
	// `--strict-capabilities` cannot reject a package that never joined.
	if (observed.length > 0 && hasContractEnvelope(envelope)) {
		const declared = envelope?.capabilities;
		if (declared === undefined) {
			reportCapability(`declares no capabilities but uses: ${observed.join(", ")}`);
		} else {
			const undeclared = observed.filter((capability) => !declared.includes(capability));
			if (undeclared.length > 0) {
				reportCapability(`uses undeclared capabilities: ${undeclared.join(", ")}`);
			}
		}
	}

	return { errors, warnings };
}
