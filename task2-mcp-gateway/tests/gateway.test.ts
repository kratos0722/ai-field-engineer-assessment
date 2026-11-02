/**
 * End-to-end tests: real gateway proxying to a real (mock) downstream server.
 * Both run on ephemeral ports.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createGateway } from "../src/gateway.ts";
import { createDownstreamServer } from "../src/downstream.ts";

let downstream: ReturnType<typeof createDownstreamServer>;
let gateway: ReturnType<typeof createGateway>;
let gatewayUrl = "";

function listen(server: { listen: (port: number, cb: () => void) => void; address: () => AddressInfo | string | null }): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

before(async () => {
  downstream = createDownstreamServer();
  const dPort = await listen(downstream);
  gateway = createGateway({ downstreamUrl: `http://127.0.0.1:${dPort}/mcp` });
  const gPort = await listen(gateway);
  gatewayUrl = `http://127.0.0.1:${gPort}/mcp`;
});

after(() => {
  gateway.close();
  downstream.close();
});

async function call(token: string | null, payload: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(gatewayUrl, { method: "POST", headers, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}

const rpc = (method: string, params?: unknown, id: number = 1) => ({ jsonrpc: "2.0", id, method, params });

test("missing token is rejected with -32001 and never forwarded", async () => {
  const { status, body } = await call(null, rpc("tools/list"));
  assert.equal(status, 401);
  assert.equal(body.error.code, -32001);
});

test("unknown token is rejected with -32001", async () => {
  const { body } = await call("bogus-token", rpc("tools/list"));
  assert.equal(body.error.code, -32001);
});

test("tools/list is forwarded transparently for any valid role", async () => {
  for (const token of ["admin-token", "viewer-token"]) {
    const { body } = await call(token, rpc("tools/list"));
    assert.ok(Array.isArray(body.result.tools), `tools/list failed for ${token}`);
    const names = body.result.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("admin_reset_key"));
  }
});

test("viewer calling a normal tool is allowed", async () => {
  const { body } = await call("viewer-token", rpc("tools/call", { name: "get_customer_record", arguments: {} }));
  assert.ok(body.result, `expected a result, got ${JSON.stringify(body)}`);
  assert.match(body.result.content[0].text, /Ada Lovelace/);
});

test("viewer calling an admin_ tool is blocked with -32001 (not forwarded)", async () => {
  const { body } = await call("viewer-token", rpc("tools/call", { name: "admin_reset_key", arguments: {} }));
  assert.equal(body.error.code, -32001);
  assert.equal(body.error.message, "Unauthorized Tool Call");
  assert.equal(body.error.data.requiredRole, "admin");
});

test("admin calling an admin_ tool is allowed and forwarded", async () => {
  const { body } = await call("admin-token", rpc("tools/call", { name: "admin_reset_key", arguments: {} }));
  assert.ok(body.result, `expected a result, got ${JSON.stringify(body)}`);
  assert.match(body.result.content[0].text, /rotated/);
});

test("tools/call with non-string name is rejected with -32602", async () => {
  const { body } = await call("admin-token", rpc("tools/call", { arguments: {} }));
  assert.equal(body.error.code, -32602);
});

test("batch requests are authorized per-item", async () => {
  const batch = [
    rpc("tools/call", { name: "get_customer_record", arguments: {} }, 1),
    rpc("tools/call", { name: "admin_reset_key", arguments: {} }, 2),
    rpc("tools/list", undefined, 3),
  ];
  const { body } = await call("viewer-token", batch);
  assert.ok(Array.isArray(body));
  const byId = new Map(body.map((r: any) => [r.id, r]));
  assert.ok(byId.get(1).result, "normal tool should succeed");
  assert.equal(byId.get(2).error.code, -32001, "admin tool should be blocked for viewer");
  assert.ok(byId.get(3).result.tools, "tools/list should pass");
});

test("JSON parse errors return -32700", async () => {
  const res = await fetch(gatewayUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
    body: "{ not json",
  });
  const body = (await res.json()) as any;
  assert.equal(body.error.code, -32700);
});
