/**
 * Task 3 — LLM Gateway streaming guardrail.
 *
 * Exposes `POST /v1/stream`. It calls an LLM provider, intercepts the returning
 * token stream in real time, redacts PII (emails / SSNs / credit cards), and
 * streams the cleaned tokens back to the client as Server-Sent Events.
 *
 * Key properties:
 *   - The response is NEVER fully accumulated — tokens flow through a bounded
 *     `StreamRedactor` and are written out as soon as they are safe to emit.
 *   - Back-pressure is respected (we await `res.write` draining) so a slow
 *     client cannot blow up gateway memory.
 */

import http from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { StreamRedactor } from "./redactor.ts";
import { mockLlmProvider, type LlmProvider, type CompletionRequest } from "./provider.ts";

export type GatewayDeps = {
  provider: LlmProvider;
};

const log = (...args: unknown[]): void => {
  process.stderr.write(`[llm-gateway] ${args.map(String).join(" ")}\n`);
};

async function readJsonBody(req: http.IncomingMessage): Promise<CompletionRequest> {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return { prompt: "" };
  try {
    const parsed = JSON.parse(body) as Partial<CompletionRequest>;
    return { prompt: typeof parsed.prompt === "string" ? parsed.prompt : "", model: parsed.model };
  } catch {
    return { prompt: "" };
  }
}

/** Write one SSE frame, awaiting drain for back-pressure. */
async function writeSse(res: http.ServerResponse, payload: unknown): Promise<void> {
  const ok = res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (!ok) await once(res, "drain");
}

export function createLlmGateway(deps: GatewayDeps): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/stream")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "POST /v1/stream only" }));
      return;
    }

    const request = await readJsonBody(req);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const redactor = new StreamRedactor();
    try {
      for await (const delta of deps.provider(request)) {
        const safe = redactor.push(delta);
        if (safe) await writeSse(res, { delta: safe });
      }
      const tail = redactor.flush();
      if (tail) await writeSse(res, { delta: tail });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      log(`stream error: ${err instanceof Error ? err.stack : String(err)}`);
      // Surface a sanitized error inside the stream, then close.
      await writeSse(res, { error: "upstream_stream_failed" });
      res.end();
    }
  });
}

// Allow running standalone: `node src/gateway.ts`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 8082);
  createLlmGateway({ provider: mockLlmProvider }).listen(port, () => {
    log(`listening on http://127.0.0.1:${port}  (POST /v1/stream)`);
  });
}
