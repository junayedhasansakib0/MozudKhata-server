import { z } from "zod";

/**
 * Category request schemas (docs/api.md §Phase 04). The backend is the
 * authoritative validation boundary; the client mirrors these shapes.
 */

export const categoryNameSchema = z.string().trim().min(1, "Name is required.").max(120);

export const createCategorySchema = z.object({
  name: categoryNameSchema,
});

export const updateCategorySchema = z.object({
  name: categoryNameSchema,
});

export const categoryParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listCategoriesQuerySchema = z.object({
  // Coerced from the query string; archived categories are hidden by default.
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
