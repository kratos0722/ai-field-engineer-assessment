/**
 * Boundary-safe streaming PII redactor.
 *
 * The hard part of redacting a *stream* is that a sensitive value can be split
 * across chunk boundaries, e.g. the provider sends "jane.d" then
 * "oe@example.com". A naive per-chunk regex would miss it.
 *
 * Strategy (O(1) extra memory, not O(response)):
 *   - Keep a small `buffer` of text that has arrived but not yet been emitted.
 *   - On each chunk, append it, then compute a SAFE CUT POINT: the start of any
 *     trailing run of characters that could still grow into a PII match. Emit
 *     (redacted) everything before the cut; keep the short tail for next time.
 *   - The held-back tail is bounded by `maxHold` (default 256 >= the longest
 *     possible match, an RFC-max email), so memory and added latency are
 *     bounded regardless of response length.
 *   - `flush()` redacts and returns whatever remains at end-of-stream.
 *
 * This keeps Time-To-First-Token low (only the final partial token is held)
 * while never emitting un-redacted PII.
 */

// --- Patterns -------------------------------------------------------------
// Order matters: emails first (they contain digits), then SSNs, then cards.
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "email", re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { label: "ssn", re: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g },
  // 13–19 digits with optional single space/hyphen separators (Visa/MC/Amex/…)
  { label: "credit_card", re: /\b\d(?:[ -]?\d){12,18}\b/g },
];

export const REDACTION = "[REDACTED]";

/** Characters that can appear *inside* a single PII token (excluding the
 *  conditional digit-separating space, handled separately). */
const TOKEN_CHAR = /[A-Za-z0-9@._%+\-]/;
const DIGIT = /[0-9]/;

/** Apply all redaction patterns to a settled string. */
export function redact(text: string): string {
  let out = text;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTION);
  }
  return out;
}

export class StreamRedactor {
  private buffer = "";
  private readonly maxHold: number;

  constructor(maxHold = 256) {
    this.maxHold = maxHold;
  }

  /** How many bytes are currently buffered (for assertions / observability). */
  get buffered(): number {
    return this.buffer.length;
  }

  /**
   * Find the index up to which it is safe to emit. Everything from this index
   * onward is a trailing run that might still be completing a PII match.
   */
  private safeCut(buf: string): number {
    let i = buf.length;
    while (i > 0) {
      const c = buf[i - 1] as string;
      if (TOKEN_CHAR.test(c)) {
        i--;
        continue;
      }
      // A space counts as part of the run when it is preceded by a digit — it
      // may be a credit-card separator ("4111 1111 ...") whose next digit group
      // simply hasn't arrived yet. This holds the tail across chunk boundaries.
      if (c === " " && i - 2 >= 0 && DIGIT.test(buf[i - 2] as string)) {
        i--;
        continue;
      }
      break;
    }
    // Bound the hold-back: a genuine match is <= maxHold chars, so if the run is
    // longer it must be ordinary prose and is safe to cut.
    if (buf.length - i > this.maxHold) {
      i = buf.length - this.maxHold;
    }
    return i;
  }

  /** Feed a chunk; returns the redacted, safe-to-emit text (possibly ""). */
  push(chunk: string): string {
    this.buffer += chunk;
    const cut = this.safeCut(this.buffer);
    if (cut === 0) return "";
    const head = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return redact(head);
  }

  /** End of stream: redact and return whatever is left. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return redact(rest);
  }
}

/**
 * Convenience: wrap an async iterable of raw deltas into an async iterable of
 * redacted deltas. Memory stays bounded; nothing is accumulated.
 */
export async function* redactStream(source: AsyncIterable<string>, maxHold = 256): AsyncGenerator<string> {
  const r = new StreamRedactor(maxHold);
  for await (const chunk of source) {
    const out = r.push(chunk);
    if (out) yield out;
  }
  const tail = r.flush();
  if (tail) yield tail;
}
