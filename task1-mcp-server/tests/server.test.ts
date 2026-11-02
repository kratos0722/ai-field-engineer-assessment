/**
 * Integration tests for the Task 1 MCP server.
 *
 * These spawn the real server as a subprocess over stdio (exactly how an MCP
 * client would) and assert on:
 *   - valid tool calls returning structured results,
 *   - invalid input being rejected with the standard -32602 (Invalid params),
 *   - application errors surfaced as MCP tool errors (isError),
 *   - stdout containing ONLY valid JSON-RPC (no stray logging).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "src", "server.ts");

/** Extract the first text block from a tool result. */
function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text: string }> }).content ?? [];
  const block = content[0];
  assert.ok(block, "tool result had no content block");
  return block.text;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [serverPath],
    stderr: "pipe", // keep the server's stderr off our test output
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("lists both tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_customer_record", "trigger_refund"]);
  });
});

test("get_customer_record returns a known record", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: "get_customer_record",
      arguments: { customer_id: "CUST-10293" },
    });
    assert.equal(res.isError, undefined);
    assert.match(firstText(res), /Ada Lovelace/);
  });
});

test("get_customer_record on unknown id is a tool error, not a protocol error", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: "get_customer_record",
      arguments: { customer_id: "CUST-00000" },
    });
    assert.equal(res.isError, true);
  });
});

test("unknown tool name is rejected with -32601 (Method not found)", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.callTool({ name: "no_such_tool", arguments: {} }),
      (err: unknown) => (err as { code?: number }).code === -32601,
    );
  });
});

test("unknown extra keys are rejected (strict schema) with -32602", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "get_customer_record",
          arguments: { customer_id: "CUST-10293", injected: "nope" },
        }),
      (err: unknown) => (err as { code?: number }).code === -32602,
    );
  });
});

test("trigger_refund succeeds with valid input", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: "trigger_refund",
      arguments: { customer_id: "CUST-10293", amount: 12.5, reason: "duplicate charge on invoice" },
    });
    assert.equal(res.isError, undefined);
    assert.match(firstText(res), /"status": "accepted"/);
  });
});

test("invalid customer_id format is rejected with -32602", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.callTool({ name: "get_customer_record", arguments: { customer_id: "BADID" } }),
      (err: unknown) => {
        // The SDK surfaces JSON-RPC errors as McpError with a numeric `code`.
        const code = (err as { code?: number }).code;
        assert.equal(code, -32602, `expected -32602, got ${code}`);
        return true;
      },
    );
  });
});

test("refund with too-short reason is rejected with -32602", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "trigger_refund",
          arguments: { customer_id: "CUST-10293", amount: 5, reason: "short" },
        }),
      (err: unknown) => (err as { code?: number }).code === -32602,
    );
  });
});

test("refund with negative amount is rejected with -32602", async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "trigger_refund",
          arguments: { customer_id: "CUST-10293", amount: -1, reason: "trying to refund a negative" },
        }),
      (err: unknown) => (err as { code?: number }).code === -32602,
    );
  });
});
