import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/** Derive the local Unix socket path for one logical server identity. */
export function getUnixSocketPath(serverId: string, serverDirectory: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(serverId)) {
		throw new TypeError("Unix serverId must be a canonical lowercase UUIDv4");
	}
	return getLocalSocketPath(`${serverId}.sock`, serverDirectory);
}

/** Resolve a local IPC endpoint, using a directory-scoped named pipe on Windows. */
export function getLocalSocketPath(name: string, directory: string): string {
	if (process.platform !== "win32") return join(directory, name);
	const scope = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex").slice(0, 24);
	return `\\\\.\\pipe\\pi-${scope}-${name}`;
}
