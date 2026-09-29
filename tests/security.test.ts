import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

/**
 * Phase 09 security hardening regressions. These exercise the cross-cutting
 * guards (auth, CSRF, request parsing, security headers) that every route
 * inherits, so they need no live DB — the guards and the error handler run
 * before any repository query. Per-module owner-isolation is asserted in the
 * feature test files (categories/products/stock/dashboard).
 */
describe("security hardening", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an unauthenticated request to a protected route with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/products" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a state-changing request without a CSRF token with 403", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("maps a malformed JSON body to 400 (not a masked 500)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{ not valid json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    // The framework's raw parse message must not leak to the client.
    expect(res.json().error.message).toBe("Invalid request.");
  });

  it("sets hardening headers (nosniff + cross-origin resource policy) on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    // helmet also removes the framework fingerprint.
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
