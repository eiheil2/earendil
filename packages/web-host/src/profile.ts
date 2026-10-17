import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebHost } from "./index.ts";

/** Mount a trusted, locally built profile. Only the declared static assets are public. */
export async function registerWebProfile(host: WebHost, directory: string): Promise<() => void> {
	const assets = await Promise.all(
		[
			["/", "index.html", "text/html; charset=utf-8"],
			["/profile.js", "profile.js", "text/javascript; charset=utf-8"],
			["/profile.css", "profile.css", "text/css; charset=utf-8"],
			["/LICENSE.deepseek", "LICENSE.deepseek", "text/plain; charset=utf-8"],
		].map(async ([path, file, contentType]) => ({
			path,
			contentType,
			content: await readFile(join(directory, file)),
		})),
	);
	const disposers: (() => void)[] = [];
	try {
		for (const asset of assets) {
			disposers.push(
				host.register({
					kind: "exact",
					method: "GET",
					path: asset.path,
					public: true,
					handler: (_request, response) => {
						response.writeHead(200, {
							"content-type": asset.contentType,
							"cache-control": "no-store",
							"x-content-type-options": "nosniff",
							"referrer-policy": "no-referrer",
							"content-security-policy":
								"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
						});
						response.end(asset.content);
					},
				}),
			);
		}
	} catch (error) {
		for (const dispose of disposers.reverse()) dispose();
		throw error;
	}
	return () => {
		for (const dispose of disposers) dispose();
	};
}
