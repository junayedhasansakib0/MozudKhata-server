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

    // Defense-in-depth: scope the cache write to the owner's live product too.
    // The row above is already ownership-checked and FOR UPDATE-locked, so this
    // is belt-and-suspenders — it binds the sole quantity write to `ownerId` so a
    // cross-owner update stays impossible even if the guard above is ever
    // refactored. `updateMany` lets us add `ownerId` to the `where` (a plain
    // `update` cannot) and returns the affected count.
    const { count } = await tx.product.updateMany({
      where: { id: input.productId, ownerId: input.ownerId, archivedAt: null },
      data: { quantity: balanceAfter },
    });
    if (count !== 1) {
      throw new AppError("NOT_FOUND", "Product not found.");
    }

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

/** A ledger movement joined with its product's current name (global history). */
export type MovementWithProduct = Prisma.StockMovementGetPayload<{
  include: { product: { select: { name: true } } };
}>;

export interface ListMovementsOptions {
  page: number;
  pageSize: number;
  productId?: string;
  type?: MovementType;
  from?: Date;
  to?: Date;
}

/**
 * A page of the owner's stock movements across all products (Phase 08 global
 * history), newest first, with total count. Optional filters (product, type,
 * created-at range) are pushed into the query so pagination `meta` stays
 * correct. Owner-scoped (ADR-002); rides `@@index([ownerId, createdAt desc])`,
 * with a stable `id` tiebreaker so a page never drops or repeats a row.
 */
export async function listMovementsForOwner(
  ownerId: string,
  options: ListMovementsOptions,
): Promise<{ items: MovementWithProduct[]; total: number }> {
  const { page, pageSize, productId, type, from, to } = options;

  const where: Prisma.StockMovementWhereInput = {
    ownerId,
    ...(productId ? { productId } : {}),
    ...(type ? { type } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { product: { select: { name: true } } },
    }),
    prisma.stockMovement.count({ where }),
  ]);

  return { items, total };
}
