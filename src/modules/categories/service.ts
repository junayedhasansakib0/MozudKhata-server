import type { Category } from "@prisma/client";
import { AppError } from "../../lib/errors";
import * as repo from "./repository";
import type { CreateCategoryInput, UpdateCategoryInput } from "./schema";

/**
 * Category business rules (docs/api.md §Phase 04). Owner-scoping is enforced in
 * the repository (ADR-002); this layer adds uniqueness checks, soft-delete
 * (archive/restore, ADR-009), and shapes the client-facing response. No stock
 * concerns here — categories are pure metadata.
 */

/** Client-facing category shape (dates as ISO strings). */
export interface PublicCategory {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPublicCategory(c: Category): PublicCategory {
  return {
    id: c.id,
    name: c.name,
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function listCategories(
  ownerId: string,
  options: { includeArchived?: boolean } = {},
): Promise<PublicCategory[]> {
  const categories = await repo.listCategoriesForOwner(ownerId, options);
  return categories.map(toPublicCategory);
}

async function getOwnedCategoryOrThrow(ownerId: string, id: string): Promise<Category> {
  const category = await repo.findCategoryByIdForOwner(ownerId, id);
  if (!category) {
    throw new AppError("NOT_FOUND", "Category not found.");
  }
  return category;
}

export async function getCategory(ownerId: string, id: string): Promise<PublicCategory> {
  return toPublicCategory(await getOwnedCategoryOrThrow(ownerId, id));
}

export async function createCategory(
  ownerId: string,
  input: CreateCategoryInput,
): Promise<PublicCategory> {
  // Name is unique per owner (includes archived rows — the DB guarantees it too).
  const existing = await repo.findCategoryByNameForOwner(ownerId, input.name);
  if (existing) {
    throw new AppError("CONFLICT", "A category with this name already exists.");
  }
  return toPublicCategory(await repo.createCategory({ ownerId, name: input.name }));
}

export async function renameCategory(
  ownerId: string,
  id: string,
  input: UpdateCategoryInput,
): Promise<PublicCategory> {
  await getOwnedCategoryOrThrow(ownerId, id);
  const clash = await repo.findCategoryByNameForOwner(ownerId, input.name);
  if (clash && clash.id !== id) {
    throw new AppError("CONFLICT", "A category with this name already exists.");
  }
  const updated = await repo.updateCategoryForOwner(ownerId, id, { name: input.name });
  if (!updated) throw new AppError("NOT_FOUND", "Category not found.");
  return toPublicCategory(updated);
}

export async function archiveCategory(ownerId: string, id: string): Promise<PublicCategory> {
  await getOwnedCategoryOrThrow(ownerId, id);
  const updated = await repo.updateCategoryForOwner(ownerId, id, { archivedAt: new Date() });
  if (!updated) throw new AppError("NOT_FOUND", "Category not found.");
  return toPublicCategory(updated);
}

export async function restoreCategory(ownerId: string, id: string): Promise<PublicCategory> {
  await getOwnedCategoryOrThrow(ownerId, id);
  const updated = await repo.updateCategoryForOwner(ownerId, id, { archivedAt: null });
  if (!updated) throw new AppError("NOT_FOUND", "Category not found.");
  return toPublicCategory(updated);
}
