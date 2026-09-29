import { Prisma } from "@prisma/client";

/** Derived stock status (docs/database.md §2) — never stored, always computed. */
export type StockStatus = "IN_STOCK" | "LOW" | "OUT";

/**
 * Derive a product's stock status from its cached quantity and low-stock
 * threshold. Pure and Decimal-safe (no float comparisons):
 * `quantity == 0` → OUT; `0 < quantity <= threshold` → LOW; otherwise IN_STOCK.
 * With a threshold of 0, any positive quantity is IN_STOCK.
 */
export function deriveStockStatus(
  quantity: Prisma.Decimal | number | string,
  lowStockThreshold: Prisma.Decimal | number | string,
): StockStatus {
  const q = new Prisma.Decimal(quantity);
  const threshold = new Prisma.Decimal(lowStockThreshold);
  if (q.lessThanOrEqualTo(0)) return "OUT";
  if (q.lessThanOrEqualTo(threshold)) return "LOW";
  return "IN_STOCK";
}
