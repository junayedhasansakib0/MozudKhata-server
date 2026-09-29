import { z } from "zod";

/**
 * Product request schemas (docs/api.md §Phase 04). The backend is the
 * authoritative validation boundary; the client mirrors these shapes.
 * `quantity` is never accepted here — stock is changed only via the stock
 * service (ADR-004). Only `lowStockThreshold` (a threshold, not a balance) is set.
 */

export const productNameSchema = z.string().trim().min(1, "Name is required.").max(200);
export const skuSchema = z.string().trim().min(1).max(64);
export const unitSchema = z.string().trim().min(1).max(16);
export const descriptionSchema = z.string().trim().max(2000);

// A non-negative quantity with up to 3 decimal places (numeric(12,3), ADR-008).
// Accepts a number or numeric string; normalized to a string to preserve
// precision end-to-end (JSON floats are lossy). Bounded to fit numeric(12,3).
export const quantitySchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === "number" ? value.toString() : value.trim()))
  .refine((s) => /^\d{1,9}(\.\d{1,3})?$/.test(s), {
    message: "Must be a non-negative number with up to 3 decimal places.",
  });

export const createProductSchema = z.object({
  name: productNameSchema,
  categoryId: z.string().uuid().nullish(),
  sku: skuSchema.nullish(),
  unit: unitSchema.optional(),
  lowStockThreshold: quantitySchema.optional(),
  description: descriptionSchema.nullish(),
});

// Partial update: every field optional; omitted fields are left unchanged.
export const updateProductSchema = z
  .object({
    name: productNameSchema,
    categoryId: z.string().uuid().nullable(),
    sku: skuSchema.nullable(),
    unit: unitSchema,
    lowStockThreshold: quantitySchema,
    description: descriptionSchema.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update." });

export const productParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
