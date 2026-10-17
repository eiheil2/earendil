import {
	createRemoteServiceBinding,
	createRemoteServiceEndpoint,
	RemoteServiceProvider,
	replicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationView, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ServerHost } from "@earendil-works/pi-server";
import { expect, test } from "vitest";
import { Client, createClientServiceTransport, createHttpTransportFactory } from "../../client/src/index.ts";
import { AgentController } from "../../coding-agent/src/experimental/services/agent-controller.ts";
import { createExperimentalServerServices } from "../../coding-agent/src/experimental/services/server.ts";
import { SessionDirectory, SessionManagement } from "../../coding-agent/src/experimental/services/sessions.ts";
import { Transcript } from "../../coding-agent/src/experimental/services/transcript.ts";
import { createTestServer } from "../../server/src/testing/index.ts";
import { createHttpTransportListener, createWebHost } from "../src/index.ts";

test("lists and attaches a Session, hydrates transcript and routes a prompt over HTTP", async () => {
	const serverId = "00000000-0000-4000-8000-000000000001";
	const web = createWebHost({ token: "session-test" });
	const sessions = [{ serverId, sessionId: "demo", createdAt: 1 }];
	const services = await createExperimentalServerServices({
		async list() {
			return sessions;
		},
		async create() {
			throw new Error("unused");
		},
		async remove() {
			throw new Error("unused");
		},
		async prepareSessionPlugins() {
			throw new Error("unused");
		},
		async reloadPresentationPlugins() {
			throw new Error("unused");
		},
	});
	// Only the Session worker is a fixture; the server services, routing and browser transport are real.
	const state = replicatedState<ConversationView>({
		conversation: { id: ROOT_CONVERSATION_ID },
		entries: [],
		docs: {},
	});
	let releases = 0;
	const host: ServerHost = {
		serverServices: services.host,
		async resolveSession(id) {
			if (id !== "demo") throw new Error("Unknown Session");
			return { id };
		},
		async openSession() {
			return {
				attachClient() {
					const provider = new RemoteServiceProvider([Transcript, AgentController]);
					provider.provide(Transcript, { state });
					provider.provide(AgentController, {
						async prompt(request, context) {
							state.change(context, (draft) => {
								draft.docs["test.prompt"] = { message: request.message };
							});
							return { accepted: true, operationId: "prompt-1", error: null };
						},
						async abort() {},
						async steer() {
							throw new Error("unused");
						},
						async followUp() {
							throw new Error("unused");
						},
						async cancelQueued() {
							throw new Error("unused");
						},
						async compact() {
							throw new Error("unused");
						},
						async waitForPrompt() {
							throw new Error("unused");
						},
					});
					const endpoint = createRemoteServiceEndpoint(provider);
					return {
						invokeService: endpoint.invoke.bind(endpoint),
						release() {
							endpoint.dispose();
							provider.dispose();
							releases += 1;
						},
					};
				},
				async close() {},
			};
		},
	};
	const { server } = createTestServer({ host, serverId, listeners: [createHttpTransportListener(web)] });
	let client: Client | undefined;
	try {
		await server.start();
		await web.start();
		expect((await fetch(`${web.url}/__pi/transport/events`)).status).toBe(401);
		client = await Client.connect({
			serverId,
			transportFactory: createHttpTransportFactory({ baseUrl: web.url!, token: web.token }),
		});
		const activeClient = client;
		const directory = createRemoteServiceBinding({
			services: [SessionDirectory, SessionManagement],
			transport: createClientServiceTransport(client, () => ({ serverId })),
		});
		const listing = directory.use(SessionDirectory);
		await directory.ready(BACKGROUND_CONTEXT);
		expect(listing.state.value?.sessions).toEqual(sessions);
		await directory.use(SessionManagement).attach("demo", BACKGROUND_CONTEXT);
		const attached = createRemoteServiceBinding({
			services: [Transcript, AgentController],
			transport: createClientServiceTransport(client, () => activeClient.attachment),
		});
		const transcript = attached.use(Transcript);
		await attached.ready(BACKGROUND_CONTEXT);
		expect(transcript.state.value?.entries).toEqual([]);
		expect(
			await attached.use(AgentController).prompt({ message: "hello", images: null }, BACKGROUND_CONTEXT),
		).toMatchObject({ accepted: true });
		await expect.poll(() => transcript.state.value?.docs["test.prompt"]).toEqual({ message: "hello" });
		await attached.dispose(BACKGROUND_CONTEXT);
		await directory.dispose(BACKGROUND_CONTEXT);
		await client.dispose();
		await expect.poll(() => releases).toBe(1);
	} finally {
		await client?.dispose();
		await server.close();
		await services.dispose();
		await web.close();
	}
});
