import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env";
import { AppError } from "../lib/errors";
import { setSessionCookie } from "../modules/auth/session";
import { validateSession, type PublicUser } from "../modules/auth/service";

declare module "fastify" {
  interface FastifyRequest {
    /** Authenticated user, or null when the request carries no valid session. */
    user: PublicUser | null;
    /** Id of the session backing `user`, or null. */
    sessionId: string | null;
  }
  interface FastifyInstance {
    /** preHandler: rejects the request (401) unless a valid session is present. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler: attaches `user`/`sessionId` if present, never rejects. */
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Registers the session-cookie auth guards. Decorators declared on the root
 * instance are visible to every child scope, so routes under `/api/v1` can use
 * `app.requireAuth`. The data layer (from Phase 03) remains the real owner-scope
 * boundary; this guard only establishes identity.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  async function loadSession(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const token = request.cookies[env.SESSION_COOKIE_NAME];
    if (!token) return false;

    const result = await validateSession(token);
    if (!result) return false;

    request.user = result.user;
    request.sessionId = result.sessionId;
    // Rolling renewal: push the cookie's lifetime out to match the DB row.
    if (result.refreshed) {
      setSessionCookie(reply, token, result.expiresAt);
    }
    return true;
  }

  app.decorate("optionalAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    await loadSession(request, reply);
  });

  app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    const authed = await loadSession(request, reply);
    if (!authed) {
      throw new AppError("UNAUTHORIZED", "Authentication required.");
    }
  });
}
