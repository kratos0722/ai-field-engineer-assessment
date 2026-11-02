/**
 * Demo HTTP server wiring the router together.
 *
 * POST /v1/complete
 *   headers: Authorization: Bearer <tenant-api-key>
 *   body:    { "prompt": "...", "max_tokens": 256 }
 *
 * The tenant API key is the rate-limiting dimension. Responses are either a
 * completion or a standardized error payload (with the matching HTTP status).
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import { openUsageDb } from "./db.ts";
import { SlidingWindowRateLimiter } from "./rateLimiter.ts";
import { ModelRouter } from "./router.ts";
import { GatewayError } from "./errors.ts";
import { makeMockProvider } from "./providers.ts";

export function createServer(router: ModelRouter): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== "POST" || !req.url?.startsWith("/v1/complete")) {
      send(404, { error: { type: "bad_request", code: 404, message: "POST /v1/complete only" } });
      return;
    }

    const auth = req.headers["authorization"];
    const tenant = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "").trim() : "";

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: { prompt?: string; max_tokens?: number } = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        send(400, { error: { type: "bad_request", code: 400, message: "invalid JSON body" } });
        return;
      }

      router
        .complete({ tenant, prompt: parsed.prompt ?? "", maxTokens: parsed.max_tokens })
        .then((result) => {
          res.setHeader("x-served-by", result.servedBy);
          res.setHeader("x-failed-over", String(result.failedOver));
          send(200, { model: result.response.model, text: result.response.text, usage: result.response.usage });
        })
        .catch((err) => {
          if (err instanceof GatewayError) {
            const payload = err.toPayload();
            if (payload.error.retry_after_ms !== undefined) {
              res.setHeader("retry-after", String(Math.ceil(payload.error.retry_after_ms / 1000)));
            }
            send(err.httpStatus, payload);
          } else {
            // Last-resort sanitization: nothing internal escapes.
            process.stderr.write(`[server] unexpected: ${err instanceof Error ? err.stack : String(err)}\n`);
            send(500, { error: { type: "internal", code: 500, message: "An internal error occurred." } });
          }
        });
    });
  });
}

// Allow running standalone: `node src/server.ts`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const db = openUsageDb(process.env.DB_PATH ?? "ratelimit.db");
  const rateLimiter = new SlidingWindowRateLimiter(db, { limitTokens: 50_000, windowMs: 60_000 });

  // Demo providers: primary returns 429 (to show failover), secondary is healthy.
  const primary = makeMockProvider("primary-gpt", { kind: "status", status: 429 });
  const secondary = makeMockProvider("secondary-claude", { kind: "ok", text: "Hello from the backup model." });

  const router = new ModelRouter({ primary, secondary, rateLimiter, timeoutMs: 3000 });
  const port = Number(process.env.PORT ?? 8083);
  createServer(router).listen(port, () => {
    process.stderr.write(`[server] listening on http://127.0.0.1:${port}  (POST /v1/complete)\n`);
  });
}
