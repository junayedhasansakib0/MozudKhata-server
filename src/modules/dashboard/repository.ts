import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/db";
import { stockStatusWhere } from "../products/repository";

/**
 * Data access for the dashboard. All reads are **owner-scoped** (ADR-002) and
 * run purely as aggregate queries over the existing Phase 03/04 tables — no
 * schema change, no stored metrics (ADR-024). The LOW/OUT counts reuse the
 * exact field-reference SQL buckets from the products repository so derived
 * stock status stays a single source of truth (ADR-004/ADR-020).
 */

/** A recent movement joined with its product's name (for the activity feed). */
export type RecentMovement = Prisma.StockMovementGetPayload<{
  include: { product: { select: { name: true } } };
}>;

export interface DashboardAggregates {
  totalProducts: number;
  lowStockCount: number;
  outOfStockCount: number;
  categoryCount: number;
  /** `null` when the owner has no live products (Prisma `_sum` on empty set). */
  totalStockUnits: Prisma.Decimal | null;
  recentMovements: RecentMovement[];
}

/**
 * Compute every dashboard metric for one owner in parallel. Counts/sum are over
 * *live* (non-archived) products; the category count is over live categories.
 * Recent activity spans all of the owner's movements (archived products still
 * have real ledger history) newest-first, capped at `recentLimit`. The counts
 * ride `@@index([ownerId, ...])`; recent activity rides
 * `@@index([ownerId, createdAt(sort: Desc)])`, so all queries stay index-bound.
 */
export async function getDashboardForOwner(
  ownerId: string,
  recentLimit: number,
): Promise<DashboardAggregates> {
  const liveProducts: Prisma.ProductWhereInput = { ownerId, archivedAt: null };

  const [totalProducts, lowStockCount, outOfStockCount, categoryCount, sum, recentMovements] =
    await Promise.all([
      prisma.product.count({ where: liveProducts }),
      prisma.product.count({ where: { ...liveProducts, ...stockStatusWhere("LOW") } }),
      prisma.product.count({ where: { ...liveProducts, ...stockStatusWhere("OUT") } }),
      prisma.category.count({ where: { ownerId, archivedAt: null } }),
      prisma.product.aggregate({ where: liveProducts, _sum: { quantity: true } }),
      prisma.stockMovement.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        take: recentLimit,
        include: { product: { select: { name: true } } },
      }),
    ]);

  return {
    totalProducts,
    lowStockCount,
    outOfStockCount,
    categoryCount,
    totalStockUnits: sum._sum.quantity,
    recentMovements,
  };
}
