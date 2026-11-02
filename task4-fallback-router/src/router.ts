/**
 * Task 4 — Resilient model-routing module for an LLM gateway.
 *
 * Responsibilities:
 *   1. Token-aware sliding-window rate limiting per tenant API key.
 *   2. Call the primary provider with a hard timeout (default 3000ms).
 *   3. On HTTP 429 or timeout, fail over to the secondary provider.
 *   4. Return a standardized, sanitized error payload on failure — never a raw
 *      upstream stack trace or internal detail.
 */

import { randomUUID } from "node:crypto";
import { GatewayError } from "./errors.ts";
import { estimateTokens } from "./tokens.ts";
import type { SlidingWindowRateLimiter } from "./rateLimiter.ts";
import {
  UpstreamError,
  AbortError,
  type CompletionRequest,
  type CompletionResponse,
  type ModelProvider,
} from "./providers.ts";

export type RouterOptions = {
  primary: ModelProvider;
  secondary: ModelProvider;
  rateLimiter: SlidingWindowRateLimiter;
  timeoutMs?: number; // default 3000
};

export type RouterResult = {
  servedBy: string;
  failedOver: boolean;
  response: CompletionResponse;
};

class TimeoutError extends Error {
  constructor(provider: string, ms: number) {
    super(`provider ${provider} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

const log = (requestId: string, ...args: unknown[]): void => {
  process.stderr.write(`[router ${requestId}] ${args.map(String).join(" ")}\n`);
};

/** Call a provider but reject with TimeoutError if it exceeds `timeoutMs`. */
async function callWithTimeout(
  provider: ModelProvider,
  req: CompletionRequest,
  timeoutMs: number,
): Promise<CompletionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new TimeoutError(provider.name, timeoutMs)),
      { once: true },
    );
  });
  try {
    // Whichever settles first wins; the loser is aborted via the shared signal.
    return await Promise.race([provider.complete(req, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** True for the two failure modes that should trigger failover. */
function isFailoverTrigger(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof UpstreamError && err.status === 429) return true;
  return false;
}

export class ModelRouter {
  private readonly primary: ModelProvider;
  private readonly secondary: ModelProvider;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly timeoutMs: number;

  constructor(opts: RouterOptions) {
    this.primary = opts.primary;
    this.secondary = opts.secondary;
    this.rateLimiter = opts.rateLimiter;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async complete(req: CompletionRequest): Promise<RouterResult> {
    const requestId = randomUUID();

    if (!req.tenant || typeof req.prompt !== "string") {
      throw new GatewayError("bad_request", requestId);
    }

    // --- 1. Rate limit (token-aware) ---
    const estimated = estimateTokens(req.prompt, req.maxTokens);
    const decision = this.rateLimiter.tryConsume(req.tenant, estimated);
    if (!decision.allowed) {
      log(requestId, `rate limited tenant=${req.tenant} used=${decision.used}/${decision.limit}`);
      throw new GatewayError("rate_limited", requestId, { retryAfterMs: decision.retryAfterMs });
    }

    // --- 2. Primary with timeout ---
    try {
      const response = await callWithTimeout(this.primary, req, this.timeoutMs);
      return { servedBy: this.primary.name, failedOver: false, response };
    } catch (primaryErr) {
      // Log full detail internally; never surface it to the client.
      log(requestId, `primary (${this.primary.name}) failed: ${describe(primaryErr)}`);

      if (!isFailoverTrigger(primaryErr)) {
        // Not a 429/timeout -> no failover, sanitized error.
        throw new GatewayError("upstream_unavailable", requestId);
      }

      // --- 3. Failover to secondary ---
      try {
        const response = await callWithTimeout(this.secondary, req, this.timeoutMs);
        log(requestId, `failed over to secondary (${this.secondary.name})`);
        return { servedBy: this.secondary.name, failedOver: true, response };
      } catch (secondaryErr) {
        log(requestId, `secondary (${this.secondary.name}) failed: ${describe(secondaryErr)}`);
        throw new GatewayError("upstream_unavailable", requestId);
      }
    }
  }
}

/** Internal-only description for logs (never returned to the client). */
function describe(err: unknown): string {
  if (err instanceof UpstreamError) return `UpstreamError status=${err.status}`;
  if (err instanceof AbortError) return "AbortError";
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
