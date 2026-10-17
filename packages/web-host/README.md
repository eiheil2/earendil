# @earendil-works/pi-web-host

Small HTTP host for Pi browser profiles. It owns named HTTP routes, a single SPA fallback, process-local bearer authentication, and lifecycle management. It does not know Pi Session or provider payloads.

The host binds to `127.0.0.1` by default. A non-loopback bind requires an explicit `host` value and does not add TLS, Origin checks, or remote authentication; deploy it only behind a profile that supplies those controls.

```ts
import { createWebHost } from "@earendil-works/pi-web-host";

const host = createWebHost({ token: "process-token" });
host.register({
	kind: "exact",
	path: "/health",
	handler: async (_request, response) => {
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		response.end("ok");
	},
});
await host.start();
console.log(host.url);
```

The `token` is a process-local browser-host credential. It is separate from provider API keys and must not be persisted in repository configuration.

`registerWebProfile(host, directory)` mounts a locally built profile's HTML, JavaScript, CSS, and DeepSeek license at exact public GET routes. Other routes and the SPA fallback require bearer authentication by default. Route registrations may explicitly mark trusted static assets with `public: true`; never use that option for transport or API handlers. Prefix routing selects the longest path, then a method-specific registration when lengths match.

`createHttpTransportListener(host)` adds two authenticated routes: `GET /__pi/transport/events` opens an SSE byte stream and `POST /__pi/transport/input?connection=<id>` sends framed bytes to that stream. The listener implements `ServerListener`; the Pi Server remains responsible for handshake, framing, and service routing.
