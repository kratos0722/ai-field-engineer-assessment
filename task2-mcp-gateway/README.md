# Task 2 — MCP Security Gateway Proxy

A lightweight HTTP/JSON-RPC reverse proxy that sits between an AI agent client and a downstream MCP
server and enforces **fine-grained, method-level authorization**. Pure Node.js — no framework, no
runtime dependencies.

```
agent client ──Bearer token──▶  GATEWAY  ──▶  downstream MCP server
                               (authz here)      (trusts the gateway)
```

## Authorization rules

| Incoming request | Behaviour |
|------------------|-----------|
| No / invalid bearer token | `401` + JSON-RPC **`-32001`** (never forwarded) |
| `tools/list` | Forwarded transparently |
| `tools/call`, `params.name` **not** starting with `admin_` | Forwarded |
| `tools/call`, `params.name` starting with `admin_`, role = `admin` | Forwarded |
| `tools/call`, `params.name` starting with `admin_`, role ≠ `admin` | Intercepted → JSON-RPC **`-32001` "Unauthorized Tool Call"** (downstream never contacted) |
| Any other method (`initialize`, `ping`, …) | Forwarded transparently |

Batch requests (JSON-RPC arrays) are authorized **per item**: blocked items are answered locally and
the rest are forwarded in a single downstream batch, then responses are merged back in order.

## Tokens (demo registry)

| Bearer token | Role |
|--------------|------|
| `admin-token` | `admin` |
| `viewer-token` | `viewer` |

`src/auth.ts` is the single seam for authentication: in production, `resolveRole()` would verify a
signed JWT or call a token-introspection endpoint instead of consulting a static map.

## How the evaluation criteria are met

- **JSON-RPC wire format** — `src/jsonrpc.ts` models requests/responses and standard error codes;
  the gateway distinguishes single vs. batch payloads and validates the envelope before acting.
- **Proxy middleware + forwarding** — `forward()` relays the (possibly filtered) payload to the
  downstream server with `fetch` and returns its response verbatim.
- **Method-level authorization + clean errors** — `authorize()` inspects `params.name`, enforces the
  `admin_` rule, and returns a structured `-32001` with `{ tool, requiredRole, actualRole }`.
  Internal failures are logged to stderr and surfaced as a generic `-32603` / `502` — no stack
  traces leak to the client.

## Run it

```bash
npm install

# Terminal 1 — start the mock downstream MCP server (port 8081)
npm run downstream

# Terminal 2 — start the gateway (port 8080, forwards to 8081)
npm start

# Tests spin up both servers on ephemeral ports automatically:
npm test
npm run typecheck
```

### Manual checks (with both servers running)

```bash
# viewer may list tools
curl -s localhost:8080 -H 'authorization: Bearer viewer-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# viewer is blocked from an admin_ tool (-32001)
curl -s localhost:8080 -H 'authorization: Bearer viewer-token' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"admin_reset_key"}}'

# admin may call it
curl -s localhost:8080 -H 'authorization: Bearer admin-token' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"admin_reset_key"}}'
```

> Requires Node.js >= 22.6 (TypeScript executed natively; no build step).
