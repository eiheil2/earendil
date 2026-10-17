import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createWebHost, type WebHost } from "../src/index.ts";

const hosts = new Set<WebHost>();

afterEach(async () => {
	await Promise.all([...hosts].map((host) => host.close()));
	hosts.clear();
});

async function request(host: WebHost, path: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${host.url}${path}`, { headers });
}

describe("WebHost", () => {
	test("binds to loopback and protects routes with its process token", async () => {
		const host = createWebHost({ token: "test-token" });
		hosts.add(host);
		host.register({
			kind: "exact",
			path: "/health",
			handler: (_request, response) => {
				response.writeHead(200);
				response.end("ok");
			},
		});
		await host.start();

		expect(new URL(host.url!).hostname).toBe("127.0.0.1");
		expect((await request(host, "/health")).status).toBe(401);
		expect(await (await request(host, "/health", { authorization: "Bearer test-token" })).text()).toBe("ok");
	});

	test("uses the longest matching prefix and a separate fallback", async () => {
		const host = createWebHost({ token: "test-token" });
		hosts.add(host);
		const response = (body: string) => (_request: unknown, result: ServerResponse) => {
			result.writeHead(200);
			result.end(body);
		};
		host.register({ kind: "prefix", path: "/api", handler: response("api") });
		host.register({ kind: "prefix", path: "/api/sessions", handler: response("sessions") });
		host.registerFallback(response("spa"));
		await host.start();
		const headers = { authorization: "Bearer test-token" };

		expect(await (await request(host, "/api/sessions/one", headers)).text()).toBe("sessions");
		expect(await (await request(host, "/api/models", headers)).text()).toBe("api");
		expect(await (await request(host, "/app", headers)).text()).toBe("spa");
	});

	test("rejects duplicate routes and fallback ownership", () => {
		const host = createWebHost({ token: "test-token" });
		hosts.add(host);
		const route = { kind: "exact" as const, path: "/health", handler: () => {} };
		host.register(route);
		expect(() => host.register(route)).toThrow("already registered");
		host.registerFallback(() => {});
		expect(() => host.registerFallback(() => {})).toThrow("already registered");
	});
});
