import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { createWebHost, registerWebProfile } from "../../packages/web-host/src/index.ts";

const backend = new URL(process.env.PI_WEB_BACKEND ?? "http://127.0.0.1:3080");
if (backend.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname)) {
  throw new Error("PI_WEB_BACKEND must be a loopback HTTP URL");
}
if (!process.env.PI_WEB_TOKEN || !process.env.PI_WEB_SERVER_ID) throw new Error("Set PI_WEB_TOKEN and PI_WEB_SERVER_ID from the running Pi web server");
const host = createWebHost({ token: process.env.PI_WEB_TOKEN, port: Number(process.env.PI_WEB_PORT ?? 3081) });
await registerWebProfile(host, fileURLToPath(new URL("dist/", import.meta.url)));
for (const [method, path] of [["GET", "/__pi/transport/events"], ["POST", "/__pi/transport/input"]]) {
  host.register({ kind: "exact", method, path, handler: (incoming, outgoing) => new Promise(resolve => {
    const upstream = request(new URL(incoming.url, backend), { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/octet-stream", accept: "text/event-stream" } }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      outgoing.flushHeaders();
      response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => { upstream.destroy(); resolve(); });
    incoming.pipe(upstream);
  }) });
}
await host.start();
// The fragment stays in the browser and is removed by the profile after reading it.
console.log(`Earendil is ready at ${host.url}/. The launcher opens an authenticated browser session.`);
process.send?.({ type: "ready", url: host.url });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void host.close(); });
