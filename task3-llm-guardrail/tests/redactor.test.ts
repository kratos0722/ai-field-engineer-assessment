/**
 * Unit tests for the streaming redactor — the heart of Task 3.
 * These focus on cross-chunk boundaries, memory bounds, and low latency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamRedactor, redact, redactStream, REDACTION } from "../src/redactor.ts";

const PII_LEAK = /(@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})|(\d{3}[- ]\d{2}[- ]\d{4})|(\d(?:[ -]?\d){12,18})/;

test("redact() handles whole strings", () => {
  const out = redact("mail me at a.b@x.com, ssn 123-45-6789, card 4111 1111 1111 1111.");
  assert.equal(out, `mail me at ${REDACTION}, ssn ${REDACTION}, card ${REDACTION}.`);
});

test("email split across chunks is still redacted", async () => {
  const chunks = ["contact ", "jane.d", "oe@exa", "mple.org", " now"];
  const out = (await collect(redactStream(arr(chunks)))).join("");
  assert.doesNotMatch(out, PII_LEAK, `leaked: ${out}`);
  assert.match(out, new RegExp(REDACTION.replace(/[[\]]/g, "\\$&")));
  assert.match(out, /^contact /);
  assert.match(out, / now$/);
});

test("credit card split across chunks (with spaces) is redacted", async () => {
  const chunks = ["card 4111 ", "1111 1111 ", "1111 end"];
  const out = (await collect(redactStream(arr(chunks)))).join("");
  assert.doesNotMatch(out, PII_LEAK, `leaked: ${out}`);
  assert.match(out, /^card /);
  assert.match(out, / end$/);
});

test("SSN split across chunks is redacted", async () => {
  const chunks = ["ssn ", "123", "-45", "-6789", "!"];
  const out = (await collect(redactStream(arr(chunks)))).join("");
  assert.doesNotMatch(out, PII_LEAK, `leaked: ${out}`);
});

test("worst case: one character per chunk never leaks", async () => {
  const text = "reach me: alice@example.com / 078-05-1120 / 5500 0000 0000 0004 ok";
  const chunks = [...text];
  const out = (await collect(redactStream(arr(chunks)))).join("");
  assert.doesNotMatch(out, PII_LEAK, `leaked: ${out}`);
  assert.match(out, /^reach me: /);
  assert.match(out, / ok$/);
});

test("clean prose is emitted promptly (low TTFT, holds back only the last token)", () => {
  const r = new StreamRedactor();
  const emitted = r.push("Hello world this is a clean sentence with no secrets yet ");
  // Everything up to the final token should be emitted immediately.
  assert.match(emitted, /^Hello world this is a clean sentence with no secrets yet/);
});

test("memory stays bounded regardless of input length", () => {
  const r = new StreamRedactor(64);
  // Feed a huge run of digits (looks like an in-progress number).
  r.push("1".repeat(100_000));
  assert.ok(r.buffered <= 64, `buffered ${r.buffered} exceeded cap`);
});

test("redactStream passes through content unchanged when there is no PII", async () => {
  const chunks = ["The quick ", "brown fox ", "jumps."];
  const out = (await collect(redactStream(arr(chunks)))).join("");
  assert.equal(out, "The quick brown fox jumps.");
});

// --- helpers ---
async function* arr(items: string[]): AsyncGenerator<string> {
  for (const i of items) yield i;
}
async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
}
