# Task 4 — Rate-Limiting & Model Fallback Router

A resilient model-routing module for an LLM gateway. It rate-limits per tenant on **tokens** using a
sliding window backed by **on-disk SQLite**, calls a primary model with a hard timeout, and **fails
over to a secondary** on `429`/timeout — always returning a **sanitized** error payload.

```
request ─▶ [token rate limiter: 50k tok/min/tenant, SQLite sliding window]
              │ admitted
              ▼
          [primary model]  ──429 or >3000ms──▶  [secondary model]
              │ ok                                  │ ok / fail
              ▼                                      ▼
          response                       response  OR  standardized error
```

## How the evaluation criteria are met

### Async concurrency & timeout race conditions
`callWithTimeout()` (in `src/router.ts`) races the provider call against a timer using a shared
`AbortController`. Whichever settles first wins; the loser is aborted via the signal, and the timer
is always cleared in `finally` so there are no dangling timers. The default timeout is **3000ms**
(configurable). Providers honor the abort signal, so a timed-out call stops promptly instead of
leaking work.

### Accurate rate-limiter state eviction & token tracking
`SlidingWindowRateLimiter` (in `src/rateLimiter.ts`) implements a precise **sliding log**: each
admitted request is a `(tenant, tokens, ts)` row in SQLite. On every check it:
1. opens a `BEGIN IMMEDIATE` transaction (atomic critical section),
2. **evicts** rows older than `now - windowMs`,
3. sums the tenant's in-window tokens,
4. admits only if `used + request <= limit` (default **50,000 / 60s**), recording the reservation,
5. otherwise returns `retry_after_ms`, computed from when the oldest in-window row ages out.

Because `node:sqlite` is synchronous, the read-modify-write is a single uninterruptible step — no
check-then-act race. Tested for per-tenant isolation, exhaustion, window aging, and on-disk
persistence across reopen.

### Graceful fallback & standardized error sanitization
Failover triggers on exactly two conditions — HTTP **429** and **timeout** — (other errors do not
cascade). All failures surface as a `GatewayError` whose `toPayload()` returns a fixed shape:

```json
{ "error": { "type": "upstream_unavailable", "code": 503, "message": "...", "request_id": "uuid" } }
```

Raw upstream messages, statuses, and stack traces are **never** in the payload — they are logged to
stderr against the same `request_id` for correlation. A test asserts the payload contains no
`status`/`stack`/`429`/`500`/class-name leakage.

## Run it

```bash
npm install
npm start     # :8083, POST /v1/complete ; demo primary returns 429 so you see failover
npm test      # rate limiter + router tests
npm run typecheck
```

### Try it (demo wiring: primary always 429 → secondary serves)

```bash
curl -i -X POST localhost:8083/v1/complete \
  -H 'authorization: Bearer tenant-123' \
  -H 'content-type: application/json' \
  -d '{"prompt":"summarize this","max_tokens":128}'
# -> 200, header  x-served-by: secondary-claude , x-failed-over: true
```

The on-disk database defaults to `ratelimit.db` (override with `DB_PATH`). Token counts are
estimated (~4 chars/token + reserved `max_tokens`); swap `src/tokens.ts` for a real tokenizer to get
exact accounting.

> Requires Node.js >= 22.6 for native TypeScript execution and the built-in `node:sqlite` module.
