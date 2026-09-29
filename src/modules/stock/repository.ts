import { Prisma, type MovementType, type StockMovement } from "@prisma/client";
import { prisma } from "../../lib/db";
import { AppError } from "../../lib/errors";
import { nextBalanceOrThrow } from "./math";

/**
 * Data access for the append-only stock ledger. The single write path,
 * `applyStockMovement`, is the ONLY place `products.quantity` is ever written
 * (ADR-004). It runs an interactive transaction that locks the product row
 * (`SELECT … FOR UPDATE`) before computing the new balance, so concurrent
 * movements on the same product serialize and the cache can never diverge from
 * the ledger. Owner-scoped throughout (ADR-002).
 */

export interface ApplyMovementInput {
  ownerId: string;
  productId: string;
  actorId: string;
  type: MovementType;
  /** Already-signed change to apply (see stock/math.ts `signedDelta`). */
  delta: Prisma.Decimal;
  reason?: string | null;
}

export async function applyStockMovement(input: ApplyMovementInput): Promise<StockMovement> {
  return prisma.$transaction(async (tx) => {
    // Lock the owner's live product row; other movements on it wait here.
    const rows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>(
      Prisma.sql`SELECT "quantity" FROM "products"
                 WHERE "id" = ${input.productId}::uuid
                   AND "owner_id" = ${input.ownerId}::uuid
                   AND "archived_at" IS NULL
                 FOR UPDATE`,
    );

    if (rows.length === 0 || !rows[0]) {
      throw new AppError("NOT_FOUND", "Product not found.");
    }

    const current = new Prisma.Decimal(rows[0].quantity);
    const balanceAfter = nextBalanceOrThrow(current, input.delta);

    const movement = await tx.stockMovement.create({
      data: {
        ownerId: input.ownerId,
        productId: input.productId,
        actorId: input.actorId,
        type: input.type,
        quantityDelta: input.delta,
        balanceAfter,
        reason: input.reason ?? null,
      },
    });

    await tx.product.update({
      where: { id: input.productId },
      data: { quantity: balanceAfter },
    });

    return movement;
  });
}

/** Ledger history for one of the owner's products, newest first. */
export function listMovementsForProduct(
  ownerId: string,
  productId: string,
): Promise<StockMovement[]> {
  return prisma.stockMovement.findMany({
    where: { ownerId, productId },
    orderBy: { createdAt: "desc" },
  });
}
