/**
 * Compatibility fixture: registers one MCP server.
 *
 * `registerMcpServer` carries seven JSDoc contracts on the host, and several of them are behavioural
 * promises rather than type shapes: registering a name again replaces this extension's earlier
 * registration, the registration is not persisted, a name in `mcp.json` wins, and an invalid config
 * throws. TypeScript cannot pin any of those. What this fixture pins is the signature and the config
 * shape - in particular that the `exposure` union keeps its four members, since dropping one would
 * silently change how a server's tools reach the model.
 *
 * The server is registered, not connected: the compatibility suite loads plugins without an MCP client,
 * so the recorded surface is the registration itself.
 */
import type { ExtensionApi, ExtensionMcpServerConfig } from "@earendil-works/pi-plugin-sdk";

export const SERVER_NAME = "fixture-mcp";

export const SERVER_CONFIG: ExtensionMcpServerConfig = {
	type: "http",
	url: "https://mcp.example.com/fixture",
	description: "Compatibility fixture. Never contacted by the suite.",
	exposure: "direct",
	headers: { "x-fixture": "compatibility" },
};

export default function activate(pi: ExtensionApi): void {
	pi.registerMcpServer(SERVER_NAME, SERVER_CONFIG);
}
