#!/usr/bin/env node
// Rewrite a fresh app's package.json so every @earendil-works/* workspace
// dependency resolves to the locally packed tarball instead of the registry.
// Usage: node scripts/install-tests/write-tarball-overrides.mjs <appDir> <tarballDir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

// Extract a single file from a .tgz without shelling out to tar: tarballs are
// gzip'd tar archives of 512-byte blocks, and the entry we need is at a fixed
// logical location. A self-contained parser avoids PATH/path-style hazards on
// Windows (native tar vs msys tar vs cmd).
function readPackPackageJson(full) {
	const buf = gunzipSync(readFileSync(full));
	let offset = 0;
	while (offset + 512 <= buf.length) {
		const header = buf.subarray(offset, offset + 512);
		const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
		const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim();
		const size = Number.parseInt(sizeOctal || "0", 8);
		const type = String.fromCharCode(buf[offset + 156] || 48);
		const dataStart = offset + 512;
		if (type === "0" && (name === "package/package.json" || name.endsWith("/package/package.json"))) {
			return JSON.parse(buf.subarray(dataStart, dataStart + size).toString("utf8"));
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	throw new Error(`package/package.json not found in ${full}`);
}

const [appDir, tarballDir] = process.argv.slice(2);
const pkgPath = join(appDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.overrides = pkg.overrides || {};
for (const file of readdirSync(tarballDir)) {
	if (!file.endsWith(".tgz")) continue;
	const full = join(tarballDir, file);
	const meta = readPackPackageJson(full);
	// The coding-agent tarball is passed as a direct dependency on the CLI;
	// overriding it too trips npm's EOVERRIDE direct-dependency conflict.
	if (meta.name === "@earendil-works/pi-coding-agent") continue;
	pkg.overrides[meta.name] = full;
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
console.log(`Wrote overrides for ${Object.keys(pkg.overrides).length} packages`);
