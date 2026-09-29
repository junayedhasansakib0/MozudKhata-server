import type { FastifyInstance } from "fastify";
import { requireUser } from "../../lib/auth-context";
import * as dashboardService from "./service";

/**
 * Dashboard route (docs/api.md §Phase 07). Mounted under `/api/v1`. Read-only
 * and owner-scoped: requires a session (no CSRF — it mutates nothing). Returns
 * aggregate inventory metrics plus a recent-activity feed. Handler stays thin;
 * all aggregation lives in the service/repository.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", { preHandler: [app.requireAuth] }, async (request) => {
    const { id: ownerId } = requireUser(request);
    const metrics = await dashboardService.getDashboard(ownerId);
    return { data: metrics };
  });
}
