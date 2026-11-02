/**
 * LLM provider abstraction.
 *
 * The gateway only needs *a source of text deltas*. That source could be a real
 * provider's streaming API (OpenAI / Anthropic style Server-Sent Events) — you
 * would parse each upstream SSE `data:` frame, pull out the text delta, and
 * yield it here. The redactor downstream is provider-agnostic.
 *
 * To keep this task runnable offline with no API keys, `mockLlmProvider`
 * streams a canned response whose PII is deliberately split across chunk
 * boundaries, proving the redactor handles cross-chunk matches.
 */

export type CompletionRequest = {
  prompt: string;
  model?: string;
};

export type LlmProvider = (req: CompletionRequest) => AsyncIterable<string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each entry is one "token" as it would arrive over the wire. Note how the
// email, SSN, and credit-card number are each split across multiple chunks.
const CANNED_CHUNKS = [
  "Thanks for reaching out! ",
  "You can contact our team at ",
  "support", "@acme", ".com", " or email ",
  "jane.d", "oe@example", ".org directly. ",
  "For verification your SSN ", "123", "-45", "-6789", " is on record, ",
  "and the card ending matches 4111 ", "1111 1111 ", "1111", ". ",
  "Let us know if you need anything else!",
];

export const mockLlmProvider: LlmProvider = async function* (_req: CompletionRequest) {
  for (const chunk of CANNED_CHUNKS) {
    // Simulate inter-token network/compute latency.
    await sleep(15);
    yield chunk;
  }
};
