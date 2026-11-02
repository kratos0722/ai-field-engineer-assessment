# AI Field Developer / Solutions Engineer — Assessment

Four self-contained TypeScript projects covering MCP servers, MCP/LLM gateways, streaming security
guardrails, and model-routing resilience. Each task is runnable on its own, ships with tests, and
documents how it meets the stated evaluation criteria.

| # | Task | Focus | Tests |
|---|------|-------|-------|
| 1 | [MCP Server](./task1-mcp-server) | Official MCP SDK, strict Zod validation, stdio hygiene, JSON-RPC error mapping | 10 |
| 2 | [MCP Security Gateway](./task2-mcp-gateway) | Reverse proxy, bearer-token roles, method-level (`admin_*`) authorization | 9 |
| 3 | [LLM Streaming Guardrail](./task3-llm-guardrail) | Real-time PII redaction over a token stream, bounded memory, low TTFT | 9 |
| 4 | [Rate-Limit & Fallback Router](./task4-fallback-router) | Token-aware sliding window (SQLite), timeout + 429 failover, sanitized errors | 11 |

## Design choices that span all four

- **TypeScript on Node.js ≥ 22.6, executed natively** via type stripping — no build step, no bundler.
  `npm test` runs the real code with `node --test`.
- **Minimal dependencies.** Only Task 1 has runtime deps (`@modelcontextprotocol/sdk`, `zod`,
  `zod-to-json-schema`). Tasks 2–4 use only Node built-ins (`node:http`, `node:sqlite`, `node:crypto`).
- **Errors mapped to the correct layer.** Protocol vs. application errors (Tasks 1–2); sanitized,
  stable client payloads that never leak internals (Tasks 2–4).
- **Everything is testable and runs offline.** LLM/model providers are abstracted behind interfaces
  with deterministic mocks, so there are no API keys or network calls in the tests.

## Quick start

Each task is an independent npm package:

```bash
cd task1-mcp-server   # or task2-… / task3-… / task4-…
npm install
npm test
npm run typecheck
npm start
```

Run every task's suite from the repo root:

```bash
for d in task1-mcp-server task2-mcp-gateway task3-llm-guardrail task4-fallback-router; do
  ( cd "$d" && npm install --silent && npm test ); done
```

## Requirements

- **Node.js ≥ 22.6** (≥ 23.6 recommended, where TypeScript type stripping is enabled by default).
  Native `node:sqlite` is used by Task 4.
