import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	/**
	 * Contract major version the extension was written against, e.g. `"1"`.
	 * Absent means the legacy tier, which every host loads.
	 */
	apiVersion?: string;
	/** semver range the host must satisfy. Warned about, never enforced. */
	minHostVersion?: string;
	/** Capabilities the extension intends to use. Unknown values are ignored. */
	capabilities?: string[];
	/** Unstable capabilities. Never enforced. */
	experimental?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;
const STRING_FIELDS = ["apiVersion", "minHostVersion"] as const;
const STRING_ARRAY_FIELDS = ["capabilities", "experimental"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

/**
 * Read the `pi` block of a package manifest.
 *
 * Unknown fields are silently ignored, never warned about: the manifest comes from the ecosystem, so
 * a new host must be able to read old packages and vice versa. A field of the wrong type is ignored
 * the same way. Parsing failures return null rather than throwing, because a malformed manifest
 * must not take down discovery for the other extensions.
 */
export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg) || !isObject(pkg.pi)) {
			return null;
		}

		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = readStringArray(pkg.pi[field]);
			if (entries) {
				manifest[field] = entries;
			}
		}
		for (const field of STRING_FIELDS) {
			const value = pkg.pi[field];
			if (typeof value === "string") {
				manifest[field] = value;
			}
		}
		for (const field of STRING_ARRAY_FIELDS) {
			const entries = readStringArray(pkg.pi[field]);
			if (entries) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found. This is the single implementation: it used
 * to be duplicated verbatim in the extension loader and in the package manager, where changing one
 * copy and forgetting the other silently changed discovery for one of the two entry points.
 */
export function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}
