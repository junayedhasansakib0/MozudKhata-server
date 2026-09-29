import { Prisma, type MovementType, type StockMovement } from "@prisma/client";
import * as repo from "./repository";
import { signedDelta } from "./math";

/**
 * The transactional stock-change service — the ONLY entry point for mutating
 * stock (ADR-004, AGENTS.md §1). It derives the signed delta from the movement
 * type, then delegates to the repository's locked transaction which enforces
 * the non-negative-stock invariant and keeps `products.quantity` consistent
 * with the ledger. Business errors surface as `AppError`.
 */

export interface RecordMovementInput {
  ownerId: string;
  productId: string;
  actorId: string;
  type: MovementType;
  /**
   * Magnitude for `IN`/`OUT`/`DAMAGED_LOST` (must be > 0); a signed correction
   * for `ADJUSTMENT` (must be ≠ 0). Accepts Decimal/number/string; coerced to a
   * numeric(12,3)-safe `Prisma.Decimal`.
   */
  quantity: Prisma.Decimal | number | string;
  reason?: string | null;
}

/** Ledger movement shape safe to return to clients (Decimals as strings). */
export interface PublicMovement {
  id: string;
  productId: string;
  type: MovementType;
  quantityDelta: string;
  balanceAfter: string;
  reason: string | null;
  actorId: string;
  createdAt: string;
}

function toPublicMovement(m: StockMovement): PublicMovement {
  return {
    id: m.id,
    productId: m.productId,
    type: m.type,
    quantityDelta: m.quantityDelta.toString(),
    balanceAfter: m.balanceAfter.toString(),
    reason: m.reason,
    actorId: m.actorId,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function recordMovement(input: RecordMovementInput): Promise<PublicMovement> {
  const quantity = new Prisma.Decimal(input.quantity);
  const delta = signedDelta(input.type, quantity);

  const movement = await repo.applyStockMovement({
    ownerId: input.ownerId,
    productId: input.productId,
    actorId: input.actorId,
    type: input.type,
    delta,
    reason: input.reason ?? null,
  });

  return toPublicMovement(movement);
}

export async function listProductMovements(
  ownerId: string,
  productId: string,
): Promise<PublicMovement[]> {
  const movements = await repo.listMovementsForProduct(ownerId, productId);
  return movements.map(toPublicMovement);
}
