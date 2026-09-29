import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Shared in-memory stores (hoisted so the vi.mock factories can close over them),
// letting the full stack (routes → service → guard → CSRF) run without a live DB.
const h = vi.hoisted(() => {
  interface Cat {
    id: string;
    ownerId: string;
    name: string;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }
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
  const store = {
    users: [] as Array<{ id: string; email: string; passwordHash: string; name: string | null; createdAt: Date; updatedAt: Date }>,
    sessions: [] as Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date | null; userAgent: string | null; ip: string | null }>,
    categories: [] as Cat[],
    products: [] as Prod[],
  };
  const uuid = () => crypto.randomUUID();
  const joinCat = (p: Prod) => ({ ...p, category: store.categories.find((c) => c.id === p.categoryId) ?? null });
  return { store, uuid, joinCat };
});

vi.mock("../src/modules/auth/repository", () => ({
  createUser: async (data: { email: string; passwordHash: string; name?: string | null }) => {
    const user = { id: h.uuid(), email: data.email, passwordHash: data.passwordHash, name: data.name ?? null, createdAt: new Date(), updatedAt: new Date() };
    h.store.users.push(user);
    return user;
  },
  findUserByEmail: async (email: string) => h.store.users.find((u) => u.email === email) ?? null,
  findUserById: async (id: string) => h.store.users.find((u) => u.id === id) ?? null,
  updateUserProfile: async (id: string, data: { name: string | null }) => {
    const u = h.store.users.find((x) => x.id === id)!;
    u.name = data.name;
    return u;
  },
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
  createCategory: async (data: { ownerId: string; name: string }) => {
    const c = { id: h.uuid(), ownerId: data.ownerId, name: data.name, archivedAt: null, createdAt: new Date(), updatedAt: new Date() };
    h.store.categories.push(c);
    return c;
  },
  findCategoryByIdForOwner: async (ownerId: string, id: string) =>
    h.store.categories.find((c) => c.id === id && c.ownerId === ownerId) ?? null,
  findCategoryByNameForOwner: async (ownerId: string, name: string) =>
    h.store.categories.find((c) => c.ownerId === ownerId && c.name === name) ?? null,
  listCategoriesForOwner: async (ownerId: string, opts: { includeArchived?: boolean } = {}) =>
    h.store.categories
      .filter((c) => c.ownerId === ownerId && (opts.includeArchived || c.archivedAt === null))
      .sort((a, b) => a.name.localeCompare(b.name)),
  updateCategoryForOwner: async (ownerId: string, id: string, data: { name?: string; archivedAt?: Date | null }) => {
    const c = h.store.categories.find((x) => x.id === id && x.ownerId === ownerId);
    if (!c) return null;
    if (data.name !== undefined) c.name = data.name;
    if (data.archivedAt !== undefined) c.archivedAt = data.archivedAt;
    c.updatedAt = new Date();
    return c;
  },
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
  findProductBySkuForOwner: async (ownerId: string, sku: string) =>
    h.store.products.find((x) => x.ownerId === ownerId && x.sku === sku) ?? null,
  listProductsPageForOwner: async (
    ownerId: string,
    opts: { page: number; pageSize: number; includeArchived?: boolean },
  ) => {
    const all = h.store.products
      .filter((p) => p.ownerId === ownerId && (opts.includeArchived || p.archivedAt === null))
      .sort((a, b) => a.name.localeCompare(b.name));
    const start = (opts.page - 1) * opts.pageSize;
    return { items: all.slice(start, start + opts.pageSize).map(h.joinCat), total: all.length };
  },
  updateProductForOwner: async (
    ownerId: string,
    id: string,
    data: Record<string, unknown>,
  ) => {
    const p = h.store.products.find((x) => x.id === id && x.ownerId === ownerId);
    if (!p) return null;
    Object.assign(p, data);
    p.updatedAt = new Date();
    return h.joinCat(p);
  },
}));

import { buildApp } from "../src/app";

const CSRF = "test-csrf-token";
const csrf = { mk_csrf: CSRF };
const csrfHeader = { "x-csrf-token": CSRF };

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.find((c) => c.name === "mk_session")?.value ?? "";
}

