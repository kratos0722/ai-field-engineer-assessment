# Task 3 — LLM Gateway Streaming Guardrail (PII redaction)

An LLM gateway endpoint (`POST /v1/stream`) that routes a text-generation request to an LLM
provider and **streams the response back while redacting PII in real time** — emails, US SSNs, and
credit-card numbers become `[REDACTED]`. Pure Node.js, no runtime dependencies.

```
client ──POST /v1/stream──▶ GATEWAY ──▶ LLM provider (streaming)
                               │
                        StreamRedactor (bounded buffer)
                               │
client ◀── SSE: {"delta": "...clean..."} ◀┘
```

## The core problem: redacting a *stream*

A sensitive value can be split across chunk boundaries — the model emits `jane.d` then
`oe@example.com`. A naive per-chunk regex misses it. `src/redactor.ts` solves this with a bounded
look-behind buffer:

1. Append the incoming chunk to a small `buffer`.
2. Compute a **safe cut point**: the start of any trailing run of characters that could still be
   growing into a PII match (word chars, plus spaces/hyphens that sit between digits so
   `4111 1111 ...` is held together).
3. Redact and emit everything *before* the cut; keep the short tail.
4. The tail is capped at `maxHold` (default **256** ≥ the longest possible match, an RFC-max email),
   so memory and added latency are **bounded regardless of response length**.
5. `flush()` redacts whatever remains at end-of-stream.

This keeps **TTFT low** (only the final partial token is ever held back) and guarantees no
un-redacted PII is emitted, even if the stream arrives one character at a time.

## How the evaluation criteria are met

- **Async stream chunking + buffer state** — `StreamRedactor` owns a single growing-then-shrinking
  buffer; `redactStream()` adapts any `AsyncIterable<string>` into a redacted one.
- **Performant matching over partial text** — a single backward scan per chunk finds the safe cut in
  O(tail) time; regexes run only over settled text, never re-scanning the whole response.
- **Memory efficiency + low latency** — nothing is accumulated: buffered bytes never exceed
  `maxHold` (unit-tested against a 100 000-char input), and the gateway respects back-pressure by
  awaiting `drain` before continuing.

The provider is abstracted (`src/provider.ts`). The included `mockLlmProvider` streams a canned
response whose PII is deliberately split across chunks (no API key needed). A real provider adapter
would parse upstream SSE `data:` frames and feed their text deltas into the exact same redactor.

## Run it

```bash
npm install
npm start          # listens on :8082, POST /v1/stream
npm test           # unit + e2e streaming tests
npm run typecheck
```

### Try it

```bash
curl -N -X POST localhost:8082/v1/stream \
  -H 'content-type: application/json' \
  -d '{"prompt":"give me the contact details"}'
```

You'll see SSE frames like `data: {"delta":"...support [REDACTED] ..."}` arrive incrementally,
ending with `data: [DONE]`. The canned response contains an email, an SSN, and a credit-card number
(each split across network chunks) — all are redacted.

> Requires Node.js >= 22.6 (TypeScript executed natively; no build step).
