/**
 * Dev-only seed (docs/database.md §6). Creates a sample owner with a few
 * categories and products, and gives each product an opening stock balance
 * through the stock service — so the seeded ledger and cached quantities stay
 * consistent exactly like production writes. Safe to re-run: the owner and
 * catalog are upserted, and opening movements are only recorded for products
 * that were newly created.
 *
 * Run with `npm run db:seed` against a real DATABASE_URL. Never run in prod.
 */
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { recordMovement } from "../src/modules/stock/service";

const SAMPLE_EMAIL = "demo@mozudkhata.local";

async function ensureCategory(ownerId: string, name: string): Promise<string> {
  const existing = await prisma.category.findFirst({ where: { ownerId, name } });
  if (existing) return existing.id;
  const created = await prisma.category.create({ data: { ownerId, name } });
  return created.id;
}

async function ensureProduct(
  ownerId: string,
  data: { name: string; categoryId: string; sku: string; unit?: string; lowStockThreshold?: number },
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.product.findFirst({ where: { ownerId, sku: data.sku } });
  if (existing) return { id: existing.id, created: false };
  const created = await prisma.product.create({
    data: {
      ownerId,
      name: data.name,
      categoryId: data.categoryId,
      sku: data.sku,
      unit: data.unit ?? "pcs",
      lowStockThreshold: data.lowStockThreshold ?? 0,
    },
  });
  return { id: created.id, created: true };
}

async function main(): Promise<void> {
  const owner = await prisma.user.upsert({
    where: { email: SAMPLE_EMAIL },
    update: {},
    create: {
      email: SAMPLE_EMAIL,
      name: "Demo Owner",
      passwordHash: await hashPassword("demo-password-123"),
    },
  });

  const beverages = await ensureCategory(owner.id, "Beverages");
  const snacks = await ensureCategory(owner.id, "Snacks");

  const catalog = [
    { name: "Cola 500ml", categoryId: beverages, sku: "BEV-COLA-500", opening: 120, lowStockThreshold: 24 },
    { name: "Sparkling Water 1L", categoryId: beverages, sku: "BEV-WATER-1L", opening: 60, lowStockThreshold: 12 },
    { name: "Potato Chips 150g", categoryId: snacks, sku: "SNK-CHIPS-150", opening: 40, lowStockThreshold: 10 },
  ];

  for (const item of catalog) {
    const { id, created } = await ensureProduct(owner.id, {
      name: item.name,
      categoryId: item.categoryId,
      sku: item.sku,
      lowStockThreshold: item.lowStockThreshold,
    });
    if (created) {
      await recordMovement({
        ownerId: owner.id,
        productId: id,
        actorId: owner.id,
        type: "IN",
        quantity: item.opening,
        reason: "Opening stock (seed)",
      });
    }
  }

  const productCount = await prisma.product.count({ where: { ownerId: owner.id } });
  console.log(`Seed complete: owner ${SAMPLE_EMAIL} with ${productCount} products.`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
