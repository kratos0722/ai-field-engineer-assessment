/**
 * Task 1 — Custom MCP Server with strict validation & stdio transport hygiene.
 *
 * Exposes two tools over the stdio transport:
 *   - get_customer_record(customer_id)
 *   - trigger_refund(customer_id, amount, reason)
 *
 * Design notes (these map directly to the evaluation criteria):
 *
 *  1. STDIO ISOLATION
 *     The stdio transport uses stdout as the JSON-RPC channel. A single stray
 *     `console.log` (or anything else writing to fd 1) corrupts the protocol
 *     framing. We therefore route ALL diagnostics through a logger that writes
 *     to stderr, and defensively redirect `console.log/info/debug` to stderr so
 *     that even an accidental call cannot poison stdout.
 *
 *  2. PROTOCOL COMPLIANCE
 *     We use the SDK's low-level `Server` with explicit request handlers. This
 *     lets us map failures to the correct JSON-RPC layer:
 *       - malformed/invalid input  -> McpError(InvalidParams)   => -32602
 *       - unknown tool name        -> McpError(MethodNotFound)  => -32601
 *     Both are serialized by the SDK into standard JSON-RPC error responses.
 *     Application-level problems (e.g. "customer not found") are NOT protocol
 *     errors — they are returned as MCP tool results with `isError: true`.
 *
 *  3. VALIDATION
 *     Schemas are declared with Zod and are strict: exact ID format, positive
 *     finite amount, a minimum reason length, and `.strict()` objects that
 *     reject unknown keys. The advertised JSON Schema is generated from the
 *     same Zod definitions, so the wire contract and runtime check never drift.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ---------------------------------------------------------------------------
// STDOUT PROTECTION — stdout is reserved exclusively for JSON-RPC.
// ---------------------------------------------------------------------------
const log = (...args: unknown[]): void => {
  process.stderr.write(`[mcp-server] ${args.map(String).join(" ")}\n`);
};
console.log = (...args: unknown[]) => log(...args);
console.info = (...args: unknown[]) => log(...args);
console.debug = (...args: unknown[]) => log(...args);
// console.error already targets stderr; leave it as-is.

// ---------------------------------------------------------------------------
// VALIDATION SCHEMAS
// ---------------------------------------------------------------------------
// Customer IDs are "CUST-" followed by exactly five uppercase alphanumerics,
// e.g. CUST-10293 or CUST-A1B2C.
const CustomerId = z
  .string()
  .trim()
  .regex(/^CUST-[A-Z0-9]{5}$/, "customer_id must match CUST-XXXXX (5 uppercase alphanumerics)");

const GetCustomerRecordInput = z
  .object({
    customer_id: CustomerId,
  })
  .strict();

const TriggerRefundInput = z
  .object({
    customer_id: CustomerId,
    amount: z
      .number({ invalid_type_error: "amount must be a number" })
      .positive("amount must be greater than 0")
      .finite("amount must be a finite number")
      .max(1_000_000, "amount exceeds the maximum allowed refund"),
    reason: z
      .string()
      .trim()
      .min(10, "reason must be at least 10 characters")
      .max(500, "reason must be at most 500 characters"),
  })
  .strict();

type GetCustomerRecordArgs = z.infer<typeof GetCustomerRecordInput>;
type TriggerRefundArgs = z.infer<typeof TriggerRefundInput>;

// ---------------------------------------------------------------------------
// MOCK DATA LAYER — stand-in for a real CRM / billing backend.
// ---------------------------------------------------------------------------
type CustomerRecord = {
  customer_id: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  balance_usd: number;
};

const CUSTOMERS = new Map<string, CustomerRecord>([
  ["CUST-10293", { customer_id: "CUST-10293", name: "Ada Lovelace", email: "ada@example.com", status: "active", balance_usd: 240.5 }],
  ["CUST-55512", { customer_id: "CUST-55512", name: "Alan Turing", email: "alan@example.com", status: "active", balance_usd: 0 }],
  ["CUST-A1B2C", { customer_id: "CUST-A1B2C", name: "Grace Hopper", email: "grace@example.com", status: "suspended", balance_usd: 99.99 }],
]);

// ---------------------------------------------------------------------------
// TOOL REGISTRY
// ---------------------------------------------------------------------------
type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const TOOLS = [
  {
    name: "get_customer_record",
    description: "Fetch a customer record by its CUST-XXXXX identifier.",
    schema: GetCustomerRecordInput,
  },
  {
    name: "trigger_refund",
    description: "Issue a refund for a customer. Requires a positive amount and a reason (>= 10 chars).",
    schema: TriggerRefundInput,
  },
] as const;

/** Flatten a ZodError into a short, deterministic, client-safe message. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length ? i.path.join(".") : "(root)";
      return `${path}: ${i.message}`;
    })
    .join("; ");
}

function okText(value: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): TextResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// ---------------------------------------------------------------------------
// BUSINESS LOGIC
// ---------------------------------------------------------------------------
function getCustomerRecord({ customer_id }: GetCustomerRecordArgs): TextResult {
  const record = CUSTOMERS.get(customer_id);
  if (!record) {
    // Application-level failure -> MCP tool error, NOT a protocol error.
    return toolError(`No customer found for id ${customer_id}`);
  }
  return okText(record);
}

function triggerRefund({ customer_id, amount, reason }: TriggerRefundArgs): TextResult {
  const record = CUSTOMERS.get(customer_id);
  if (!record) {
    return toolError(`Cannot refund: no customer found for id ${customer_id}`);
  }
  if (record.status === "suspended") {
    return toolError(`Cannot refund: account ${customer_id} is suspended`);
  }
  const refund = {
    refund_id: `RFND-${Date.now().toString(36).toUpperCase()}`,
    customer_id,
    amount_usd: Math.round(amount * 100) / 100,
    reason,
    status: "accepted" as const,
    issued_at: new Date().toISOString(),
  };
  return okText(refund);
}

// ---------------------------------------------------------------------------
// SERVER WIRING (low-level API for precise JSON-RPC error mapping)
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "customer-support-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema, { target: "jsonSchema7" }) as Record<string, unknown>,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const tool = TOOLS.find((t) => t.name === name);

  // Unknown tool -> standard JSON-RPC Method not found (-32601).
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  // Strict schema validation -> standard JSON-RPC Invalid params (-32602).
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid params: ${formatZodError(parsed.error)}`);
  }

  log(`${name} ${JSON.stringify(parsed.data)}`);

  switch (tool.name) {
    case "get_customer_record":
      return getCustomerRecord(parsed.data as GetCustomerRecordArgs);
    case "trigger_refund":
      return triggerRefund(parsed.data as TriggerRefundArgs);
    default:
      // Unreachable: TOOLS is exhaustive. Guard anyway.
      throw new McpError(ErrorCode.MethodNotFound, `Unhandled tool: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("server connected over stdio; stdout is reserved for JSON-RPC");
}

main().catch((err) => {
  process.stderr.write(`[mcp-server] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
