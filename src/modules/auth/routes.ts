import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import { issueCsrfToken, requireCsrf } from "./csrf";
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from "./schema";
import * as authService from "./service";
import { clearSessionCookie, setSessionCookie } from "./session";
import { env } from "../../config/env";

// Tighter limiter for credential endpoints, layered on the global 100/min.
const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

function sessionContext(request: FastifyRequest): authService.SessionContext {
  return { userAgent: request.headers["user-agent"] ?? null, ip: request.ip };
}

function requireUser(request: FastifyRequest): { id: string; sessionId: string } {
  if (!request.user || !request.sessionId) {
    throw new AppError("UNAUTHORIZED", "Authentication required.");
  }
  return { id: request.user.id, sessionId: request.sessionId };
}

/**
 * Auth & account routes (docs/api.md §Phase 02). Mounted under `/api/v1`.
 * State-changing routes require the double-submit CSRF token; credential routes
 * are additionally rate-limited.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Issues a CSRF token (safe GET; sets the readable cookie + returns the value).
  app.get("/auth/csrf", async (_request, reply) => {
    const csrfToken = issueCsrfToken(reply);
    return reply.send({ data: { csrfToken } });
  });

  app.post(
    "/auth/register",
    { preHandler: [requireCsrf], ...authRateLimit },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const { user, token, expiresAt } = await authService.register(input, sessionContext(request));
      setSessionCookie(reply, token, expiresAt);
      return reply.status(201).send({ data: { user } });
    },
  );

  app.post(
    "/auth/login",
    { preHandler: [requireCsrf], ...authRateLimit },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const { user, token, expiresAt } = await authService.login(input, sessionContext(request));
      setSessionCookie(reply, token, expiresAt);
      return reply.send({ data: { user } });
    },
  );

  app.post("/auth/logout", { preHandler: [requireCsrf] }, async (request, reply) => {
    await authService.logout(request.cookies[env.SESSION_COOKIE_NAME]);
    clearSessionCookie(reply);
    return reply.send({ data: { success: true } });
  });

  app.get("/auth/me", { preHandler: [app.requireAuth] }, async (request) => {
    return { data: { user: request.user } };
  });

  app.patch("/account", { preHandler: [app.requireAuth, requireCsrf] }, async (request) => {
    const { id } = requireUser(request);
    const input = updateProfileSchema.parse(request.body);
    const user = await authService.updateProfile(id, input);
    return { data: { user } };
  });

  app.post(
    "/account/password",
    { preHandler: [app.requireAuth, requireCsrf], ...authRateLimit },
    async (request, reply) => {
      const { id, sessionId } = requireUser(request);
      const input = changePasswordSchema.parse(request.body);
      await authService.changePassword(id, sessionId, input);
      return reply.send({ data: { success: true } });
    },
  );
}
