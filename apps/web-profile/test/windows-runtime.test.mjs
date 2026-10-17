import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServer } from "../../../packages/coding-agent/src/experimental/server.ts";
import { Client, createClientServiceTransport, createHttpTransportFactory } from "../../../packages/client/src/index.ts";
import { createRemoteServiceBinding } from "../../../packages/chord/src/index.ts";
import { BACKGROUND_CONTEXT } from "../../../packages/chord/src/context/index.ts";
import { SessionManagement } from "../../../packages/coding-agent/src/experimental/services/sessions.ts";
import { Transcript } from "../../../packages/coding-agent/src/experimental/services/transcript.ts";
import { createUnixTransportFactory } from "../../../packages/client/src/unix.ts";

test("Windows coordinator starts a real Session worker over HTTP and releases its pipe", { skip: process.platform !== "win32", timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-windows-runtime-"));
  let runtime, client, binding, session;
  try {
    runtime = await startServer({ directory, sessionDir: join(directory, "sessions"), pluginPackages: [], web: { port: 0 } });
    assert.ok(runtime.socketPath.startsWith("\\\\.\\pipe\\"));
    const local = await Client.connect({ serverId: runtime.serverId, transportFactory: createUnixTransportFactory({ path: runtime.socketPath }) });
    await local.dispose();
    client = await Client.connect({ serverId: runtime.serverId, transportFactory: createHttpTransportFactory({ baseUrl: runtime.web.url, token: runtime.web.token }) });
    binding = createRemoteServiceBinding({ services: [SessionManagement], transport: createClientServiceTransport(client, () => ({ serverId: runtime.serverId })) });
    await binding.ready(BACKGROUND_CONTEXT);
    const management = binding.use(SessionManagement);
    const created = await management.create({}, BACKGROUND_CONTEXT);
    await management.attach(created.sessionId, BACKGROUND_CONTEXT);
    session = createRemoteServiceBinding({ services: [Transcript], transport: createClientServiceTransport(client, () => client.attachment) });
    await session.ready(BACKGROUND_CONTEXT);
    assert.ok(runtime.workerPids.get(created.sessionId) > 0);
    await session.dispose(BACKGROUND_CONTEXT);
    session = undefined;
    await binding.dispose(BACKGROUND_CONTEXT);
    binding = undefined;
    await client.dispose();
    client = undefined;
    const serverId = runtime.serverId;
    await runtime.close();
    runtime = await startServer({ directory, serverId, sessionDir: join(directory, "sessions"), pluginPackages: [], web: { port: 0 } });
    assert.equal(runtime.serverId, serverId);
  } finally {
    try { await session?.dispose(BACKGROUND_CONTEXT); await binding?.dispose(BACKGROUND_CONTEXT); await client?.dispose(); }
    finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
