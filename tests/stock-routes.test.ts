import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Shared in-memory stores (hoisted so the vi.mock factories can close over them),
// letting the full stack (routes → service → guard → CSRF) run without a live DB.
// The stock-repository mock writes the SAME `products` store the product-repo
// mock reads, so recording a movement moves the cached quantity exactly as the
// real transactional path would.
const h = vi.hoisted(() => {
  interface Prod {
    id: string;
    ownerId: string;
    categoryId: string | null;
    name: string;
    sku: string | null;
    unit: string;
    quantity: number | string;
    lowStockThreshold: number | string;
    description: string | null;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }
  interface Move {
    id: string;
    ownerId: string;
    productId: string;
    actorId: string;
    type: string;
    quantityDelta: unknown;
    balanceAfter: unknown;
    reason: string | null;
    createdAt: Date;
  }
  const store = {
    users: [] as Array<{ id: string; email: string; passwordHash: string; name: string | null; createdAt: Date; updatedAt: Date }>,
    sessions: [] as Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date | null; userAgent: string | null; ip: string | null }>,
    products: [] as Prod[],
    movements: [] as Move[],
  };
  const uuid = () => crypto.randomUUID();
  const joinCat = (p: Prod) => ({ ...p, category: null });
  // Strictly-increasing timestamps so newest-first ordering is deterministic.
  let seq = 0;
  const tick = () => new Date(Date.UTC(2026, 0, 1) + (seq += 1));
  return { store, uuid, joinCat, tick };
});

vi.mock("../src/modules/auth/repository", () => ({
  createUser: async (data: { email: string; passwordHash: string; name?: string | null }) => {
    const user = { id: h.uuid(), email: data.email, passwordHash: data.passwordHash, name: data.name ?? null, createdAt: new Date(), updatedAt: new Date() };
    h.store.users.push(user);
    return user;
  },
  findUserByEmail: async (email: string) => h.store.users.find((u) => u.email === email) ?? null,
  findUserById: async (id: string) => h.store.users.find((u) => u.id === id) ?? null,
  updateUserProfile: async () => undefined,
  updateUserPassword: async () => undefined,
  createSession: async (data: { userId: string; tokenHash: string; expiresAt: Date; userAgent?: string | null; ip?: string | null }) => {
    const s = { id: h.uuid(), userId: data.userId, tokenHash: data.tokenHash, expiresAt: data.expiresAt, createdAt: new Date(), lastUsedAt: null, userAgent: data.userAgent ?? null, ip: data.ip ?? null };
    h.store.sessions.push(s);
    return s;
  },
  findSessionByTokenHash: async (tokenHash: string) => {
    const s = h.store.sessions.find((x) => x.tokenHash === tokenHash);
    if (!s) return null;
    return { ...s, user: h.store.users.find((u) => u.id === s.userId)! };
  },
  touchSession: async (id: string, expiresAt: Date) => {
    const s = h.store.sessions.find((x) => x.id === id)!;
    s.expiresAt = expiresAt;
    return s;
  },
  deleteSession: async (id: string) => {
    h.store.sessions = h.store.sessions.filter((s) => s.id !== id);
  },
  deleteSessionByTokenHash: async () => undefined,
  deleteOtherUserSessions: async () => undefined,
  deleteAllUserSessions: async () => undefined,
}));

vi.mock("../src/modules/categories/repository", () => ({
  findCategoryByIdForOwner: async () => null,
}));

