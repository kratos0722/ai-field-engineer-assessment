# Task 1 — Custom MCP Server (strict validation + stdio hygiene)

A runnable [Model Context Protocol](https://modelcontextprotocol.io) server built on the
official TypeScript SDK (`@modelcontextprotocol/sdk`). It exposes two tools over the **stdio**
transport and demonstrates strict input validation, correct JSON-RPC error mapping, and clean
stdout isolation.

## Tools

| Tool | Input | Notes |
|------|-------|-------|
| `get_customer_record` | `customer_id: string` (`CUST-XXXXX`) | Returns a mock CRM record. |
| `trigger_refund` | `customer_id: string`, `amount: number > 0`, `reason: string (>= 10 chars)` | Issues a mock refund. |

`CUST-XXXXX` = the literal prefix `CUST-` followed by exactly five uppercase alphanumerics
(e.g. `CUST-10293`, `CUST-A1B2C`).

## How the evaluation criteria are met

### STDIO isolation
`stdout` is the JSON-RPC channel and must stay pure. The server:
- routes every diagnostic through a `log()` helper that writes to **stderr**, and
- **redirects `console.log` / `console.info` / `console.debug` to stderr** at startup, so even an
  accidental call can never corrupt the protocol stream.

`tests/stdout-purity.test.ts` spawns the server, drives a raw handshake, and asserts that **every**
line on stdout parses as JSON-RPC 2.0.

### Protocol compliance
The server uses the SDK's low-level `Server` with explicit `tools/list` and `tools/call` handlers so
failures land on the correct layer:

| Condition | Result |
|-----------|--------|
| Invalid / malformed arguments | `McpError(InvalidParams)` → JSON-RPC **`-32602`** |
| Unknown tool name | `McpError(MethodNotFound)` → JSON-RPC **`-32601`** |
| Unknown customer (business rule) | Tool result with **`isError: true`** (not a protocol error) |

This distinction matters: protocol errors are for protocol-level problems; a "customer not found"
is an application outcome and is returned as a normal tool result flagged `isError`.

### Validation
Schemas are declared once with **Zod** and are `.strict()` (unknown keys are rejected). The same Zod
definitions are converted to JSON Schema (`zod-to-json-schema`) for the advertised `inputSchema`, so
the wire contract and the runtime check cannot drift. Covered edge cases: wrong ID format, extra
keys, negative / non-finite amounts, and too-short reasons.

## Run it

```bash
npm install

# Start the server (speaks JSON-RPC on stdio)
npm start

# Type-check
npm run typecheck

# Tests (spawn the real server over stdio)
npm test
```

> Requires Node.js >= 22.6 (TypeScript is executed natively via type stripping — no build step).

### Try it from the command line

The server speaks newline-delimited JSON-RPC on stdio. You can pipe requests in directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"trigger_refund","arguments":{"customer_id":"CUST-10293","amount":12.5,"reason":"duplicate charge on invoice"}}}' \
  | node src/server.ts
```

Everything printed to stdout is JSON-RPC; the `[mcp-server] …` lines you see are on stderr.
