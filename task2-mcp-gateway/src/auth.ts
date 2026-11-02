/**
 * Token -> role resolution for the MCP security gateway.
 *
 * In production this is where you would validate a signed JWT (verify
 * signature + expiry) or call a token-introspection endpoint. For a runnable,
 * self-contained demo we use a small static registry. The rest of the gateway
 * only depends on `resolveRole()`, so swapping in real verification is a
 * one-function change.
 */

export type Role = "admin" | "viewer";

export type Principal = {
  subject: string;
  role: Role;
};

const TOKEN_REGISTRY: Record<string, Principal> = {
  "admin-token": { subject: "svc-admin", role: "admin" },
  "viewer-token": { subject: "svc-viewer", role: "viewer" },
};

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}

/** Resolve a bearer token to a principal, or null if unknown/invalid. */
export function resolveRole(token: string | null): Principal | null {
  if (!token) return null;
  return TOKEN_REGISTRY[token] ?? null;
}
