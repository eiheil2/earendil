import { afterEach, describe, expect, test } from "vitest";
import { Client, createHttpTransportFactory } from "../../client/src/index.ts";
import { createTestServer } from "../../server/src/testing/index.ts";
import { createHttpTransportListener, createWebHost, type WebHost } from "../src/index.ts";

const serverId = "00000000-0000-4000-8000-000000000001";
const hosts = new Set<WebHost>();

afterEach(async () => {
	await Promise.all([...hosts].map((host) => host.close()));
	hosts.clear();
});

describe("HTTP transport listener", () => {
	test("notifies the server exactly once when the listener closes and delivers its final frame", async () => {
		const host = createWebHost({ token: "test-token" });
		hosts.add(host);
		const listener = createHttpTransportListener(host);
		let closes = 0;
		await listener.start((connection) => {
			void connection.close(new Uint8Array([1, 2, 3]));
			return {
				onData() {},
				onError() {},
				onClose() {
					closes += 1;
				},
			};
		});
		await host.start();
		try {
			const events = await fetch(`${host.url}/__pi/transport/events`, {
				headers: { authorization: "Bearer test-token" },
			});
			expect(await events.text()).toBe("data: AQID\n\n");
			await expect.poll(() => closes).toBe(1);
			await listener.close();
			expect(closes).toBe(1);
		} finally {
			await listener.close();
		}
	});
	test("bridges a real Pi Server handshake over POST/SSE", async () => {
		const webHost = createWebHost({ token: "test-token" });
		hosts.add(webHost);
		const listener = createHttpTransportListener(webHost);
		const { server } = createTestServer({ listeners: [listener], serverId });
		await webHost.start();
		await server.start();

		const client = await Client.connect({
			serverId,
			transportFactory: createHttpTransportFactory({ baseUrl: webHost.url!, token: webHost.token }),
		});
		try {
			expect(client.connected).toBe(true);
			expect(client.hello).toMatchObject({ type: "hello", serverId });
		} finally {
			await client.dispose();
			await server.close();
		}
	});
});
