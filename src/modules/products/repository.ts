import type { Prisma, Product } from "@prisma/client";
import { prisma } from "../../lib/db";

/**
 * Data access for products. Every function is **owner-scoped** (ADR-002). This
 * file never writes `quantity` — that column is a cache maintained only by the
 * stock service's transaction (ADR-004, modules/stock). Business rules live in
 * the service layer (Phase 04); this is Prisma access only (AGENTS.md §5).
 */

/** Product joined with its (nullable) category — the shape reads/lists return. */
export type ProductWithCategory = Prisma.ProductGetPayload<{ include: { category: true } }>;

const withCategory = { category: true } as const;

export interface NewProduct {
  ownerId: string;
  name: string;
  categoryId?: string | null;
  sku?: string | null;
  unit?: string;
  lowStockThreshold?: Prisma.Decimal | number | string;
  description?: string | null;
}

export function createProduct(data: NewProduct): Promise<ProductWithCategory> {
  return prisma.product.create({
    data: {
      ownerId: data.ownerId,
      name: data.name,
      categoryId: data.categoryId ?? null,
      sku: data.sku ?? null,
      unit: data.unit ?? "pcs",
      lowStockThreshold: data.lowStockThreshold ?? 0,
      description: data.description ?? null,
    },
    include: withCategory,
  });
}

export function findProductByIdForOwner(
  ownerId: string,
  id: string,
): Promise<ProductWithCategory | null> {
  return prisma.product.findFirst({ where: { id, ownerId }, include: withCategory });
}

export function findProductBySkuForOwner(ownerId: string, sku: string): Promise<Product | null> {
  return prisma.product.findFirst({ where: { ownerId, sku } });
}

/**
 * Build the `where` fragment for a stock-status filter. Stock status is DERIVED
 * (never stored), so we express the exact `deriveStockStatus` buckets in SQL via
 * Prisma **field references** (column-to-column comparison) — keeping the filter
 * in the database so pagination/counts stay correct (no in-memory filtering).
 * `low_stock_threshold` is CHECK-constrained `>= 0`, so `quantity > threshold`
 * already implies `quantity > 0` (IN_STOCK). Mirrors `status.ts` exactly.
 */
function stockStatusWhere(status?: "IN_STOCK" | "LOW" | "OUT"): Prisma.ProductWhereInput {
  switch (status) {
    case "OUT":
      return { quantity: { lte: 0 } };
    case "LOW":
      return { quantity: { gt: 0, lte: prisma.product.fields.lowStockThreshold } };
    case "IN_STOCK":
      return { quantity: { gt: prisma.product.fields.lowStockThreshold } };
    default:
      return {};
  }
}

export interface ListProductsOptions {
  page: number;
  pageSize: number;
  includeArchived?: boolean;
  q?: string;
  categoryId?: string;
  stockStatus?: "IN_STOCK" | "LOW" | "OUT";
  sort?: "name" | "createdAt" | "updatedAt" | "quantity";
  order?: "asc" | "desc";
}

/**
 * A page of products (owner-scoped) with total count. Phase 06 adds search
 * (name/SKU), category + stock-status filters, and a sort allowlist — all pushed
 * into the DB query so pagination stays correct. Search uses a case-insensitive
 * `contains`; the existing `@@index([ownerId, name])` bounds the scan (a trigram
 * index for substring search is deferred — see ADR-023).
 */
export async function listProductsPageForOwner(
  ownerId: string,
  options: ListProductsOptions,
): Promise<{ items: ProductWithCategory[]; total: number }> {
  const { page, pageSize, includeArchived, q, categoryId, stockStatus } = options;
  const sort = options.sort ?? "name";
  const order = options.order ?? "asc";

  const where: Prisma.ProductWhereInput = {
    ownerId,
    ...(includeArchived ? {} : { archivedAt: null }),
    ...(categoryId ? { categoryId } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { sku: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...stockStatusWhere(stockStatus),
  };

  // Sort by the chosen column, then `id` as a stable tiebreaker so a page never
  // drops or repeats a row when the sort values collide.
  const orderBy: Prisma.ProductOrderByWithRelationInput[] = [{ [sort]: order }, { id: "asc" }];

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: withCategory,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  return { items, total };
}

/** Update non-stock fields. `quantity` is intentionally not updatable here. */
export async function updateProductForOwner(
  ownerId: string,
  id: string,
  data: {
    name?: string;
    categoryId?: string | null;
    sku?: string | null;
    unit?: string;
    lowStockThreshold?: Prisma.Decimal | number | string;
    description?: string | null;
    archivedAt?: Date | null;
  },
): Promise<ProductWithCategory | null> {
  const result = await prisma.product.updateMany({ where: { id, ownerId }, data });
  if (result.count === 0) return null;
  return prisma.product.findFirst({ where: { id, ownerId }, include: withCategory });
}
