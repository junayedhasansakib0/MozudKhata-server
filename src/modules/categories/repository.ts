import type { Category } from "@prisma/client";
import { prisma } from "../../lib/db";

/**
 * Data access for categories. Every function is **owner-scoped** — the caller's
 * `ownerId` is part of every filter so one owner can never read or mutate
 * another's rows (ADR-002). Business rules live in the service layer (Phase 04);
 * this file is Prisma access only (AGENTS.md §5).
 */

export function createCategory(data: { ownerId: string; name: string }): Promise<Category> {
  return prisma.category.create({ data: { ownerId: data.ownerId, name: data.name } });
}

export function findCategoryByIdForOwner(
  ownerId: string,
  id: string,
): Promise<Category | null> {
  return prisma.category.findFirst({ where: { id, ownerId } });
}

export function findCategoryByNameForOwner(
  ownerId: string,
  name: string,
): Promise<Category | null> {
  return prisma.category.findFirst({ where: { ownerId, name } });
}

/** Live (non-archived) categories for an owner, alphabetical. */
export function listCategoriesForOwner(
  ownerId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Category[]> {
  return prisma.category.findMany({
    where: { ownerId, ...(options.includeArchived ? {} : { archivedAt: null }) },
    orderBy: { name: "asc" },
  });
}

export async function updateCategoryForOwner(
  ownerId: string,
  id: string,
  data: { name?: string; archivedAt?: Date | null },
): Promise<Category | null> {
  const result = await prisma.category.updateMany({ where: { id, ownerId }, data });
  if (result.count === 0) return null;
  return prisma.category.findFirst({ where: { id, ownerId } });
}
