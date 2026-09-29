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
  reason: z.string().trim().max(500).optional(),
});

export const movementParamsSchema = z.object({
  id: z.string().uuid(),
});

export type RecordMovementBody = z.infer<typeof recordMovementSchema>;
