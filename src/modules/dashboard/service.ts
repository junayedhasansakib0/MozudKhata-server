import { Prisma, type MovementType } from "@prisma/client";
import * as repo from "./repository";

/**
 * Dashboard service — shapes the owner's aggregate metrics into the public,
 * JSON-safe response (docs/api.md §Phase 07). Decimals are serialized as
 * **strings** and timestamps as ISO-8601, matching the rest of the API
 * (ADR-008/ADR-024). No business writes here; the dashboard is read-only.
 */

/** How many recent movements the activity feed returns (fixed; ADR-024). */
const RECENT_ACTIVITY_LIMIT = 8;

/** One entry in the recent-activity feed (a ledger movement + product name). */
export interface DashboardActivity {
  id: string;
  productId: string;
  productName: string;
  type: MovementType;
  quantityDelta: string;
  balanceAfter: string;
  reason: string | null;
  createdAt: string;
}

/** The full dashboard payload returned by `GET /api/v1/dashboard`. */
export interface DashboardMetrics {
  totalProducts: number;
  totalStockUnits: string;
  lowStockCount: number;
  outOfStockCount: number;
  categoryCount: number;
  recentActivity: DashboardActivity[];
}

export async function getDashboard(ownerId: string): Promise<DashboardMetrics> {
  const agg = await repo.getDashboardForOwner(ownerId, RECENT_ACTIVITY_LIMIT);

  return {
    totalProducts: agg.totalProducts,
    totalStockUnits: (agg.totalStockUnits ?? new Prisma.Decimal(0)).toString(),
    lowStockCount: agg.lowStockCount,
    outOfStockCount: agg.outOfStockCount,
    categoryCount: agg.categoryCount,
    recentActivity: agg.recentMovements.map((m) => ({
      id: m.id,
      productId: m.productId,
      productName: m.product.name,
      type: m.type,
      quantityDelta: m.quantityDelta.toString(),
      balanceAfter: m.balanceAfter.toString(),
      reason: m.reason,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}
