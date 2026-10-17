import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type WebRouteKind = "exact" | "prefix";
export type WebRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
export type WebRequestHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export interface WebRoute {
	readonly kind: WebRouteKind;
	readonly path: string;
	readonly method?: WebRequestMethod;
	/** Public static assets only; API and transport routes require authentication by default. */
	readonly public?: boolean;
	readonly handler: WebRequestHandler;
}

export interface WebHostOptions {
	readonly host?: "127.0.0.1" | "0.0.0.0";
	readonly port?: number;
	/** Process-local credential required by browser and API requests. */
	readonly token?: string;
	readonly requestTimeoutMs?: number;
}

export interface WebHostAddress {
	readonly host: string;
	readonly port: number;
	readonly url: string;
}

const DEFAULT_HOST = "127.0.0.1" as const;
const DEFAULT_PORT = 0;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function normalizePath(path: string): string {
	if (!path.startsWith("/") || path.includes("?")) throw new TypeError("Web route path must be an absolute pathname");
	if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
	return path;
}

function routeMatches(route: WebRoute, pathname: string): boolean {
	if (route.kind === "exact") return route.path === pathname;
	return route.path === "/" || pathname === route.path || pathname.startsWith(`${route.path}/`);
}

function normalizeMethod(method: string): WebRequestMethod | undefined {
	const upper = method.toUpperCase();
	return upper === "GET" ||
		upper === "POST" ||
		upper === "PUT" ||
		upper === "PATCH" ||
		upper === "DELETE" ||
		upper === "OPTIONS" ||
		upper === "HEAD"
		? upper
		: undefined;
}

function createToken(): string {
	return randomBytes(24).toString("base64url");
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
	const authorization = request.headers.authorization;
	return authorization === `Bearer ${token}`;
}

function respondUnauthorized(response: ServerResponse): void {
	response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "www-authenticate": "Bearer" });
	response.end("Unauthorized");
}

function respondNotFound(response: ServerResponse): void {
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("Not found");
}

export class WebHost {
	readonly #options: Required<Pick<WebHostOptions, "host" | "port" | "requestTimeoutMs">> & { token: string };
	readonly #routes = new Map<string, WebRoute>();
	readonly #server: Server;
	#fallback: WebRequestHandler | undefined;
	#address: WebHostAddress | undefined;
	#startPromise: Promise<this> | undefined;
	#closePromise: Promise<void> | undefined;

	constructor(options: WebHostOptions = {}) {
		this.#options = {
			host: options.host ?? DEFAULT_HOST,
			port: options.port ?? DEFAULT_PORT,
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			token: options.token ?? createToken(),
		};
		if (this.#options.port < 0 || this.#options.port > 65_535 || !Number.isInteger(this.#options.port)) {
			throw new RangeError("Web host port must be an integer from 0 through 65535");
		}
		if (this.#options.requestTimeoutMs < 0 || !Number.isFinite(this.#options.requestTimeoutMs)) {
			throw new RangeError("Web host request timeout must be non-negative");
		}
		this.#server = createServer((request, response) => this.#handle(request, response));
		this.#server.requestTimeout = this.#options.requestTimeoutMs;
	}

	get token(): string {
		return this.#options.token;
	}

	get address(): WebHostAddress | undefined {
		return this.#address;
	}

	get url(): string | undefined {
		return this.#address?.url;
	}

	register(route: WebRoute): () => void {
		const normalized: WebRoute = {
			...route,
			path: normalizePath(route.path),
			method: route.method?.toUpperCase() as WebRequestMethod | undefined,
		};
		if (normalized.method !== undefined && normalizeMethod(normalized.method) === undefined) {
			throw new TypeError(`Unsupported web route method: ${normalized.method}`);
		}
		const key = `${normalized.method ?? "*"}:${normalized.kind}:${normalized.path}`;
		if (this.#routes.has(key)) throw new Error(`Web route already registered: ${normalized.kind} ${normalized.path}`);
		this.#routes.set(key, normalized);
		return () => {
			if (this.#routes.get(key) === normalized) this.#routes.delete(key);
		};
	}

	registerFallback(handler: WebRequestHandler): () => void {
		if (this.#fallback !== undefined) throw new Error("Web fallback is already registered");
		this.#fallback = handler;
		return () => {
			if (this.#fallback === handler) this.#fallback = undefined;
		};
	}

	start(): Promise<this> {
		if (this.#address !== undefined) return Promise.reject(new Error("Web host is already started"));
		if (this.#startPromise !== undefined) return this.#startPromise;
		if (this.#closePromise !== undefined) return Promise.reject(new Error("Web host is closed"));
		this.#startPromise = new Promise<this>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.#server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				this.#server.off("error", onError);
				const address = this.#server.address();
				if (address === null || typeof address === "string") {
					reject(new Error("Web host did not expose a TCP address"));
					return;
				}
				this.#address = {
					host: this.#options.host,
					port: address.port,
					url: `http://${this.#options.host}:${address.port}`,
				};
				resolve(this);
			};
			this.#server.once("error", onError);
			this.#server.once("listening", onListening);
			this.#server.listen(this.#options.port, this.#options.host);
		}).finally(() => {
			this.#startPromise = undefined;
		});
		return this.#startPromise;
	}

	close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		if (this.#startPromise !== undefined) {
			this.#closePromise = this.#startPromise
				.catch(() => {})
				.then(() => {
					if (this.#address === undefined) return;
					return new Promise<void>((resolve, reject) => {
						this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
					});
				});
			return this.#closePromise;
		}
		if (this.#address === undefined) return Promise.resolve();
		this.#closePromise = new Promise<void>((resolve, reject) => {
			this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
		});
		return this.#closePromise;
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		const method = normalizeMethod(request.method ?? "GET");
		const exact =
			(method === undefined ? undefined : this.#routes.get(`${method}:exact:${pathname}`)) ??
			this.#routes.get(`*:exact:${pathname}`);
		const prefix = [...this.#routes.values()]
			.filter(
				(route) =>
					route.kind === "prefix" &&
					routeMatches(route, pathname) &&
					(route.method === undefined || route.method === method),
			)
			.sort((left, right) => {
				const methodPriority = Number(right.method !== undefined) - Number(left.method !== undefined);
				return right.path.length - left.path.length || methodPriority;
			})[0];
		const route = exact ?? prefix;
		if (route?.public !== true && !isAuthorized(request, this.#options.token)) {
			respondUnauthorized(response);
			return;
		}
		const handler = exact?.handler ?? prefix?.handler ?? this.#fallback;
		if (handler === undefined) {
			respondNotFound(response);
			return;
		}
		try {
			await handler(request, response);
		} catch {
			if (!response.headersSent) {
				response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				response.end("Internal server error");
			} else {
				response.destroy();
			}
		}
	}
}

export function createWebHost(options?: WebHostOptions): WebHost {
	return new WebHost(options);
}

export type { HttpTransportListenerOptions } from "./http-transport.ts";
export { createHttpTransportListener, HttpTransportListener } from "./http-transport.ts";
export { registerWebProfile } from "./profile.ts";
