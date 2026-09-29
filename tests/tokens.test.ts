import { describe, expect, it } from "vitest";
import { generateSessionToken, hashToken } from "../src/lib/tokens";

describe("session tokens", () => {
  it("generates unique high-entropy tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    // 32 random bytes in base64url ⇒ ~43 chars, url-safe alphabet only.
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes deterministically to a 64-char sha256 hex digest", () => {
    const token = generateSessionToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps different tokens to different hashes", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});
