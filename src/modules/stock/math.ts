import { Prisma, type MovementType } from "@prisma/client";
import { AppError } from "../../lib/errors";

/**
 * Pure stock arithmetic (no I/O), so the core invariants are unit-testable
 * without a database and reused verbatim inside the stock service transaction.
 * All values are `Prisma.Decimal` — quantities are numeric(12,3), never floats
 * (ADR-008).
 */

/**
 * Convert a movement type + input magnitude into the signed delta applied to a
 * product's quantity:
 *   - `IN`            → `+quantity` (adds stock)
 *   - `OUT`           → `-quantity` (removes stock)
 *   - `DAMAGED_LOST`  → `-quantity` (shrinkage)
 *   - `ADJUSTMENT`    → `quantity` as-is (a signed correction, may be + or -)
 *
 * For `IN`/`OUT`/`DAMAGED_LOST` the magnitude must be strictly positive; an
 * `ADJUSTMENT` must be non-zero. Invalid inputs raise a validation error.
 */
export function signedDelta(type: MovementType, quantity: Prisma.Decimal): Prisma.Decimal {
  if (quantity.isNaN() || !quantity.isFinite()) {
    throw new AppError("VALIDATION_ERROR", "Quantity must be a valid number.", [
      { path: "quantity", message: "Quantity must be a valid number." },
    ]);
  }

  switch (type) {
    case "IN":
    case "OUT":
    case "DAMAGED_LOST":
      if (quantity.lessThanOrEqualTo(0)) {
        throw new AppError("VALIDATION_ERROR", "Quantity must be greater than zero.", [
          { path: "quantity", message: "Quantity must be greater than zero." },
        ]);
      }
      return type === "IN" ? quantity : quantity.negated();
    case "ADJUSTMENT":
      if (quantity.isZero()) {
        throw new AppError("VALIDATION_ERROR", "Adjustment quantity must not be zero.", [
          { path: "quantity", message: "Adjustment quantity must not be zero." },
        ]);
      }
      return quantity;
    default: {
      // Exhaustiveness guard — a new MovementType must be handled explicitly.
      const _never: never = type;
      throw new AppError("VALIDATION_ERROR", `Unsupported movement type: ${String(_never)}.`);
    }
  }
}

/**
 * Apply a signed delta to the current balance, enforcing the non-negative-stock
 * invariant. Returns the new balance, or throws `CONFLICT` if it would drop
 * below zero. Called inside the stock service transaction *after* the product
 * row is locked, so the check is race-free.
 */
export function nextBalanceOrThrow(
  current: Prisma.Decimal,
  delta: Prisma.Decimal,
): Prisma.Decimal {
  const balance = current.plus(delta);
  if (balance.isNegative()) {
    throw new AppError(
      "CONFLICT",
      "Insufficient stock: this movement would drop the quantity below zero.",
      [{ path: "quantity", message: "Not enough stock available for this movement." }],
    );
  }
  return balance;
}
