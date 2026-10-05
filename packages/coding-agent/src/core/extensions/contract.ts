/**
 * Host side of the extension contract envelope.
 *
 * The rules live in `@earendil-works/pi-plugin-sdk` (`packages/plugin-sdk/src/compat.ts`), which is
 * what an extension compiles against. This module is the loader's copy of them: the host cannot take a
 * dependency on the SDK without publishing it as a runtime dependency, so the two implementations are
 * pinned to each other by `packages/plugin-sdk/test/host-contract.test.ts`, which runs the same input
 * matrix through both and requires identical messages. Changing a rule means changing both.
 *
 * When to run the checks: after the factory ran and before `commit()`. Everything an extension
 * registers during loading is still pending at that point, so the observation is complete for the
 * registration surface and a rejected extension leaves no half-registered state behind.
 */
import * as path from "node:path";
import { satisfies, validRange } from "semver";
import { VERSION } from "../../config.ts";
import { type PiManifest, readPiManifest } from "../pi-manifest.ts";
import { isSyntheticPath } from "../source-info.ts";

export interface ExtensionLoadOptions {
	/**
	 * Reject extensions whose declared capabilities disagree with what they registered.
	 * Off by default: observation only sees what the factory does during loading, and a mismatch
	 * warning is the useful signal. CI runs turn it on.
	 */
	strictCapabilities?: boolean;
}

export interface ExtensionContractVerdict {
	/** E0: the extension must not load. */
	errors: string[];
	/** E3: the extension loads, but something about the contract deserves a mention. */
	warnings: string[];
}

/** Mirrors `LEGACY_API_VERSION` and `PLUGIN_API_VERSION` in `packages/plugin-sdk/src/version.ts`. */
const SUPPORTED_API_VERSIONS = ["0", "1"];

/** Mirrors `PLUGIN_API_VERSION`; only used to name the implemented version in the error message. */
const IMPLEMENTED_API_VERSION = "1";

/** How far up from an extension file to look for the manifest that declares it. */
const MANIFEST_LOOKUP_DEPTH = 10;

function isSamePath(left: string, right: string): boolean {
	// `path.relative` is case-insensitive on Windows, which a string comparison would not be.
	return path.relative(left, right) === "";
}

/**
 * Find the manifest that declares this extension file.
 *
 * A manifest only counts when it declares the file itself, i.e. when the package's `pi.extensions`
 * entry resolves to it. Inferring ownership from an arbitrary ancestor would resurrect the regression
 * fixed in #9863, where an extension next to an installed `@earendil-works/pi-coding-agent` copy
 * inherited that package's resources. Directories without a manifest (a bare `foo.ts`, a built-in, an
 * inline factory) have no envelope and stay in the legacy tier.
 */
export function findExtensionManifest(resolvedPath: string): PiManifest | null {
	if (isSyntheticPath(resolvedPath)) return null;
	let dir = path.dirname(resolvedPath);
	for (let depth = 0; depth < MANIFEST_LOOKUP_DEPTH; depth++) {
		const manifest = readPiManifest(path.join(dir, "package.json"));
		if (manifest?.extensions?.some((entry) => isSamePath(path.resolve(dir, entry), resolvedPath))) {
			return manifest;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Evaluate the envelope of one extension. Mirrors `checkExtensionContract` in the SDK, message for
 * message; see that function for the reasoning behind each rule.
 */
export function checkExtensionContract(
	manifest: PiManifest | null,
	observedCapabilities: readonly string[],
	options: ExtensionLoadOptions,
): ExtensionContractVerdict {
	const errors: string[] = [];
	const warnings: string[] = [];
	const reportCapability = (message: string) => {
		(options.strictCapabilities ? errors : warnings).push(message);
	};

	const apiVersion = manifest?.apiVersion?.trim();
	if (apiVersion !== undefined && !SUPPORTED_API_VERSIONS.includes(apiVersion)) {
		errors.push(
			`requires extension API version "${apiVersion}"; this host implements version "${IMPLEMENTED_API_VERSION}"`,
		);
	}

	const minHostVersion = manifest?.minHostVersion?.trim();
	if (minHostVersion) {
		if (validRange(minHostVersion) === null) {
			warnings.push(
				`declares minHostVersion "${minHostVersion}", which is not a valid semver range; the host requirement was not checked`,
			);
		} else if (!satisfies(VERSION, minHostVersion, { includePrerelease: true })) {
			warnings.push(`requires host ${minHostVersion}; host version is ${VERSION}`);
		}
	}

	const observed = [...new Set(observedCapabilities)].sort();
	// Capability findings only apply to an extension that joined the contract by declaring part of the
	// envelope; see `hasContractEnvelope` in the SDK.
	if (observed.length > 0 && hasContractEnvelope(manifest)) {
		const declared = manifest?.capabilities;
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

/** An extension is bound by the contract rules only once it declares part of the envelope. */
function hasContractEnvelope(manifest: PiManifest | null): boolean {
	return (
		manifest !== null &&
		(manifest.apiVersion !== undefined ||
			manifest.minHostVersion !== undefined ||
			manifest.capabilities !== undefined ||
			manifest.experimental !== undefined)
	);
}
