import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// In-memory stores hoisted so the vi.mock factories close over them, letting the
// full stack (route → service → guard) run with no live DB. The stock repository's
// global-history query is mocked to compute the same owner-scoped filtering,
// newest-first ordering, and pagination the real Prisma query would, joining the
// product name so each row is readable.
const h = vi.hoisted(() => {
  interface Prod {
    id: string;
    ownerId: string;
    name: string;
  }
  interface Mov {
    id: string;
    ownerId: string;
    productId: string;
    type: "IN" | "OUT" | "ADJUSTMENT" | "DAMAGED_LOST";
    quantityDelta: number;
    balanceAfter: number;
    reason: string | null;
    actorId: string;
    createdAt: Date;
  }
  const store = {
    users: [] as Array<{ id: string; email: string; passwordHash: string; name: string | null; createdAt: Date; updatedAt: Date }>,
    sessions: [] as Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date | null; userAgent: string | null; ip: string | null }>,
    products: [] as Prod[],
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

// Mirror the real repository: owner-scope, optional productId/type/date filters,
// newest-first (createdAt desc, id desc tiebreaker), offset pagination, product join.
vi.mock("../src/modules/stock/repository", () => ({
  listMovementsForOwner: async (
    ownerId: string,
    options: { page: number; pageSize: number; productId?: string; type?: string; from?: Date; to?: Date },
  ) => {
    const { page, pageSize, productId, type, from, to } = options;
    const filtered = h.store.movements
      .filter((m) => m.ownerId === ownerId)
      .filter((m) => (productId ? m.productId === productId : true))
      .filter((m) => (type ? m.type === type : true))
      .filter((m) => (from ? m.createdAt.getTime() >= from.getTime() : true))
      .filter((m) => (to ? m.createdAt.getTime() <= to.getTime() : true))
      .sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        return t !== 0 ? t : b.id.localeCompare(a.id);
      });
    const total = filtered.length;
    const items = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map((m) => ({
      ...m,
      product: { name: h.store.products.find((p) => p.id === m.productId)?.name ?? "?" },
    }));
    return { items, total };
  },
}));

import { buildApp } from "../src/app";

const CSRF = "test-csrf-token";
const csrf = { mk_csrf: CSRF };
const csrfHeader = { "x-csrf-token": CSRF };

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.find((c) => c.name === "mk_session")?.value ?? "";
}

describe("global movement history routes", () => {
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
    h.store.movements = [];
  });

  const get = (qs = "") => app.inject({ method: "GET", url: `/api/v1/movements${qs}`, cookies: auth });

  // Two products + a spread of movements across types and dates for the owner.
  function seed() {
    const widget = h.uuid();
    const gadget = h.uuid();
    h.store.products.push(
      { id: widget, ownerId, name: "Widget" },
      { id: gadget, ownerId, name: "Gadget" },
    );
    h.store.movements.push(
      { id: h.uuid(), ownerId, productId: widget, type: "IN", quantityDelta: 10, balanceAfter: 10, reason: null, actorId: ownerId, createdAt: new Date("2026-09-01T10:00:00Z") },
      { id: h.uuid(), ownerId, productId: widget, type: "OUT", quantityDelta: -4, balanceAfter: 6, reason: "sold", actorId: ownerId, createdAt: new Date("2026-09-05T10:00:00Z") },
      { id: h.uuid(), ownerId, productId: gadget, type: "IN", quantityDelta: 7, balanceAfter: 7, reason: null, actorId: ownerId, createdAt: new Date("2026-09-10T10:00:00Z") },
      { id: h.uuid(), ownerId, productId: gadget, type: "ADJUSTMENT", quantityDelta: -2, balanceAfter: 5, reason: "recount", actorId: ownerId, createdAt: new Date("2026-09-15T10:00:00Z") },
    );
    return { widget, gadget };
  }

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/movements" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the owner's movements newest-first with product names + pagination meta", async () => {
    seed();
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 4, totalPages: 1 });
    expect(body.data.movements.map((m: { type: string }) => m.type)).toEqual([
      "ADJUSTMENT",
      "IN",
      "OUT",
      "IN",
    ]);
    expect(body.data.movements[0]).toMatchObject({
      type: "ADJUSTMENT",
      productName: "Gadget",
      quantityDelta: "-2",
      balanceAfter: "5",
      reason: "recount",
    });
  });

  it("paginates with correct meta", async () => {
    seed();
    const res = await get("?page=2&pageSize=3");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({ page: 2, pageSize: 3, total: 4, totalPages: 2 });
    expect(body.data.movements).toHaveLength(1);
    expect(body.data.movements[0]).toMatchObject({ type: "IN", productName: "Widget" });
  });

  it("filters by movement type", async () => {
    seed();
    const body = (await get("?type=IN")).json();
    expect(body.meta.total).toBe(2);
    expect(body.data.movements.every((m: { type: string }) => m.type === "IN")).toBe(true);
  });

  it("filters by product", async () => {
    const { gadget } = seed();
    const body = (await get(`?productId=${gadget}`)).json();
    expect(body.meta.total).toBe(2);
    expect(body.data.movements.every((m: { productName: string }) => m.productName === "Gadget")).toBe(true);
  });

  it("filters by inclusive date range", async () => {
    seed();
    const body = (await get("?from=2026-09-04T00:00:00.000Z&to=2026-09-11T23:59:59.999Z")).json();
    expect(body.meta.total).toBe(2);
    expect(body.data.movements.map((m: { type: string }) => m.type)).toEqual(["IN", "OUT"]);
  });

  it("rejects an invalid movement type", async () => {
    const res = await get("?type=BOGUS");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("never returns another owner's movements", async () => {
    const foreign = h.uuid();
    h.store.products.push({ id: foreign, ownerId: otherId, name: "Theirs" });
    h.store.movements.push({ id: h.uuid(), ownerId: otherId, productId: foreign, type: "IN", quantityDelta: 99, balanceAfter: 99, reason: null, actorId: otherId, createdAt: new Date() });

    const body = (await get()).json();
    expect(body.meta.total).toBe(0);
    expect(body.data.movements).toEqual([]);
  });
});
