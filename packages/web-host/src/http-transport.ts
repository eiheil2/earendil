import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ByteConnection, ByteConnectionAcceptor, ServerListener } from "@earendil-works/pi-server";
import type { WebHost } from "./index.ts";

export interface HttpTransportListenerOptions {
	readonly eventsPath?: string;
	readonly inputPath?: string;
	/** Maximum queued server bytes per browser connection. */
	readonly maxPendingBytes?: number;
	/** Maximum bytes accepted in one POST request. */
	readonly maxInputBytes?: number;
	readonly onError?: (error: Error) => void;
}

const DEFAULT_EVENTS_PATH = "/__pi/transport/events";
const DEFAULT_INPUT_PATH = "/__pi/transport/input";
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024;

interface ResolvedOptions {
	eventsPath: string;
	inputPath: string;
	maxPendingBytes: number;
	maxInputBytes: number;
	onError?: (error: Error) => void;
}

/** Adapts authenticated WebHost POST/SSE requests to the Pi Server byte listener contract. */
export class HttpTransportListener implements ServerListener {
	readonly #host: WebHost;
	readonly #options: ResolvedOptions;
	readonly #connections = new Map<string, HttpByteConnection>();
	#accept: ByteConnectionAcceptor | undefined;
	#disposeEventsRoute: (() => void) | undefined;
	#disposeInputRoute: (() => void) | undefined;
	#closing = false;
	#closePromise: Promise<void> | undefined;

	constructor(host: WebHost, options: HttpTransportListenerOptions = {}) {
		this.#host = host;
		this.#options = resolveOptions(options);
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.#accept !== undefined) throw new Error("HTTP transport listener is already started");
		if (this.#closing) throw new Error("HTTP transport listener is closing or closed");
		this.#accept = accept;
		try {
			this.#disposeEventsRoute = this.#host.register({
				kind: "exact",
				method: "GET",
				path: this.#options.eventsPath,
				handler: (request, response) => this.#openEvents(request, response),
			});
			this.#disposeInputRoute = this.#host.register({
				kind: "exact",
				method: "POST",
				path: this.#options.inputPath,
				handler: (request, response) => this.#receiveInput(request, response),
			});
		} catch (error) {
			this.#disposeEventsRoute?.();
			this.#disposeInputRoute?.();
			this.#disposeEventsRoute = undefined;
			this.#disposeInputRoute = undefined;
			this.#accept = undefined;
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closing = true;
		this.#disposeEventsRoute?.();
		this.#disposeInputRoute?.();
		this.#disposeEventsRoute = undefined;
		this.#disposeInputRoute = undefined;
		this.#closePromise = Promise.all([...this.#connections.values()].map((connection) => connection.close())).then(
			() => {
				this.#connections.clear();
				this.#accept = undefined;
			},
		);
		return this.#closePromise;
	}

	async #openEvents(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.#closing) {
			response.writeHead(503);
			response.end("Transport is closing");
			return;
		}
		const connectionId = randomUUID();
		const connection = new HttpByteConnection(response, this.#options.maxPendingBytes, () =>
			this.#connections.delete(connectionId),
		);
		this.#connections.set(connectionId, connection);
		response.writeHead(200, {
			"cache-control": "no-cache, no-store",
			connection: "keep-alive",
			"content-type": "text/event-stream; charset=utf-8",
			"x-accel-buffering": "no",
			"x-pi-connection-id": connectionId,
		});
		response.flushHeaders();
		const accept = this.#accept;
		if (accept === undefined) {
			await connection.close();
			return;
		}
		let handler: ReturnType<ByteConnectionAcceptor>;
		try {
			handler = accept(connection);
		} catch (error) {
			this.#reportError(error);
			await connection.close();
			return;
		}
		connection.handler = handler;
		const closeHandler = (): void => {
			connection.markClosed();
		};
		request.on("aborted", closeHandler);
		response.on("close", closeHandler);
		response.on("error", (error) => handler.onError(error));
		await connection.waitClosed;
	}

	async #receiveInput(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const connectionId = new URL(request.url ?? "/", "http://localhost").searchParams.get("connection");
		const connection = connectionId === null ? undefined : this.#connections.get(connectionId);
		if (connection === undefined || connection.closed) {
			request.resume();
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Unknown transport connection");
			return;
		}
		try {
			const body = await readBody(request, this.#options.maxInputBytes);
			connection.handler?.onData(body);
			response.writeHead(204);
			response.end();
		} catch (error) {
			this.#reportError(error);
			connection.handler?.onError(toError(error));
			if (!response.headersSent) {
				response.writeHead(error instanceof RequestBodyTooLargeError ? 413 : 400);
				response.end(
					error instanceof RequestBodyTooLargeError ? "Request body too large" : "Invalid transport input",
				);
			}
		}
	}

	#reportError(error: unknown): void {
		try {
			this.#options.onError?.(toError(error));
		} catch {
			// Error observers cannot affect transport state.
		}
	}
}

