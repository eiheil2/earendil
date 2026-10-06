/**
 * Mock OpenAI-compatible provider for install smoke tests.
 *
 * Loaded by the installed/under-test `pi` via `-e`, it starts a local HTTP
 * server on 127.0.0.1 and registers a provider `faux-local` whose single model
 * `mock-1` answers with a deterministic assistant message. No network and no
 * real provider credentials are involved.
 *
 * Usage:
 *   pi -e <this-file> --provider faux-local --model mock-1 -p "ping"
 */

import { createServer, type Server } from "node:http";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/types.ts";

const REPLY = "MOCK_RESPONSE_OK";

function chatCompletionPayload(model: string) {
	return {
		id: "chatcmpl-mock",
		object: "chat.completion",
		created: 0,
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: REPLY },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function sseChunks(model: string): string {
	const role = { role: "assistant", content: "" };
	const lines: string[] = [];
	lines.push(
		`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n`,
	);
	lines.push(
		`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }] })}\n`,
	);
	lines.push(
		`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n`,
	);
	lines.push("data: [DONE]\n");
	return lines.map((line) => `${line}\n`).join("");
}

export function startMockServer(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("mock server did not bind a port"));
				return;
			}
			resolve(address.port);
		});
	});
}

export default async function mockProviderExtension(pi: ExtensionAPI): Promise<void> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
				let parsed: { model?: string; stream?: boolean } = {};
				try {
					parsed = JSON.parse(body);
				} catch {
					// fall through with defaults
				}
				const model = parsed.model ?? "mock-1";
				if (parsed.stream === true) {
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
					res.end(sseChunks(model));
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(chatCompletionPayload(model)));
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
		});
	});
	const port = await startMockServer(server);
	// Never keep the process alive just for the mock server: pi owns the
	// lifecycle of the turn, and the server must not block process exit.
	server.unref();
	pi.registerProvider("faux-local", {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "mock-key",
		api: "openai-completions",
		models: [
			{
				id: "mock-1",
				name: "Mock Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
	});
}
