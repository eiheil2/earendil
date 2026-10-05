// Local stdio MCP fixture for test/mcp-dsh.test.ts, shaped like DSH
// tests/fixture-server.ts (packages/mcp/mcp-client): hand-rolled newline-delimited
// JSON-RPC over stdio, no SDK dependency, fully offline. `fail` is a tool that
// returns an error result; the process also fails to answer tools/list.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "greet",
    description: "Greet someone",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "fail",
    description: "Always fails",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notification (initialized, etc.)
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dsh-fixture", version: "0.0.0" },
      });
      break;
    case "tools/list":
      reply(id, { tools });
      break;
    case "tools/call": {
      const args = params?.arguments ?? {};
      if (params?.name === "add") {
        reply(id, {
          content: [{ type: "text", text: String(args.a + args.b) }],
          isError: false,
        });
      } else if (params?.name === "greet") {
        reply(id, {
          content: [{ type: "text", text: `Hello, ${args.name}!` }],
          isError: false,
        });
      } else if (params?.name === "fail") {
        replyError(id, -32000, "fixture tool always fails");
      } else {
        replyError(id, -32601, `unknown tool: ${params?.name}`);
      }
      break;
    }
    default:
      replyError(id, -32601, `method not found: ${method}`);
  }
});
