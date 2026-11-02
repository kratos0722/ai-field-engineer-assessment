/**
 * End-to-end test: the HTTP SSE gateway redacts the provider stream and streams
 * tokens incrementally (it does not buffer the whole response first).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createLlmGateway } from "../src/gateway.ts";
import { mockLlmProvider } from "../src/provider.ts";

const PII_LEAK = /(@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})|(\d{3}[- ]\d{2}[- ]\d{4})|(\d(?:[ -]?\d){12,18})/;

test("gateway streams redacted SSE and never leaks PII", async () => {
  const server = createLlmGateway({ provider: mockLlmProvider });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;

  try {
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/v1/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const deltas: string[] = [];
    let firstDeltaAt = 0;
    let sawDone = false;

    let bufferedText = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bufferedText += decoder.decode(value, { stream: true });
      const frames = bufferedText.split("\n\n");
      bufferedText = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.replace(/^data: /, "").trim();
        if (!line) continue;
        if (line === "[DONE]") { sawDone = true; continue; }
        const obj = JSON.parse(line) as { delta?: string; error?: string };
        if (obj.delta) {
          if (!firstDeltaAt) firstDeltaAt = Date.now() - start;
          deltas.push(obj.delta);
        }
      }
    }

    const full = deltas.join("");
    assert.ok(sawDone, "stream should terminate with [DONE]");
    assert.doesNotMatch(full, PII_LEAK, `leaked PII: ${full}`);
    assert.match(full, /Thanks for reaching out/);
    assert.match(full, /\[REDACTED\]/);

    // Streaming proof: more than one delta arrived, and the first one arrived
    // well before the whole (≈20 chunks * 15ms ≈ 300ms) stream finished.
    assert.ok(deltas.length > 1, "expected multiple incremental deltas");
    assert.ok(firstDeltaAt < 250, `TTFT too high: ${firstDeltaAt}ms`);
  } finally {
    server.close();
  }
});
