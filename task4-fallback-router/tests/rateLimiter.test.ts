import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageDb } from "../src/db.ts";
import { SlidingWindowRateLimiter } from "../src/rateLimiter.ts";

test("admits requests up to the token limit, then rejects", () => {
  const db = openUsageDb(":memory:");
  const limiter = new SlidingWindowRateLimiter(db, { limitTokens: 50_000, windowMs: 60_000, now: () => 1_000_000 });

  assert.equal(limiter.tryConsume("key-a", 20_000).allowed, true);
  assert.equal(limiter.tryConsume("key-a", 20_000).allowed, true);
  const third = limiter.tryConsume("key-a", 20_000); // would be 60k > 50k
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 10_000);
  assert.ok(third.retryAfterMs && third.retryAfterMs > 0);
  db.close();
});

test("limits are per-tenant", () => {
  const db = openUsageDb(":memory:");
  const limiter = new SlidingWindowRateLimiter(db, { limitTokens: 10_000, windowMs: 60_000, now: () => 5_000 });
  assert.equal(limiter.tryConsume("key-a", 10_000).allowed, true);
  assert.equal(limiter.tryConsume("key-a", 1).allowed, false);
  assert.equal(limiter.tryConsume("key-b", 10_000).allowed, true); // separate budget
  db.close();
});

test("sliding window: old usage ages out and frees capacity", () => {
  const db = openUsageDb(":memory:");
  let clock = 1_000_000;
  const limiter = new SlidingWindowRateLimiter(db, { limitTokens: 50_000, windowMs: 60_000, now: () => clock });

  assert.equal(limiter.tryConsume("key-a", 50_000).allowed, true);
  assert.equal(limiter.tryConsume("key-a", 1).allowed, false); // full

  clock += 60_001; // advance past the window
  assert.equal(limiter.tryConsume("key-a", 50_000).allowed, true); // old row evicted
  db.close();
});

test("persists to an on-disk database file", () => {
  const path = join(tmpdir(), `ratelimit-test-${Date.now()}.db`);
  const db1 = openUsageDb(path);
  const l1 = new SlidingWindowRateLimiter(db1, { limitTokens: 10_000, windowMs: 60_000, now: () => 2_000 });
  assert.equal(l1.tryConsume("key-a", 8_000).allowed, true);
  db1.close();

  // Reopen the same file: usage survived.
  const db2 = openUsageDb(path);
  const l2 = new SlidingWindowRateLimiter(db2, { limitTokens: 10_000, windowMs: 60_000, now: () => 2_000 });
  assert.equal(l2.tryConsume("key-a", 5_000).allowed, false); // 8k + 5k > 10k
  db2.close();
});
