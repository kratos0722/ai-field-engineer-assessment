/**
 * Lightweight token estimation.
 *
 * A real gateway would use the provider's tokenizer (e.g. tiktoken) or the
 * usage returned by the upstream response. For admission control we only need a
 * fast, conservative estimate: ~4 characters per token for the prompt, plus the
 * requested completion budget (reserved up front, the way real token-based rate
 * limiters admit requests before the completion size is known).
 */

export function estimateTokens(prompt: string, maxTokens = 256): number {
  const promptTokens = Math.ceil(prompt.length / 4);
  return promptTokens + Math.max(0, maxTokens);
}
