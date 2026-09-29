import { z } from "zod";

/**
 * Stock movement request schemas (docs/api.md §Phase 05). The backend is the
 * authoritative validation boundary; the client mirrors these shapes.
 *
 * `quantity` accepts an optional leading sign so an `ADJUSTMENT` can be a signed
 * correction; the type-specific sign/zero rules (IN/OUT/DAMAGED_LOST must be
 * > 0, ADJUSTMENT must be ≠ 0) live in one place — `stock/math.ts` `signedDelta`
 * — so we don't duplicate that logic here. Value is normalized to a string to
 * preserve numeric(12,3) precision end-to-end (JSON floats are lossy, ADR-008).
 */

export const movementTypeSchema = z.enum(["IN", "OUT", "ADJUSTMENT", "DAMAGED_LOST"]);

const movementQuantitySchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === "number" ? value.toString() : value.trim()))
  .refine((s) => /^-?\d{1,9}(\.\d{1,3})?$/.test(s), {
    message: "Must be a number with up to 3 decimal places.",
  });

export const recordMovementSchema = z.object({
  type: movementTypeSchema,
  quantity: movementQuantitySchema,
  // Accepts a string, `null`, or omission — the client sends `null` for a blank
  // reason (matching the `"reason": … | null` contract in docs/api.md and the
  // `.nullish()` convention used across the product schemas). The service
  // normalizes `null`/`undefined` to a stored `null`.
  reason: z.string().trim().max(500).nullish(),
});

export const movementParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Global movement-history query (docs/api.md §Phase 08). Every filter is
 * optional and combinable, applied in the DB so pagination `meta` stays correct.
 * `productId` scopes to one product; `type` to one movement type; `from`/`to`
 * bound the `createdAt` range (ISO-8601, coerced to Date). Owner-scoping is
 * enforced in the repository, never taken from the query.
 */
export const listMovementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  productId: z.string().uuid().optional(),
  type: movementTypeSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type RecordMovementBody = z.infer<typeof recordMovementSchema>;
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