describe("product & category routes", () => {
  let app: FastifyInstance;
  let auth: { mk_session: string };
  let other: { mk_session: string };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // Register both owners once — the auth endpoints are rate-limited (10/min),
    // so per-test registration would exhaust the limiter. Sessions persist; only
    // the domain stores are reset between tests.
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "owner@example.com", password: "supersecret" },
    });
    auth = { mk_session: sessionCookie(reg) };
    const reg2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "other@example.com", password: "supersecret" },
    });
    other = { mk_session: sessionCookie(reg2) };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    h.store.categories = [];
    h.store.products = [];
  });

  const authed = (extra: Record<string, string> = {}) => ({ ...auth, ...extra });

  async function createCategory(name: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/categories",
      cookies: authed(csrf),
      headers: csrfHeader,
      payload: { name },
    });
  }

  async function createProduct(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/products",
      cookies: authed(csrf),
      headers: csrfHeader,
      payload,
    });
  }

  it("requires authentication to list products", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/products" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a category and rejects a duplicate name with 409", async () => {
    const first = await createCategory("Beverages");
    expect(first.statusCode).toBe(201);
    expect(first.json().data.category.name).toBe("Beverages");

    const dup = await createCategory("Beverages");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");
  });

  it("creates a product with a category and derives OUT status at zero stock", async () => {
    const cat = (await createCategory("Snacks")).json().data.category;
    const res = await createProduct({ name: "Chips", categoryId: cat.id, sku: "SNK-1", lowStockThreshold: "10" });
    expect(res.statusCode).toBe(201);
    const product = res.json().data.product;
    expect(product.category).toEqual({ id: cat.id, name: "Snacks" });
    expect(product.quantity).toBe("0");
    expect(product.stockStatus).toBe("OUT");
    expect(product.lowStockThreshold).toBe("10");
  });

  it("rejects a product referencing an unknown category with 400", async () => {
    const res = await createProduct({ name: "Ghost", categoryId: crypto.randomUUID() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a duplicate SKU with 409", async () => {
    await createProduct({ name: "A", sku: "DUP" });
    const res = await createProduct({ name: "B", sku: "DUP" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("paginates the product list with correct meta", async () => {
    for (let i = 0; i < 3; i += 1) {
      await createProduct({ name: `P${i}` });
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/products?page=1&pageSize=2",
      cookies: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.products).toHaveLength(2);
    expect(body.meta).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
  });

  it("derives LOW and IN_STOCK from the cached quantity on read", async () => {
    const created = (await createProduct({ name: "Widget", lowStockThreshold: "10" })).json().data.product;
    // Simulate stock the way the stock service would (test-only store poke).
    const row = h.store.products.find((p) => p.id === created.id)!;
    row.quantity = 5;
    const low = await app.inject({ method: "GET", url: `/api/v1/products/${created.id}`, cookies: auth });
    expect(low.json().data.product.stockStatus).toBe("LOW");
    row.quantity = 50;
    const inStock = await app.inject({ method: "GET", url: `/api/v1/products/${created.id}`, cookies: auth });
    expect(inStock.json().data.product.stockStatus).toBe("IN_STOCK");
  });

  it("updates product metadata without touching quantity", async () => {
    const created = (await createProduct({ name: "Old" })).json().data.product;
    const row = h.store.products.find((p) => p.id === created.id)!;
    row.quantity = 42;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/products/${created.id}`,
      cookies: authed(csrf),
      headers: csrfHeader,
      payload: { name: "New", description: "updated" },
    });
    expect(res.statusCode).toBe(200);
    const product = res.json().data.product;
    expect(product.name).toBe("New");
    expect(product.description).toBe("updated");
    expect(product.quantity).toBe("42"); // untouched by CRUD
  });

  it("archives a product so it drops out of the default list, then restores it", async () => {
    const created = (await createProduct({ name: "Temp" })).json().data.product;

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/products/${created.id}/archive`,
      cookies: authed(csrf),
      headers: csrfHeader,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.product.archivedAt).not.toBeNull();

    const listed = await app.inject({ method: "GET", url: "/api/v1/products", cookies: auth });
    expect(listed.json().data.products).toHaveLength(0);

    const withArchived = await app.inject({
      method: "GET",
      url: "/api/v1/products?includeArchived=true",
      cookies: auth,
    });
    expect(withArchived.json().data.products).toHaveLength(1);

    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/products/${created.id}/restore`,
      cookies: authed(csrf),
      headers: csrfHeader,
    });
    expect(restored.json().data.product.archivedAt).toBeNull();
  });

  it("returns 404 for another owner's product (owner isolation)", async () => {
    const created = (await createProduct({ name: "Mine" })).json().data.product;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/products/${created.id}`,
      cookies: other,
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a state-changing product request without CSRF (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/products",
      cookies: auth,
      payload: { name: "NoCsrf" },
    });
    expect(res.statusCode).toBe(403);
  });
});
