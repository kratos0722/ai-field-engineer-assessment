/**
 * Token-aware sliding-window rate limiter backed by on-disk SQLite.
 *
 * Window: a precise "sliding log" — every admitted request contributes a row
 * (tokens, timestamp). A key's current usage is the sum of tokens whose
 * timestamp falls inside the last `windowMs`. Expired rows are evicted on each
 * check, so state does not grow unbounded.
 *
 * `now()` is injectable so the window can be tested deterministically.
 */

import type { UsageDb } from "./db.ts";

export type RateLimitDecision = {
  allowed: boolean;
  used: number; // tokens used in the window (including this request if allowed)
  limit: number;
  remaining: number;
  retryAfterMs?: number; // present when !allowed
};

export type RateLimiterOptions = {
  limitTokens?: number; // default 50_000
  windowMs?: number; // default 60_000
  now?: () => number;
};

export class SlidingWindowRateLimiter {
  private readonly db: UsageDb;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(db: UsageDb, opts: RateLimiterOptions = {}) {
    this.db = db;
    this.limit = opts.limitTokens ?? 50_000;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Attempt to reserve `tokens` for `tenant`. Returns the decision; when
   * allowed, the reservation is recorded atomically.
   */
  tryConsume(tenant: string, tokens: number): RateLimitDecision {
    const now = this.now();
    const windowStart = now - this.windowMs;

    // Single atomic critical section (node:sqlite is synchronous).
    this.db.raw.exec("BEGIN IMMEDIATE");
    try {
      this.db.evictOlderThan(windowStart, tenant);
      const used = this.db.sumSince(tenant, windowStart);

      if (used + tokens > this.limit) {
        // Compute when enough budget frees up: the oldest in-window row must
        // age out of the window before capacity returns.
        const oldest = this.db.oldestSince(tenant, windowStart);
        const retryAfterMs = oldest !== null ? Math.max(1, oldest + this.windowMs - now) : this.windowMs;
        this.db.raw.exec("COMMIT");
        return { allowed: false, used, limit: this.limit, remaining: Math.max(0, this.limit - used), retryAfterMs };
      }

      this.db.insert(tenant, tokens, now);
      this.db.raw.exec("COMMIT");
      const newUsed = used + tokens;
      return { allowed: true, used: newUsed, limit: this.limit, remaining: this.limit - newUsed };
    } catch (err) {
      this.db.raw.exec("ROLLBACK");
      throw err;
    }
  }
}
