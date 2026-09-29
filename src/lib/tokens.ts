import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque, high-entropy tokens for sessions and CSRF. Session tokens are the raw
 * secret handed to the client (in an httpOnly cookie); only their SHA-256 hash
 * is persisted (docs/security.md §2). SHA-256 is appropriate here — the token is
 * already 256 bits of randomness, so a slow password hash buys nothing and would
 * add latency to every authenticated request.
 */
function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function generateSessionToken(): string {
  return generateOpaqueToken(32);
}

export function generateCsrfToken(): string {
  return generateOpaqueToken(32);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
