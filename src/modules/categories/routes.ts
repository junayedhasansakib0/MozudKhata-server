import type { FastifyInstance } from "fastify";
import { requireUser } from "../../lib/auth-context";
import { requireCsrf } from "../auth/csrf";
import {
  categoryParamsSchema,
  createCategorySchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
} from "./schema";
import * as categoryService from "./service";

/**
 * Category CRUD routes (docs/api.md §Phase 04). Mounted under `/api/v1`. Every
 * route requires a session; state-changing routes also require the double-submit
 * CSRF token. Handlers stay thin — validation via Zod, rules in the service.
 */
export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/categories", { preHandler: [app.requireAuth] }, async (request) => {
    const { id: ownerId } = requireUser(request);
    const { includeArchived } = listCategoriesQuerySchema.parse(request.query);
    const categories = await categoryService.listCategories(ownerId, { includeArchived });
    return { data: { categories } };
  });

  app.post(
    "/categories",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request, reply) => {
      const { id: ownerId } = requireUser(request);
      const input = createCategorySchema.parse(request.body);
      const category = await categoryService.createCategory(ownerId, input);
      return reply.status(201).send({ data: { category } });
    },
  );

  app.get("/categories/:id", { preHandler: [app.requireAuth] }, async (request) => {
    const { id: ownerId } = requireUser(request);
    const { id } = categoryParamsSchema.parse(request.params);
    const category = await categoryService.getCategory(ownerId, id);
    return { data: { category } };
  });

  app.patch(
    "/categories/:id",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request) => {
      const { id: ownerId } = requireUser(request);
      const { id } = categoryParamsSchema.parse(request.params);
      const input = updateCategorySchema.parse(request.body);
      const category = await categoryService.renameCategory(ownerId, id, input);
      return { data: { category } };
    },
  );

  app.post(
    "/categories/:id/archive",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request) => {
      const { id: ownerId } = requireUser(request);
      const { id } = categoryParamsSchema.parse(request.params);
      const category = await categoryService.archiveCategory(ownerId, id);
      return { data: { category } };
    },
  );

  app.post(
    "/categories/:id/restore",
    { preHandler: [app.requireAuth, requireCsrf] },
    async (request) => {
      const { id: ownerId } = requireUser(request);
      const { id } = categoryParamsSchema.parse(request.params);
      const category = await categoryService.restoreCategory(ownerId, id);
      return { data: { category } };
    },
  );
}
