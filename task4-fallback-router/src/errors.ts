/**
 * Standardized, sanitized gateway errors.
 *
 * Clients only ever see a stable shape:
 *   { error: { type, code, message, request_id, retry_after_ms? } }
 *
 * Raw upstream messages, stack traces, and internal details are NEVER included
 * in the payload — they are logged to stderr against the same request_id so an
 * operator can correlate without leaking anything to the caller.
 */

export type GatewayErrorType =
  | "rate_limited"
  | "upstream_unavailable"
  | "bad_request"
  | "internal";

export type GatewayErrorPayload = {
  error: {
    type: GatewayErrorType;
    code: number; // HTTP-style status
    message: string;
    request_id: string;
    retry_after_ms?: number;
  };
};

const HTTP_STATUS: Record<GatewayErrorType, number> = {
  rate_limited: 429,
  upstream_unavailable: 503,
  bad_request: 400,
  internal: 500,
};

// Fixed, caller-safe messages. No interpolation of upstream text.
const SAFE_MESSAGE: Record<GatewayErrorType, string> = {
  rate_limited: "Rate limit exceeded for this API key. Please retry later.",
  upstream_unavailable: "No model provider was able to serve this request.",
  bad_request: "The request was invalid.",
  internal: "An internal error occurred.",
};

export class GatewayError extends Error {
  readonly type: GatewayErrorType;
  readonly httpStatus: number;
  readonly requestId: string;
  readonly retryAfterMs?: number;

  constructor(type: GatewayErrorType, requestId: string, opts: { retryAfterMs?: number; internalDetail?: string } = {}) {
    super(SAFE_MESSAGE[type]);
    this.name = "GatewayError";
    this.type = type;
    this.httpStatus = HTTP_STATUS[type];
    this.requestId = requestId;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  toPayload(): GatewayErrorPayload {
    const error: GatewayErrorPayload["error"] = {
      type: this.type,
      code: this.httpStatus,
      message: this.message,
      request_id: this.requestId,
    };
    if (this.retryAfterMs !== undefined) error.retry_after_ms = this.retryAfterMs;
    return { error };
  }
}
