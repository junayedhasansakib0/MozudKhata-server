import type { FastifyInstance } from "fastify";
import { requireUser } from "../../lib/auth-context";
import { requireCsrf } from "../auth/csrf";
import {
  createProductSchema,
  listProductsQuerySchema,
  productParamsSchema,
  updateProductSchema,
} from "./schema";
import * as productService from "./service";

/**
 * Product CRUD routes (docs/api.md §Phase 04). Mounted under `/api/v1`. Every
 * route requires a session; state-changing routes also require the double-submit
 * CSRF token. Stock is NOT changed here — that is the stock service's job (the
 * movement route arrives in Phase 05). Handlers stay thin; rules live in the service.
 */
export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get("/products", { preHandler: [app.requireAuth] }, async (request) => {
    const { id: ownerId } = requireUser(request);
    const query = listProductsQuerySchema.parse(request.query);
    const { products, meta } = await productService.listProducts(ownerId, query);
    return { data: { products }, meta };
  });

  app.post(
    "/products",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request, reply) => {
      const { id: ownerId } = requireUser(request);
      const input = createProductSchema.parse(request.body);
      const product = await productService.createProduct(ownerId, input);
      return reply.status(201).send({ data: { product } });
    },
  );

  app.get("/products/:id", { preHandler: [app.requireAuth] }, async (request) => {
    const { id: ownerId } = requireUser(request);
    const { id } = productParamsSchema.parse(request.params);
    const product = await productService.getProduct(ownerId, id);
    return { data: { product } };
  });

  app.patch(
    "/products/:id",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request) => {
      const { id: ownerId } = requireUser(request);
      const { id } = productParamsSchema.parse(request.params);
      const input = updateProductSchema.parse(request.body);
      const product = await productService.updateProduct(ownerId, id, input);
      return { data: { product } };
    },
  );

  app.post(
    "/products/:id/archive",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request) => {
      const { id: ownerId } = requireUser(request);
      const { id } = productParamsSchema.parse(request.params);
      const product = await productService.archiveProduct(ownerId, id);
      return { data: { product } };
    },
  );

  app.post(
    "/products/:id/restore",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request) => {
      const { id: ownerId } = requireUser(request);
      const { id } = productParamsSchema.parse(request.params);
      const product = await productService.restoreProduct(ownerId, id);
      return { data: { product } };
    },
  );
}
