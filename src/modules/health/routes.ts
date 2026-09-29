import type { FastifyInstance } from "fastify";

const startedAt = Date.now();

/**
 * Health/readiness endpoint. Unauthenticated, no DB dependency — used by
 * hosting platforms and by the client's connectivity smoke check.
 * GET /api/v1/health
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    data: {
      status: "ok",
      uptime: (Date.now() - startedAt) / 1000,
      version: process.env.npm_package_version ?? "0.1.0",
    },
  }));
}
