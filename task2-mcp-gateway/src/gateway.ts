/**
 * Task 2 — MCP Security Gateway Proxy.
 *
 * A lightweight HTTP/JSON-RPC reverse proxy that sits between an AI agent client
 * and a downstream MCP server and enforces method-level authorization:
 *
 *   - `tools/list`  -> forwarded transparently to the downstream server.
 *   - `tools/call`  -> params.name is inspected. Tools whose name starts with
 *                      `admin_` require the caller's token role to be `admin`.
 *                      Otherwise the request is intercepted and answered locally
 *                      with JSON-RPC error -32001 (Unauthorized Tool Call) and
 *                      the downstream server is never contacted.
 *   - everything else (initialize, ping, ...) -> forwarded transparently.
 *
 * Zero-trust posture: every request must carry a valid bearer token. An absent
 * or unknown token is rejected with -32001 before anything is forwarded.
 *
 * Batch requests (JSON-RPC arrays) are handled per-item: blocked items are
 * answered locally while the remaining items are forwarded in a single batch,
 * then the responses are merged back in order.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import { parseBearer, resolveRole, type Principal } from "./auth.ts";
import {
  ErrorCodes,
  errorResponse,
  isJsonRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.ts";

const ADMIN_PREFIX = "admin_";

export type GatewayOptions = {
  downstreamUrl: string;
};

const log = (...args: unknown[]): void => {
  process.stderr.write(`[gateway] ${args.map(String).join(" ")}\n`);
};

/**
 * Decide whether a single JSON-RPC request is allowed for the given principal.
 * Returns null when allowed, or a JSON-RPC error response when blocked.
 */
function authorize(req: JsonRpcRequest, principal: Principal): JsonRpcResponse | null {
  const id = req.id ?? null;

  // tools/list and non-tool methods are forwarded transparently.
  if (req.method !== "tools/call") {
    return null;
  }

  const params = (req.params ?? {}) as { name?: unknown };
  const name = params.name;

  if (typeof name !== "string" || name.length === 0) {
    return errorResponse(id, ErrorCodes.InvalidParams, "tools/call requires a string params.name");
  }

  // Fine-grained, method-level authorization: admin_* tools require admin role.
  if (name.startsWith(ADMIN_PREFIX) && principal.role !== "admin") {
    log(`DENY ${principal.subject} (role=${principal.role}) -> ${name}`);
    return errorResponse(id, ErrorCodes.Unauthorized, "Unauthorized Tool Call", {
      tool: name,
      requiredRole: "admin",
      actualRole: principal.role,
    });
  }

  return null;
}

/** Forward a parsed JSON-RPC payload (single or batch) to the downstream server. */
async function forward(payload: unknown, downstreamUrl: string): Promise<unknown> {
  const res = await fetch(downstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // We only ever send JSON-RPC downstream, so expect JSON back.
  return res.json();
}

async function handlePayload(parsed: unknown, principal: Principal, downstreamUrl: string): Promise<unknown> {
  // ----- Batch -----
  if (Array.isArray(parsed)) {
    const slots: Array<{ index: number; local?: JsonRpcResponse; forwardItem?: JsonRpcRequest }> = [];
    const toForward: JsonRpcRequest[] = [];

    parsed.forEach((item, index) => {
      if (!isJsonRpcRequest(item)) {
        slots.push({ index, local: errorResponse(null, ErrorCodes.InvalidRequest, "Invalid Request") });
        return;
      }
      const blocked = authorize(item, principal);
      if (blocked) {
        slots.push({ index, local: blocked });
      } else {
        slots.push({ index, forwardItem: item });
        toForward.push(item);
      }
    });

    let forwarded: JsonRpcResponse[] = [];
    if (toForward.length > 0) {
      const downstream = await forward(toForward, downstreamUrl);
      forwarded = Array.isArray(downstream) ? (downstream as JsonRpcResponse[]) : [];
    }

    // Re-assemble responses in original order, matching forwarded results by id.
    const result: JsonRpcResponse[] = [];
    for (const slot of slots) {
      if (slot.local) {
        result.push(slot.local);
      } else if (slot.forwardItem) {
        const match = forwarded.find((r) => r.id === (slot.forwardItem!.id ?? null));
        if (match) result.push(match);
      }
    }
    return result;
  }

  // ----- Single -----
  if (!isJsonRpcRequest(parsed)) {
    return errorResponse(null, ErrorCodes.InvalidRequest, "Invalid Request");
  }
  const blocked = authorize(parsed, principal);
  if (blocked) return blocked;
  return forward(parsed, downstreamUrl);
}

export function createGateway(opts: GatewayOptions): http.Server {
  return http.createServer((req, res) => {
    const sendJson = (status: number, payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };

    if (req.method !== "POST") {
      sendJson(405, errorResponse(null, ErrorCodes.InvalidRequest, "Only POST is supported"));
      return;
    }

    // ----- Authenticate (zero-trust: valid token required up front) -----
    const principal = resolveRole(parseBearer(req.headers["authorization"]));
    if (!principal) {
      sendJson(401, errorResponse(null, ErrorCodes.Unauthorized, "Unauthorized Tool Call", {
        reason: "missing or invalid bearer token",
      }));
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(200, errorResponse(null, ErrorCodes.ParseError, "Parse error"));
        return;
      }

      handlePayload(parsed, principal, opts.downstreamUrl)
        .then((payload) => sendJson(200, payload))
        .catch((err) => {
          // Never leak internal details to the client.
          log(`internal error: ${err instanceof Error ? err.stack : String(err)}`);
          sendJson(502, errorResponse(null, ErrorCodes.InternalError, "Upstream request failed"));
        });
    });
  });
}

// Allow running standalone: `node src/gateway.ts`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.GATEWAY_PORT ?? 8080);
  const downstreamUrl = process.env.DOWNSTREAM_URL ?? "http://127.0.0.1:8081/mcp";
  createGateway({ downstreamUrl }).listen(port, () => {
    log(`listening on http://127.0.0.1:${port} -> downstream ${downstreamUrl}`);
  });
}
