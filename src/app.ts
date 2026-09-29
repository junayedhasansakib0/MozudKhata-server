import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { corsOrigins, env } from "./config/env";
import { registerErrorHandler } from "./lib/errors";
import { registerAuth } from "./plugins/auth";
import { authRoutes } from "./modules/auth/routes";
import { categoryRoutes } from "./modules/categories/routes";
import { dashboardRoutes } from "./modules/dashboard/routes";
import { healthRoutes } from "./modules/health/routes";
import { productRoutes } from "./modules/products/routes";
import { stockRoutes } from "./modules/stock/routes";

/**
 * Builds and configures the Fastify instance (plugins + routes) without
 * starting to listen — so tests can drive it via `app.inject`.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV !== "test",
    // Bound request bodies (this API only accepts small JSON payloads).
    bodyLimit: 256 * 1024, // 256 KiB
  });

  // Security & cross-origin.
  // The API serves JSON to a separate-origin SPA with credentials, so the
  // Cross-Origin-Resource-Policy must allow cross-origin reads (CORS still
  // governs who may read); helmet's other protections (HSTS, nosniff, frame
  // guards, hidePoweredBy, etc.) keep their secure defaults. See docs/security.md §8.
  await app.register(helmet, {
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cors, { origin: corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    // Emit the standard error envelope on throttle (docs/api.md).
    errorResponseBuilder: () => ({
      error: { code: "RATE_LIMITED", message: "Too many requests." },
    }),
  });

  registerErrorHandler(app);
  registerAuth(app);

  // Versioned API surface. Feature modules are mounted here.
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(categoryRoutes);
      await api.register(productRoutes);
      await api.register(stockRoutes);
      await api.register(dashboardRoutes);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
