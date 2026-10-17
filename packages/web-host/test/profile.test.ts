import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWebHost, registerWebProfile } from "../src/index.ts";

test("serves public profile assets while protecting API routes and disposes all assets", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-profile-"));
	const host = createWebHost({ token: "profile-test" });
	try {
		await Promise.all(
			["index.html", "profile.js", "profile.css", "LICENSE.deepseek"].map((file) =>
				writeFile(join(directory, file), file),
			),
		);
		const dispose = await registerWebProfile(host, directory);
		host.register({
			kind: "exact",
			path: "/api",
			handler: (_request, response) => {
				response.end("private");
			},
		});
		await host.start();
		const page = await fetch(`${host.url}/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toBe("index.html");
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect((await fetch(`${host.url}/profile.js`)).headers.get("content-type")).toContain("javascript");
		expect((await fetch(`${host.url}/api`)).status).toBe(401);
		expect((await fetch(`${host.url}/`, { method: "POST" })).status).toBe(401);
		dispose();
		expect((await fetch(`${host.url}/`)).status).toBe(401);
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});
