/**
 * Model provider abstraction + configurable mock providers.
 *
 * A provider resolves with a completion or rejects. Two failure modes matter to
 * the router: an HTTP 429 (surfaced as `UpstreamError` with status 429) and a
 * timeout (the provider never responds in time and is aborted via the signal).
 */

export type CompletionRequest = {
  tenant: string;
  prompt: string;
  maxTokens?: number;
  model?: string;
};

export type CompletionResponse = {
  model: string;
  text: string;
  usage: { totalTokens: number };
};

export interface ModelProvider {
  readonly name: string;
  complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResponse>;
}

/** Raised by a provider for a non-2xx upstream status (e.g. 429). */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message = `upstream status ${status}`) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/** Resolve after `ms`, or reject immediately if the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type MockBehavior =
  | { kind: "ok"; text?: string; tokens?: number; delayMs?: number }
  | { kind: "status"; status: number; delayMs?: number }
  | { kind: "hang" }; // never resolves on its own; only an abort ends it

/**
 * Build a mock provider. `behavior` may be a single value or a queue that is
 * consumed one entry per call (so a provider can fail then recover).
 */
export function makeMockProvider(name: string, behavior: MockBehavior | MockBehavior[]): ModelProvider {
  const queue = Array.isArray(behavior) ? [...behavior] : null;
  const fixed = Array.isArray(behavior) ? null : behavior;

  return {
    name,
    async complete(req, signal) {
      const b = queue ? queue.shift() ?? { kind: "status", status: 503 } : (fixed as MockBehavior);
      switch (b.kind) {
        case "ok": {
          if (b.delayMs) await delay(b.delayMs, signal);
          return {
            model: name,
            text: b.text ?? `completion from ${name} for: ${req.prompt.slice(0, 40)}`,
            usage: { totalTokens: b.tokens ?? 42 },
          };
        }
        case "status": {
          if (b.delayMs) await delay(b.delayMs, signal);
          throw new UpstreamError(b.status);
        }
        case "hang": {
          // Wait forever until aborted by the router's timeout.
          await new Promise<never>((_, reject) => {
            if (signal.aborted) return reject(new AbortError());
            signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
          });
          throw new AbortError(); // unreachable
        }
      }
    },
  };
}
