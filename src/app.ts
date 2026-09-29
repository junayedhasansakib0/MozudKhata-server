import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { corsOrigins, env } from "./config/env";
import { registerErrorHandler } from "./lib/errors";
import { registerAuth } from "./plugins/auth";
import { authRoutes } from "./modules/auth/routes";
import { healthRoutes } from "./modules/health/routes";

/**
 * Builds and configures the Fastify instance (plugins + routes) without
 * starting to listen — so tests can drive it via `app.inject`.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV !== "test",
  });

  // Security & cross-origin.
  await app.register(helmet);
  await app.register(cors, { origin: corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  registerErrorHandler(app);
  registerAuth(app);

  // Versioned API surface. Feature modules are mounted here.
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
