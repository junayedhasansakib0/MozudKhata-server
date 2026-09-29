import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// In-memory stores hoisted so the vi.mock factories close over them, letting the
// full stack (route → service → guard) run with no live DB. The dashboard
// repository is mocked to compute the same aggregates from these stores that the
// real Prisma queries would (owner-scoped counts/sum + recent movements).
const h = vi.hoisted(() => {
  interface Prod {
    id: string;
    ownerId: string;
    name: string;
    quantity: number;
    lowStockThreshold: number;
    archivedAt: Date | null;
  }
  interface Cat {
    id: string;
    ownerId: string;
    archivedAt: Date | null;
  }
  interface Mov {
    id: string;
    ownerId: string;
    productId: string;
    type: "IN" | "OUT" | "ADJUSTMENT" | "DAMAGED_LOST";
    quantityDelta: number;
    balanceAfter: number;
    reason: string | null;
    createdAt: Date;
  }
  const store = {
    users: [] as Array<{ id: string; email: string; passwordHash: string; name: string | null; createdAt: Date; updatedAt: Date }>,
    sessions: [] as Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date | null; userAgent: string | null; ip: string | null }>,
    products: [] as Prod[],
    categories: [] as Cat[],
    movements: [] as Mov[],
  };
  const uuid = () => crypto.randomUUID();
  return { store, uuid };
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
  deleteSession: async () => undefined,
  deleteSessionByTokenHash: async () => undefined,
  deleteOtherUserSessions: async () => undefined,
  deleteAllUserSessions: async () => undefined,
}));

// Mirror the real repository's derived buckets + owner-scoping over the store.
vi.mock("../src/modules/dashboard/repository", () => ({
  getDashboardForOwner: async (ownerId: string, recentLimit: number) => {
    const live = h.store.products.filter((p) => p.ownerId === ownerId && p.archivedAt === null);
    const lowStockCount = live.filter((p) => p.quantity > 0 && p.quantity <= p.lowStockThreshold).length;
    const outOfStockCount = live.filter((p) => p.quantity <= 0).length;
    const categoryCount = h.store.categories.filter((c) => c.ownerId === ownerId && c.archivedAt === null).length;
    const totalStockUnits = live.length ? live.reduce((sum, p) => sum + p.quantity, 0) : null;
    const recentMovements = h.store.movements
      .filter((m) => m.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, recentLimit)
      .map((m) => ({
        ...m,
        product: { name: h.store.products.find((p) => p.id === m.productId)?.name ?? "?" },
      }));
    return {
      totalProducts: live.length,
      lowStockCount,
      outOfStockCount,
      categoryCount,
      totalStockUnits,
      recentMovements,
    };
  },
}));

import { buildApp } from "../src/app";

const CSRF = "test-csrf-token";
const csrf = { mk_csrf: CSRF };
const csrfHeader = { "x-csrf-token": CSRF };

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.find((c) => c.name === "mk_session")?.value ?? "";
}

describe("dashboard routes", () => {
  let app: FastifyInstance;
  let auth: { mk_session: string };
  let ownerId: string;
  let otherId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // Register both owners once (auth is rate-limited 10/min); domain stores reset per test.
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "owner@example.com", password: "supersecret" },
    });
    auth = { mk_session: sessionCookie(reg) };
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "other@example.com", password: "supersecret" },
    });
    ownerId = h.store.users.find((u) => u.email === "owner@example.com")!.id;
    otherId = h.store.users.find((u) => u.email === "other@example.com")!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    h.store.products = [];
    h.store.categories = [];
    h.store.movements = [];
  });

  const get = () => app.inject({ method: "GET", url: "/api/v1/dashboard", cookies: auth });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/dashboard" });
    expect(res.statusCode).toBe(401);
  });

  it("returns a zeroed, empty dashboard for a new owner", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      totalProducts: 0,
      totalStockUnits: "0",
      lowStockCount: 0,
      outOfStockCount: 0,
      categoryCount: 0,
      recentActivity: [],
    });
  });

  it("aggregates live products, stock units, and low/out-of-stock counts", async () => {
    h.store.products.push(
      { id: h.uuid(), ownerId, name: "Empty", quantity: 0, lowStockThreshold: 5, archivedAt: null }, // OUT
      { id: h.uuid(), ownerId, name: "Low", quantity: 3, lowStockThreshold: 5, archivedAt: null }, // LOW
      { id: h.uuid(), ownerId, name: "Plenty", quantity: 50, lowStockThreshold: 5, archivedAt: null }, // IN_STOCK
      { id: h.uuid(), ownerId, name: "Archived", quantity: 100, lowStockThreshold: 5, archivedAt: new Date() }, // excluded
    );
    h.store.categories.push(
      { id: h.uuid(), ownerId, archivedAt: null },
      { id: h.uuid(), ownerId, archivedAt: null },
      { id: h.uuid(), ownerId, archivedAt: new Date() }, // excluded
    );

    const data = (await get()).json().data;
    expect(data.totalProducts).toBe(3);
    expect(data.totalStockUnits).toBe("53");
    expect(data.lowStockCount).toBe(1);
    expect(data.outOfStockCount).toBe(1);
    expect(data.categoryCount).toBe(2);
  });

  it("returns recent activity newest-first with product names", async () => {
    const productId = h.uuid();
    h.store.products.push({ id: productId, ownerId, name: "Widget", quantity: 5, lowStockThreshold: 2, archivedAt: null });
    h.store.movements.push(
      { id: h.uuid(), ownerId, productId, type: "IN", quantityDelta: 10, balanceAfter: 10, reason: null, createdAt: new Date("2026-09-01T10:00:00Z") },
      { id: h.uuid(), ownerId, productId, type: "OUT", quantityDelta: -5, balanceAfter: 5, reason: "sold", createdAt: new Date("2026-09-02T10:00:00Z") },
    );

    const activity = (await get()).json().data.recentActivity;
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ type: "OUT", quantityDelta: "-5", productName: "Widget", reason: "sold" });
    expect(activity[1]).toMatchObject({ type: "IN", quantityDelta: "10", productName: "Widget" });
  });

  it("scopes every metric to the requesting owner", async () => {
    h.store.products.push(
      { id: h.uuid(), ownerId, name: "Mine", quantity: 5, lowStockThreshold: 2, archivedAt: null },
      { id: h.uuid(), ownerId: otherId, name: "Theirs", quantity: 99, lowStockThreshold: 2, archivedAt: null },
    );
    const otherProductId = h.uuid();
    h.store.movements.push({ id: h.uuid(), ownerId: otherId, productId: otherProductId, type: "IN", quantityDelta: 99, balanceAfter: 99, reason: null, createdAt: new Date() });

    const data = (await get()).json().data;
    expect(data.totalProducts).toBe(1);
    expect(data.totalStockUnits).toBe("5");
    expect(data.recentActivity).toHaveLength(0);
  });
});
