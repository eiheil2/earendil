import { startForegroundServer } from "../../packages/coding-agent/src/experimental/server.ts";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

await promisify(execFile)(process.execPath, [fileURLToPath(new URL("bundle.mjs", import.meta.url))]);

const runtime = await startForegroundServer({
  web: { port: Number(process.env.PI_WEB_BACKEND_PORT ?? 0), token: process.env.PI_WEB_TOKEN || undefined },
  ...(process.env.PI_MODEL ? { model: process.env.PI_MODEL, provider: process.env.PI_PROVIDER } : {}),
});
process.env.PI_WEB_BACKEND = runtime.web.url;
process.env.PI_WEB_SERVER_ID = runtime.serverId;
process.env.PI_WEB_TOKEN = runtime.web.token;
const profile = spawn(process.execPath, [fileURLToPath(new URL("serve.mjs", import.meta.url))], { stdio: ["inherit", "inherit", "inherit", "ipc"], env: { ...process.env, PI_WEB_PORT: process.env.PI_WEB_PORT ?? "0" } });
profile.on("message", message => {
  if (message?.type !== "ready") return;
  const url = new URL(message.url);
  url.hash = new URLSearchParams({ serverId: runtime.serverId, token: runtime.web.token }).toString();
  process.send?.({ type: "ready", url: url.href });
  if (process.argv.includes("--no-open")) return;
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
  execFile(command, args, error => { if (error) console.error("Could not open the browser automatically. Restart without --no-open or use an attached launcher."); });
});
profile.once("error", error => { console.error(error); process.exitCode = 1; void runtime.close(); });
profile.once("exit", code => { if (code) process.exitCode = code; void runtime.close(); });
const close = () => { profile.kill(); void runtime.close(); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
await runtime.closed;
profile.kill();
