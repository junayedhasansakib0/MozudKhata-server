import type { FastifyInstance } from "fastify";
import { requireUser } from "../../lib/auth-context";
import { requireCsrf } from "../auth/csrf";
import * as productService from "../products/service";
import { movementParamsSchema, recordMovementSchema } from "./schema";
import * as stockService from "./service";

/**
 * Stock movement routes (docs/api.md §Phase 05). Mounted under `/api/v1`.
 *
 * This is the ONLY HTTP surface that changes stock — it delegates to the
 * transactional stock service (ADR-004); the route stays thin and never touches
 * quantities itself. Recording requires a session + the double-submit CSRF
 * token; reading history requires a session. Both are owner-scoped (ADR-002):
 * the record path's locked transaction rejects a foreign/archived product with
 * NOT_FOUND, and the read path first asserts ownership via the product service
 * (so a foreign/unknown id is 404, not an empty list that leaks existence).
 */
export async function stockRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/products/:id/movements",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request, reply) => {
      const { id: ownerId } = requireUser(request);
      const { id: productId } = movementParamsSchema.parse(request.params);
      const body = recordMovementSchema.parse(request.body);

      const movement = await stockService.recordMovement({
        ownerId,
        productId,
        actorId: ownerId,
        type: body.type,
        quantity: body.quantity,
        reason: body.reason ?? null,
      });

      return reply.status(201).send({ data: { movement } });
    },
  );

  app.get("/products/:id/movements", { preHandler: [app.requireAuth] }, async (request) => {
    const { id: ownerId } = requireUser(request);
    const { id: productId } = movementParamsSchema.parse(request.params);

    // Assert the product exists and is the caller's before reading its ledger.
    await productService.getProduct(ownerId, productId);
    const movements = await stockService.listProductMovements(ownerId, productId);

    return { data: { movements } };
  });
}
