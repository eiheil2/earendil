import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

export interface HttpTransportOptions {
	/** Origin of the WebHost, for example `http://127.0.0.1:3080`. */
	readonly baseUrl: string;
	/** Process-local WebHost bearer token. */
	readonly token: string;
	readonly eventsPath?: string;
	readonly inputPath?: string;
	readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_EVENTS_PATH = "/__pi/transport/events";
const DEFAULT_INPUT_PATH = "/__pi/transport/input";

/** Creates browser-compatible POST/SSE byte transports for a Pi WebHost. */
export function createHttpTransportFactory(options: HttpTransportOptions): ByteTransportFactory {
	const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
	if (typeof fetcher !== "function") throw new Error("The Web transport requires a fetch implementation");
	const baseUrl = new URL(options.baseUrl);
	const eventsPath = options.eventsPath ?? DEFAULT_EVENTS_PATH;
	const inputPath = options.inputPath ?? DEFAULT_INPUT_PATH;
	return (handlers) => openHttpTransport(baseUrl, eventsPath, inputPath, options.token, fetcher, handlers);
}

async function openHttpTransport(
	baseUrl: URL,
	eventsPath: string,
	inputPath: string,
	token: string,
	fetcher: typeof globalThis.fetch,
	handlers: ByteTransportHandlers,
): Promise<ByteTransport> {
	const controller = new AbortController();
	const response = await fetcher(resolveUrl(baseUrl, eventsPath), {
		headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
		signal: controller.signal,
	});
	if (!response.ok) {
		controller.abort();
		throw new Error(`Web transport events request failed with HTTP ${response.status}`);
	}
	if (response.body === null) {
		controller.abort();
		throw new Error("Web transport events response has no body");
	}
	const connectionId = response.headers.get("x-pi-connection-id");
	if (!connectionId) {
		controller.abort();
		throw new Error("Web transport events response has no connection ID");
	}
	const transport = new HttpByteTransport(connectionId, resolveUrl(baseUrl, inputPath), token, fetcher, controller);
	void consumeEvents(response.body, handlers, transport);
	return transport;
}

class HttpByteTransport implements ByteTransport {
	readonly #connectionId: string;
	readonly #inputUrl: string;
	readonly #token: string;
	readonly #fetcher: typeof globalThis.fetch;
	readonly #controller: AbortController;
	#closed = false;
	#sendTail: Promise<void> = Promise.resolve();

	constructor(
		connectionId: string,
		inputUrl: string,
		token: string,
		fetcher: typeof globalThis.fetch,
		controller: AbortController,
	) {
		this.#connectionId = connectionId;
		this.#inputUrl = inputUrl;
		this.#token = token;
		this.#fetcher = fetcher;
		this.#controller = controller;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array))
			return Promise.reject(new TypeError("Web transport chunks must be Uint8Array"));
		if (this.#closed) return Promise.reject(new Error("Web transport is closed"));
		const bytes = chunk.slice();
		const send = this.#sendTail.then(async () => {
			const response = await this.#fetcher(
				`${this.#inputUrl}?connection=${encodeURIComponent(this.#connectionId)}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${this.#token}`,
						"content-type": "application/octet-stream",
					},
					body: bytes,
					signal: this.#controller.signal,
				},
			);
			if (!response.ok) throw new Error(`Web transport input request failed with HTTP ${response.status}`);
		});
		this.#sendTail = send.catch(() => {});
		return send;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.abort();
	}

	get closed(): boolean {
		return this.#closed;
	}
}

async function consumeEvents(
	body: ReadableStream<Uint8Array>,
	handlers: ByteTransportHandlers,
	transport: HttpByteTransport,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			pending += decoder.decode(result.value, { stream: true });
			let separator = pending.indexOf("\n\n");
			while (separator !== -1) {
				const event = pending.slice(0, separator);
				pending = pending.slice(separator + 2);
				for (const line of event.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					handlers.onData(decodeBase64(line.slice(6).trim()));
				}
				separator = pending.indexOf("\n\n");
			}
		}
		if (!transport.closed) {
			handlers.onClose();
			transport.close();
		}
	} catch (error) {
		if (!transport.closed) {
			handlers.onError(error instanceof Error ? error : new Error(String(error)));
			transport.close();
		}
	} finally {
		reader.releaseLock();
	}
}

function resolveUrl(baseUrl: URL, path: string): string {
	return new URL(path, baseUrl).toString();
}

function decodeBase64(value: string): Uint8Array {
	const binary = globalThis.atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