vi.mock("../src/modules/products/repository", () => ({
  createProduct: async (data: {
    ownerId: string;
    name: string;
    categoryId?: string | null;
    sku?: string | null;
    unit?: string;
    lowStockThreshold?: number | string;
    description?: string | null;
  }) => {
    const p = {
      id: h.uuid(),
      ownerId: data.ownerId,
      categoryId: data.categoryId ?? null,
      name: data.name,
      sku: data.sku ?? null,
      unit: data.unit ?? "pcs",
      quantity: 0,
      lowStockThreshold: data.lowStockThreshold ?? 0,
      description: data.description ?? null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    h.store.products.push(p);
    return h.joinCat(p);
  },
  findProductByIdForOwner: async (ownerId: string, id: string) => {
    const p = h.store.products.find((x) => x.id === id && x.ownerId === ownerId);
    return p ? h.joinCat(p) : null;
  },
  findProductBySkuForOwner: async () => null,
  listProductsPageForOwner: async () => ({ items: [], total: 0 }),
  updateProductForOwner: async (ownerId: string, id: string, data: Record<string, unknown>) => {
    const p = h.store.products.find((x) => x.id === id && x.ownerId === ownerId);
    if (!p) return null;
    Object.assign(p, data);
    return h.joinCat(p);
  },
}));

// Stock repository: replaces only the DB transaction. It reuses the real pure
// math (nextBalanceOrThrow) so the non-negative-stock invariant is authentic,
// and writes the cached quantity back into the shared product store.
vi.mock("../src/modules/stock/repository", async () => {
  const { Prisma } = await import("@prisma/client");
  const { nextBalanceOrThrow } = await import("../src/modules/stock/math");
  const { AppError } = await import("../src/lib/errors");
  return {
    applyStockMovement: async (input: {
      ownerId: string;
      productId: string;
      actorId: string;
      type: string;
      delta: InstanceType<typeof Prisma.Decimal>;
      reason?: string | null;
    }) => {
      const p = h.store.products.find(
        (x) => x.id === input.productId && x.ownerId === input.ownerId && x.archivedAt === null,
      );
      if (!p) throw new AppError("NOT_FOUND", "Product not found.");
      const balanceAfter = nextBalanceOrThrow(new Prisma.Decimal(p.quantity), input.delta);
      p.quantity = balanceAfter.toString();
      const movement = {
        id: h.uuid(),
        ownerId: input.ownerId,
        productId: input.productId,
        actorId: input.actorId,
        type: input.type,
        quantityDelta: input.delta,
        balanceAfter,
        reason: input.reason ?? null,
        createdAt: h.tick(),
      };
      h.store.movements.push(movement);
      return movement;
    },
    listMovementsForProduct: async (ownerId: string, productId: string) =>
      h.store.movements
        .filter((m) => m.ownerId === ownerId && m.productId === productId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
});

import { buildApp } from "../src/app";

const CSRF = "test-csrf-token";
const csrf = { mk_csrf: CSRF };
const csrfHeader = { "x-csrf-token": CSRF };

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.find((c) => c.name === "mk_session")?.value ?? "";
}

describe("stock movement routes", () => {
  let app: FastifyInstance;
  let auth: { mk_session: string };
  let other: { mk_session: string };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // Register both owners once — auth endpoints are rate-limited (10/min).
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "stock-owner@example.com", password: "supersecret" },
    });
    auth = { mk_session: sessionCookie(reg) };
    const reg2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "stock-other@example.com", password: "supersecret" },
    });
    other = { mk_session: sessionCookie(reg2) };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    h.store.products = [];
    h.store.movements = [];
  });

  const authed = (extra: Record<string, string> = {}) => ({ ...auth, ...extra });

  async function createProduct(payload: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/products",
      cookies: authed(csrf),
      headers: csrfHeader,
      payload: { name: "Widget", ...payload },
    });
    return res.json().data.product as { id: string };
  }

  function record(productId: string, payload: Record<string, unknown>, cookies = authed(csrf)) {
    return app.inject({
      method: "POST",
      url: `/api/v1/products/${productId}/movements`,
      cookies,
      headers: csrfHeader,
      payload,
    });
  }

  it("records an IN movement and returns the new balance (201)", async () => {
    const product = await createProduct();
    const res = await record(product.id, { type: "IN", quantity: "5", reason: "Initial delivery" });
    expect(res.statusCode).toBe(201);
    const movement = res.json().data.movement;
    expect(movement.type).toBe("IN");
    expect(movement.quantityDelta).toBe("5");
    expect(movement.balanceAfter).toBe("5");
    expect(movement.reason).toBe("Initial delivery");
  });

  // Regression: the client sends `reason: null` (not omission) when the Reason
  // box is blank. The schema must accept an explicit null — it once used
  // `.optional()`, which rejected null and 400'd every blank-reason movement.
  it("accepts an explicit null reason and stores it as null (201)", async () => {
    const product = await createProduct();
    const res = await record(product.id, { type: "IN", quantity: "5", reason: null });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.movement.reason).toBeNull();
  });

  it("supports OUT, ADJUSTMENT, and DAMAGED_LOST and keeps the balance reconciled", async () => {
    const product = await createProduct();
    expect((await record(product.id, { type: "IN", quantity: "20" })).json().data.movement.balanceAfter).toBe("20");
    expect((await record(product.id, { type: "OUT", quantity: "5" })).json().data.movement.balanceAfter).toBe("15");
    // ADJUSTMENT is a signed correction.
    expect((await record(product.id, { type: "ADJUSTMENT", quantity: "-3" })).json().data.movement.balanceAfter).toBe("12");
    expect((await record(product.id, { type: "DAMAGED_LOST", quantity: "2" })).json().data.movement.balanceAfter).toBe("10");
  });

  it("rejects an OUT movement beyond available stock with 409", async () => {
    const product = await createProduct();
    await record(product.id, { type: "IN", quantity: "3" });
    const res = await record(product.id, { type: "OUT", quantity: "10" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("rejects an invalid movement type with 400", async () => {
    const product = await createProduct();
    const res = await record(product.id, { type: "GIVEAWAY", quantity: "1" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-positive IN quantity with 400", async () => {
    const product = await createProduct();
    const res = await record(product.id, { type: "IN", quantity: "0" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-numeric quantity with 400", async () => {
    const product = await createProduct();
    const res = await record(product.id, { type: "IN", quantity: "abc" });
    expect(res.statusCode).toBe(400);
  });

  it("requires CSRF to record a movement (403)", async () => {
    const product = await createProduct();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/movements`,
      cookies: auth,
      payload: { type: "IN", quantity: "1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires authentication to record a movement (401)", async () => {
    const product = await createProduct();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/products/${product.id}/movements`,
      cookies: csrf,
      headers: csrfHeader,
      payload: { type: "IN", quantity: "1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when recording against another owner's product (isolation)", async () => {
    const product = await createProduct();
    const res = await record(product.id, { type: "IN", quantity: "1" }, { ...other, ...csrf });
    expect(res.statusCode).toBe(404);
  });

  it("lists a product's movement history newest-first", async () => {
    const product = await createProduct();
    await record(product.id, { type: "IN", quantity: "5" });
    await record(product.id, { type: "OUT", quantity: "2" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/products/${product.id}/movements`,
      cookies: auth,
    });
    expect(res.statusCode).toBe(200);
    const movements = res.json().data.movements;
    expect(movements).toHaveLength(2);
    expect(movements[0].type).toBe("OUT");
    expect(movements[0].balanceAfter).toBe("3");
    expect(movements[1].type).toBe("IN");
    expect(movements[1].balanceAfter).toBe("5");
  });

  it("requires authentication to read movement history (401)", async () => {
    const product = await createProduct();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/products/${product.id}/movements`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 reading history for another owner's product", async () => {
    const product = await createProduct();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/products/${product.id}/movements`,
      cookies: other,
    });
    expect(res.statusCode).toBe(404);
  });
});
