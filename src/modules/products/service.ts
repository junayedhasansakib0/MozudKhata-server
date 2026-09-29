import { AppError } from "../../lib/errors";
import * as categoryRepo from "../categories/repository";
import * as repo from "./repository";
import type { ProductWithCategory } from "./repository";
import type { CreateProductInput, ListProductsQuery, UpdateProductInput } from "./schema";
import { deriveStockStatus, type StockStatus } from "./status";

/**
 * Product business rules (docs/api.md §Phase 04). Owner-scoping is enforced in
 * the repository (ADR-002). This layer validates category ownership + SKU
 * uniqueness, derives stock status, applies soft-delete (archive/restore,
 * ADR-009), and shapes the client-facing response. It NEVER changes
 * `products.quantity` — that is the stock service's job alone (ADR-004).
 */

/** Minimal category reference embedded in a product response. */
export interface CategorySummary {
  id: string;
  name: string;
}

/** Client-facing product shape. Decimals are strings (docs/api.md §1). */
export interface PublicProduct {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  categoryId: string | null;
  category: CategorySummary | null;
  quantity: string;
  lowStockThreshold: string;
  stockStatus: StockStatus;
  description: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPublicProduct(p: ProductWithCategory): PublicProduct {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    unit: p.unit,
    categoryId: p.categoryId,
    category: p.category ? { id: p.category.id, name: p.category.name } : null,
    quantity: p.quantity.toString(),
    lowStockThreshold: p.lowStockThreshold.toString(),
    stockStatus: deriveStockStatus(p.quantity, p.lowStockThreshold),
    description: p.description,
    archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export interface PaginatedProducts {
  products: PublicProduct[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export async function listProducts(
  ownerId: string,
  query: ListProductsQuery,
): Promise<PaginatedProducts> {
  const { page, pageSize, includeArchived, q, categoryId, stockStatus, sort, order } = query;
  const { items, total } = await repo.listProductsPageForOwner(ownerId, {
    page,
    pageSize,
    includeArchived,
    q,
    categoryId,
    stockStatus,
    sort,
    order,
  });
  return {
    products: items.map(toPublicProduct),
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

async function getOwnedProductOrThrow(ownerId: string, id: string): Promise<ProductWithCategory> {
  const product = await repo.findProductByIdForOwner(ownerId, id);
  if (!product) {
    throw new AppError("NOT_FOUND", "Product not found.");
  }
  return product;
}

export async function getProduct(ownerId: string, id: string): Promise<PublicProduct> {
  return toPublicProduct(await getOwnedProductOrThrow(ownerId, id));
}

// A product may only reference a live category the caller owns.
async function assertCategoryAssignable(ownerId: string, categoryId: string): Promise<void> {
  const category = await categoryRepo.findCategoryByIdForOwner(ownerId, categoryId);
  if (!category) {
    throw new AppError("VALIDATION_ERROR", "Category not found.", [
      { path: "categoryId", message: "Category not found." },
    ]);
  }
  if (category.archivedAt) {
    throw new AppError("VALIDATION_ERROR", "Cannot assign an archived category.", [
      { path: "categoryId", message: "Category is archived." },
    ]);
  }
}

async function assertSkuAvailable(ownerId: string, sku: string, exceptId?: string): Promise<void> {
  const existing = await repo.findProductBySkuForOwner(ownerId, sku);
  if (existing && existing.id !== exceptId) {
    throw new AppError("CONFLICT", "A product with this SKU already exists.");
  }
}

export async function createProduct(
  ownerId: string,
  input: CreateProductInput,
): Promise<PublicProduct> {
  if (input.categoryId) {
    await assertCategoryAssignable(ownerId, input.categoryId);
  }
  if (input.sku) {
    await assertSkuAvailable(ownerId, input.sku);
  }
  const product = await repo.createProduct({
    ownerId,
    name: input.name,
    categoryId: input.categoryId ?? null,
    sku: input.sku ?? null,
    unit: input.unit,
    lowStockThreshold: input.lowStockThreshold,
    description: input.description ?? null,
  });
  return toPublicProduct(product);
}

export async function updateProduct(
  ownerId: string,
  id: string,
  input: UpdateProductInput,
): Promise<PublicProduct> {
  await getOwnedProductOrThrow(ownerId, id);

  if (input.categoryId) {
    await assertCategoryAssignable(ownerId, input.categoryId);
  }
  if (input.sku) {
    await assertSkuAvailable(ownerId, input.sku, id);
  }

  // Pass through only the provided fields (archivedAt/quantity are never here).
  const updated = await repo.updateProductForOwner(ownerId, id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
    ...(input.sku !== undefined ? { sku: input.sku } : {}),
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.lowStockThreshold !== undefined
      ? { lowStockThreshold: input.lowStockThreshold }
      : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (!updated) throw new AppError("NOT_FOUND", "Product not found.");
  return toPublicProduct(updated);
}

export async function archiveProduct(ownerId: string, id: string): Promise<PublicProduct> {
  await getOwnedProductOrThrow(ownerId, id);
  const updated = await repo.updateProductForOwner(ownerId, id, { archivedAt: new Date() });
  if (!updated) throw new AppError("NOT_FOUND", "Product not found.");
  return toPublicProduct(updated);
}

export async function restoreProduct(ownerId: string, id: string): Promise<PublicProduct> {
  await getOwnedProductOrThrow(ownerId, id);
  const updated = await repo.updateProductForOwner(ownerId, id, { archivedAt: null });
  if (!updated) throw new AppError("NOT_FOUND", "Product not found.");
  return toPublicProduct(updated);
}
