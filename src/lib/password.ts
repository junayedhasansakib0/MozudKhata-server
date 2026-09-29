import { Algorithm, hash, verify } from "@node-rs/argon2";

/**
 * Argon2id password hashing (ADR-014 / docs/security.md §2). Parameters follow
 * the OWASP minimum for Argon2id (m=19 MiB, t=2, p=1); the encoded hash records
 * them, so `verify` needs no options and old hashes stay verifiable if we tune
 * these later. Plaintext passwords are never stored or logged.
 */
const hashOptions = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, hashOptions);
}

export async function verifyPassword(hashString: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashString, plain);
  } catch {
    // Malformed/unknown hash — treat as a non-match rather than throwing.
    return false;
  }
}
