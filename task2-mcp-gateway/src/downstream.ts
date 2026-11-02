/**
 * Mock downstream MCP server (HTTP + JSON-RPC).
 *
 * This stands in for a "real" MCP server behind the gateway. It is deliberately
 * dumb: it trusts whatever reaches it. All authorization is the gateway's job —
 * that separation is the whole point of Task 2.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  ErrorCodes,
  errorResponse,
  isJsonRpcRequest,
  resultResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.ts";

const TOOLS = [
  { name: "get_customer_record", description: "Fetch a customer record." },
  { name: "echo", description: "Echo the provided arguments back." },
  { name: "admin_reset_key", description: "Rotate the service API key (admin only)." },
];

function handleRpc(req: JsonRpcRequest): JsonRpcResponse {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return resultResponse(id, {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock-downstream", version: "1.0.0" },
        capabilities: { tools: {} },
      });
    case "tools/list":
      return resultResponse(id, { tools: TOOLS });
    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
      const name = params.name;
      switch (name) {
        case "get_customer_record":
          return resultResponse(id, { content: [{ type: "text", text: JSON.stringify({ customer_id: "CUST-10293", name: "Ada Lovelace" }) }] });
        case "echo":
          return resultResponse(id, { content: [{ type: "text", text: JSON.stringify(params.arguments ?? {}) }] });
        case "admin_reset_key":
          return resultResponse(id, { content: [{ type: "text", text: "service API key rotated" }] });
        default:
          return errorResponse(id, ErrorCodes.MethodNotFound, `Unknown tool: ${String(name)}`);
      }
    }
    default:
      return errorResponse(id, ErrorCodes.MethodNotFound, `Unknown method: ${req.method}`);
  }
}

export function createDownstreamServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(errorResponse(null, ErrorCodes.ParseError, "Parse error")));
        return;
      }
      const respond = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (Array.isArray(parsed)) {
        respond(parsed.map((item) => (isJsonRpcRequest(item) ? handleRpc(item) : errorResponse(null, ErrorCodes.InvalidRequest, "Invalid Request"))));
      } else if (isJsonRpcRequest(parsed)) {
        respond(handleRpc(parsed));
      } else {
        respond(errorResponse(null, ErrorCodes.InvalidRequest, "Invalid Request"));
      }
    });
  });
}

// Allow running standalone: `node src/downstream.ts`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.DOWNSTREAM_PORT ?? 8081);
  createDownstreamServer().listen(port, () => {
    process.stderr.write(`[downstream] listening on http://127.0.0.1:${port}\n`);
  });
}
