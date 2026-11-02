import { test } from "node:test";
import assert from "node:assert/strict";
import { openUsageDb } from "../src/db.ts";
import { SlidingWindowRateLimiter } from "../src/rateLimiter.ts";
import { ModelRouter } from "../src/router.ts";
import { GatewayError } from "../src/errors.ts";
import { makeMockProvider } from "../src/providers.ts";

function freshLimiter(limitTokens = 50_000) {
  const db = openUsageDb(":memory:");
  return new SlidingWindowRateLimiter(db, { limitTokens, windowMs: 60_000 });
}

test("primary success: no failover", async () => {
  const router = new ModelRouter({
    primary: makeMockProvider("primary", { kind: "ok", text: "hi from primary" }),
    secondary: makeMockProvider("secondary", { kind: "ok" }),
    rateLimiter: freshLimiter(),
    timeoutMs: 200,
  });
  const r = await router.complete({ tenant: "t1", prompt: "hello" });
  assert.equal(r.servedBy, "primary");
  assert.equal(r.failedOver, false);
  assert.equal(r.response.text, "hi from primary");
});

test("primary 429 -> fails over to secondary", async () => {
  const router = new ModelRouter({
    primary: makeMockProvider("primary", { kind: "status", status: 429 }),
    secondary: makeMockProvider("secondary", { kind: "ok", text: "backup" }),
    rateLimiter: freshLimiter(),
    timeoutMs: 200,
  });
  const r = await router.complete({ tenant: "t1", prompt: "hello" });
  assert.equal(r.servedBy, "secondary");
  assert.equal(r.failedOver, true);
  assert.equal(r.response.text, "backup");
});

test("primary timeout -> fails over to secondary", async () => {
  const router = new ModelRouter({
    primary: makeMockProvider("primary", { kind: "hang" }),
    secondary: makeMockProvider("secondary", { kind: "ok", text: "backup" }),
    rateLimiter: freshLimiter(),
    timeoutMs: 100, // small for the test; production default is 3000ms
  });
  const start = Date.now();
  const r = await router.complete({ tenant: "t1", prompt: "hello" });
  const elapsed = Date.now() - start;
  assert.equal(r.servedBy, "secondary");
  assert.equal(r.failedOver, true);
  assert.ok(elapsed < 1000, `should have timed out quickly, took ${elapsed}ms`);
});

test("both providers fail -> standardized upstream_unavailable, no leak", async () => {
  const router = new ModelRouter({
    primary: makeMockProvider("primary", { kind: "status", status: 429 }),
    secondary: makeMockProvider("secondary", { kind: "status", status: 500 }),
    rateLimiter: freshLimiter(),
    timeoutMs: 200,
  });
  await assert.rejects(
    () => router.complete({ tenant: "t1", prompt: "hello" }),
    (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      const payload = err.toPayload();
      assert.equal(payload.error.type, "upstream_unavailable");
      assert.equal(payload.error.code, 503);
      // No internal details leak: payload has a fixed key set only.
      assert.deepEqual(Object.keys(payload.error).sort(), ["code", "message", "request_id", "type"]);
      assert.doesNotMatch(JSON.stringify(payload), /status|stack|UpstreamError|429|500/);
      return true;
    },
  );
});

test("non-failover error (503 on primary) does not call secondary", async () => {
  let secondaryCalled = false;
  const secondary = makeMockProvider("secondary", { kind: "ok" });
  const wrapped = {
    name: secondary.name,
    complete: (req: any, sig: any) => {
      secondaryCalled = true;
      return secondary.complete(req, sig);
    },
  };
  const router = new ModelRouter({
    primary: makeMockProvider("primary", { kind: "status", status: 503 }),
    secondary: wrapped,
    rateLimiter: freshLimiter(),
    timeoutMs: 200,
  });
  await assert.rejects(() => router.complete({ tenant: "t1", prompt: "hello" }), GatewayError);
  assert.equal(secondaryCalled, false, "secondary must not be called for non-429/timeout errors");
});

test("rate limited before any provider is called", async () => {
  let primaryCalled = false;
  const primary = makeMockProvider("primary", { kind: "ok" });
  const wrapped = {
    name: primary.name,
    complete: (req: any, sig: any) => {
      primaryCalled = true;
      return primary.complete(req, sig);
    },
  };
  const router = new ModelRouter({
    primary: wrapped,
    secondary: makeMockProvider("secondary", { kind: "ok" }),
    rateLimiter: freshLimiter(100), // tiny limit
    timeoutMs: 200,
  });
  // A prompt that estimates > 100 tokens (default maxTokens reservation is 256).
  await assert.rejects(
    () => router.complete({ tenant: "t1", prompt: "x".repeat(400) }),
    (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.toPayload().error.type, "rate_limited");
      assert.ok(err.toPayload().error.retry_after_ms !== undefined);
      return true;
    },
  );
  assert.equal(primaryCalled, false, "provider must not be called when rate limited");
});

test("bad request (missing prompt) is standardized", async () => {
  const router = new ModelRouter({
    primary: makeMockProvider("primary", { kind: "ok" }),
    secondary: makeMockProvider("secondary", { kind: "ok" }),
    rateLimiter: freshLimiter(),
    timeoutMs: 200,
  });
  await assert.rejects(
    () => router.complete({ tenant: "", prompt: "hi" }),
    (err: unknown) => err instanceof GatewayError && err.type === "bad_request",
  );
});
