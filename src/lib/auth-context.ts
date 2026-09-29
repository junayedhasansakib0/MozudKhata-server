import type { FastifyRequest } from "fastify";
import { AppError } from "./errors";

/**
 * Resolve the authenticated user from a request, or throw `UNAUTHORIZED`. Use in
 * route handlers behind `app.requireAuth` to get an owner id for owner-scoped
 * queries (ADR-002). Centralized so every feature module scopes identically.
 */
export function requireUser(request: FastifyRequest): { id: string; sessionId: string } {
  if (!request.user || !request.sessionId) {
    throw new AppError("UNAUTHORIZED", "Authentication required.");
  }
  return { id: request.user.id, sessionId: request.sessionId };
}
