/**
 * Explicit STDIO-isolation test.
 *
 * Spawns the server directly (no SDK), drives a minimal JSON-RPC handshake over
 * stdin, and asserts that EVERY line written to stdout is parseable JSON-RPC.
 * A single stray console.log would produce a non-JSON line and fail this test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { once } from "node:events";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "src", "server.ts");

test("stdout contains only valid JSON-RPC lines", async () => {
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => (stdout += d));

  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");

  // Minimal MCP handshake + a tool list request.
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "purity-check", version: "1.0.0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  // Give the server a moment to respond, then close.
  await new Promise((r) => setTimeout(r, 750));
  child.stdin.end();
  await once(child, "exit").catch(() => {});
  child.kill();

  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length >= 2, `expected at least 2 JSON-RPC responses, got ${lines.length}`);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `non-JSON line on stdout: ${JSON.stringify(line)}`);
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(parsed.jsonrpc, "2.0", `stdout line is not JSON-RPC 2.0: ${line}`);
  }
});
