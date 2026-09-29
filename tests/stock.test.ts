import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/errors";

// In-memory stand-in for the stock repository. It reproduces the repository's
// transactional contract (owner-scoped product lookup + the real non-negative
// balance check) without a live DB, so the service's invariants are exercised
// end-to-end. JS is single-threaded here, so sequential calls model the
// serialized, row-locked writes the real transaction guarantees.
const store = vi.hoisted(() => ({
  products: new Map<string, { ownerId: string; quantity: string; archived: boolean }>(),
  movements: [] as Array<{
    id: string;
    ownerId: string;
    productId: string;
    actorId: string;
    type: string;
    quantityDelta: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
    reason: string | null;
    createdAt: Date;
  }>,
  seq: { n: 0 },
}));

vi.mock("../src/modules/stock/repository", async () => {
  const { Prisma } = await import("@prisma/client");
  const { AppError } = await import("../src/lib/errors");
  const { nextBalanceOrThrow } = await import("../src/modules/stock/math");
  return {
    applyStockMovement: async (input: {
      ownerId: string;
      productId: string;
      actorId: string;
      type: string;
      delta: Prisma.Decimal;
      reason?: string | null;
    }) => {
      const product = store.products.get(input.productId);
      if (!product || product.ownerId !== input.ownerId || product.archived) {
        throw new AppError("NOT_FOUND", "Product not found.");
      }
      const balanceAfter = nextBalanceOrThrow(new Prisma.Decimal(product.quantity), input.delta);
      const movement = {
        id: `mov-${(store.seq.n += 1)}`,
        ownerId: input.ownerId,
        productId: input.productId,
        actorId: input.actorId,
        type: input.type,
        quantityDelta: input.delta,
        balanceAfter,
        reason: input.reason ?? null,
        createdAt: new Date(store.seq.n),
      };
      product.quantity = balanceAfter.toString();
      store.movements.push(movement);
      return movement;
    },
    listMovementsForProduct: async (ownerId: string, productId: string) =>
      store.movements
        .filter((m) => m.ownerId === ownerId && m.productId === productId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
});

// Imported after the mock is registered (Vitest hoists `vi.mock` above imports).
import { listProductMovements, recordMovement } from "../src/modules/stock/service";

const OWNER = "owner-1";
const OTHER_OWNER = "owner-2";
const PRODUCT = "prod-1";

beforeEach(() => {
  store.products.clear();
  store.movements.length = 0;
  store.seq.n = 0;
  store.products.set(PRODUCT, { ownerId: OWNER, quantity: "0", archived: false });
});

describe("recordMovement", () => {
  it("keeps the cached quantity equal to the ledger sum across a sequence", async () => {
    await recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "IN", quantity: 100 });
    await recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "OUT", quantity: 30 });
    await recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "ADJUSTMENT", quantity: -5 });
    const last = await recordMovement({
      ownerId: OWNER,
      productId: PRODUCT,
      actorId: OWNER,
      type: "DAMAGED_LOST",
      quantity: 10,
    });

    // Ledger sum of signed deltas.
    const ledgerSum = store.movements.reduce(
      (sum, m) => sum.plus(m.quantityDelta),
      new Prisma.Decimal(0),
    );

    expect(ledgerSum.toString()).toBe("55"); // 100 - 30 - 5 - 10
    expect(last.balanceAfter).toBe("55"); // last balance_after
    expect(store.products.get(PRODUCT)!.quantity).toBe("55"); // cached quantity
  });

  it("supports fractional quantities without float drift", async () => {
    await recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "IN", quantity: "2.505" });
    const out = await recordMovement({
      ownerId: OWNER,
      productId: PRODUCT,
      actorId: OWNER,
      type: "OUT",
      quantity: "0.005",
    });
    expect(out.balanceAfter).toBe("2.5");
  });

  it("rejects removing more stock than is available (no negative stock)", async () => {
    await recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "IN", quantity: 10 });
    await expect(
      recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "OUT", quantity: 20 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // The cache is unchanged by the rejected movement.
    expect(store.products.get(PRODUCT)!.quantity).toBe("10");
  });

  it("rejects a non-positive IN quantity with a validation error", async () => {
    await expect(
      recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "IN", quantity: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("never returns another owner's product (NOT_FOUND, owner isolation)", async () => {
    await expect(
      recordMovement({ ownerId: OTHER_OWNER, productId: PRODUCT, actorId: OTHER_OWNER, type: "IN", quantity: 5 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not mutate stock for an archived product", async () => {
    store.products.set(PRODUCT, { ownerId: OWNER, quantity: "5", archived: true });
    await expect(
      recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "IN", quantity: 5 }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("listProductMovements", () => {
  it("returns the owner's movements newest-first", async () => {
    await recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "IN", quantity: 10 });
    await recordMovement({ ownerId: OWNER, productId: PRODUCT, actorId: OWNER, type: "OUT", quantity: 4 });
    const history = await listProductMovements(OWNER, PRODUCT);
    expect(history.map((m) => m.type)).toEqual(["OUT", "IN"]);
    expect(history[0]!.balanceAfter).toBe("6");
  });
});
