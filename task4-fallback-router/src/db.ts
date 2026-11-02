/**
 * On-disk SQLite usage store (uses the built-in `node:sqlite` module).
 *
 * Holds one row per admitted request so the rate limiter can compute a precise
 * sliding window and evict expired rows. Synchronous API (DatabaseSync) — which
 * is exactly what we want: a consume() check is a single, atomic, in-process
 * critical section with no interleaving.
 */

import { DatabaseSync } from "node:sqlite";

export type UsageDb = {
  raw: DatabaseSync;
  /** Insert a usage record. */
  insert(tenant: string, tokens: number, ts: number): void;
  /** Sum tokens for a tenant within [since, ∞). */
  sumSince(tenant: string, since: number): number;
  /** Oldest timestamp for a tenant within [since, ∞), or null. */
  oldestSince(tenant: string, since: number): number | null;
  /** Delete rows older than `before` (optionally scoped to a tenant). */
  evictOlderThan(before: number, tenant?: string): number;
  close(): void;
};

export function openUsageDb(path = "ratelimit.db"): UsageDb {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT    NOT NULL,
      tokens INTEGER NOT NULL,
      ts     INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_tenant_ts ON usage(tenant, ts);");

  const insertStmt = db.prepare("INSERT INTO usage(tenant, tokens, ts) VALUES (?, ?, ?)");
  const sumStmt = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS total FROM usage WHERE tenant = ? AND ts >= ?");
  const oldestStmt = db.prepare("SELECT MIN(ts) AS oldest FROM usage WHERE tenant = ? AND ts >= ?");
  const evictAllStmt = db.prepare("DELETE FROM usage WHERE ts < ?");
  const evictTenantStmt = db.prepare("DELETE FROM usage WHERE ts < ? AND tenant = ?");

  return {
    raw: db,
    insert(tenant, tokens, ts) {
      insertStmt.run(tenant, tokens, ts);
    },
    sumSince(tenant, since) {
      const row = sumStmt.get(tenant, since) as { total: number };
      return row.total;
    },
    oldestSince(tenant, since) {
      const row = oldestStmt.get(tenant, since) as { oldest: number | null };
      return row.oldest;
    },
    evictOlderThan(before, tenant) {
      const info = tenant ? evictTenantStmt.run(before, tenant) : evictAllStmt.run(before);
      return Number(info.changes);
    },
    close() {
      db.close();
    },
  };
}
