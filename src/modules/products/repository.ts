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

/** A page of products (owner-scoped), newest name-sorted, with total count. */
export async function listProductsPageForOwner(
  ownerId: string,
  options: { page: number; pageSize: number; includeArchived?: boolean },
): Promise<{ items: ProductWithCategory[]; total: number }> {
  const where: Prisma.ProductWhereInput = {
    ownerId,
    ...(options.includeArchived ? {} : { archivedAt: null }),
  };
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: withCategory,
      orderBy: { name: "asc" },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
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