class RequestBodyTooLargeError extends Error {}

class HttpByteConnection implements ByteConnection {
	readonly #response: ServerResponse;
	readonly #maxPendingBytes: number;
	readonly #onClosed: () => void;
	readonly waitClosed: Promise<void>;
	#resolveClosed!: () => void;
	#closed = false;
	#closing = false;
	#pendingBytes = 0;
	#writeTail: Promise<void> = Promise.resolve();
	#handler: ReturnType<ByteConnectionAcceptor> | undefined;

	constructor(response: ServerResponse, maxPendingBytes: number, onClosed: () => void) {
		this.#response = response;
		this.#maxPendingBytes = maxPendingBytes;
		this.#onClosed = onClosed;
		this.waitClosed = new Promise<void>((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	get closed(): boolean {
		return this.#closed;
	}

	get handler(): ReturnType<ByteConnectionAcceptor> | undefined {
		return this.#handler;
	}

	set handler(value: ReturnType<ByteConnectionAcceptor>) {
		this.#handler = value;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array))
			return Promise.reject(new TypeError("HTTP connection chunks must be Uint8Array"));
		if (this.#closed || this.#closing) return Promise.reject(new Error("HTTP connection is closed"));
		return this.#enqueue(chunk);
	}

	#enqueue(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array))
			return Promise.reject(new TypeError("HTTP connection chunks must be Uint8Array"));
		if (this.#closed) return Promise.reject(new Error("HTTP connection is closed"));
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("HTTP connection exceeded its pending byte limit"));
		}
		const bytes = chunk.slice();
		this.#pendingBytes += bytes.byteLength;
		const write = this.#writeTail.then(() => this.#write(bytes));
		const tracked = write.finally(() => {
			this.#pendingBytes -= bytes.byteLength;
		});
		this.#writeTail = tracked.catch(() => {});
		return tracked;
	}

	async close(finalChunk?: Uint8Array): Promise<void> {
		if (this.#closed) return;
		if (this.#closing) return this.#writeTail;
		this.#closing = true;
		try {
			if (finalChunk !== undefined) await this.#enqueue(finalChunk);
			await this.#writeTail;
			if (!this.#closed) this.#response.end();
		} finally {
			this.#markClosed();
		}
	}

	markClosed(): boolean {
		if (this.#closed) return false;
		this.#markClosed();
		return true;
	}

	async #write(bytes: Uint8Array): Promise<void> {
		const data = `data: ${Buffer.from(bytes).toString("base64")}\n\n`;
		await new Promise<void>((resolve, reject) => {
			this.#response.write(data, "utf8", (error: Error | null | undefined) =>
				error === undefined || error === null ? resolve() : reject(error),
			);
		});
	}

	#markClosed(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClosed();
		this.#resolveClosed();
		this.#handler?.onClose();
	}
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += bytes.byteLength;
		if (length > maxBytes) throw new RequestBodyTooLargeError();
		chunks.push(bytes);
	}
	return new Uint8Array(Buffer.concat(chunks, length));
}

function resolveOptions(options: HttpTransportListenerOptions): ResolvedOptions {
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
	const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new RangeError("HTTP transport maxPendingBytes must be a positive safe integer");
	}
	if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
		throw new RangeError("HTTP transport maxInputBytes must be a positive safe integer");
	}
	return {
		eventsPath: options.eventsPath ?? DEFAULT_EVENTS_PATH,
		inputPath: options.inputPath ?? DEFAULT_INPUT_PATH,
		maxPendingBytes,
		maxInputBytes,
		onError: options.onError,
	};
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function createHttpTransportListener(
	host: WebHost,
	options?: HttpTransportListenerOptions,
): HttpTransportListener {
	return new HttpTransportListener(host, options);
}
