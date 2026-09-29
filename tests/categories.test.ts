import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Auth + category stores, in memory, so category CRUD runs without a live DB.
const h = vi.hoisted(() => {
  const store = {
    users: [] as Array<{ id: string; email: string; passwordHash: string; name: string | null; createdAt: Date; updatedAt: Date }>,
    sessions: [] as Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date | null; userAgent: string | null; ip: string | null }>,
    categories: [] as Array<{ id: string; ownerId: string; name: string; archivedAt: Date | null; createdAt: Date; updatedAt: Date }>,
  };
  return { store, uuid: () => crypto.randomUUID() };
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

import { buildApp } from "../src/app";

const CSRF = "test-csrf-token";
const csrf = { mk_csrf: CSRF };
const csrfHeader = { "x-csrf-token": CSRF };

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.find((c) => c.name === "mk_session")?.value ?? "";
}

describe("category routes", () => {
  let app: FastifyInstance;
  let auth: { mk_session: string };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // Register once — auth endpoints are rate-limited; only categories reset per test.
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "owner@example.com", password: "supersecret" },
    });
    auth = { mk_session: sessionCookie(reg) };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    h.store.categories = [];
  });

  const create = (name: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/categories",
      cookies: { ...auth, ...csrf },
      headers: csrfHeader,
      payload: { name },
    });

  it("lists categories alphabetically, excluding archived by default", async () => {
    await create("Zeta");
    await create("Alpha");
    const res = await app.inject({ method: "GET", url: "/api/v1/categories", cookies: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.categories.map((c: { name: string }) => c.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("renames a category and rejects a name clash with 409", async () => {
    const a = (await create("Alpha")).json().data.category;
    await create("Beta");

    const clash = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${a.id}`,
      cookies: { ...auth, ...csrf },
      headers: csrfHeader,
      payload: { name: "Beta" },
    });
    expect(clash.statusCode).toBe(409);

    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/categories/${a.id}`,
      cookies: { ...auth, ...csrf },
      headers: csrfHeader,
      payload: { name: "Gamma" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.category.name).toBe("Gamma");
  });

  it("archives then restores a category", async () => {
    const c = (await create("Temp")).json().data.category;

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${c.id}/archive`,
      cookies: { ...auth, ...csrf },
      headers: csrfHeader,
    });
    expect(archived.json().data.category.archivedAt).not.toBeNull();

    const listed = await app.inject({ method: "GET", url: "/api/v1/categories", cookies: auth });
    expect(listed.json().data.categories).toHaveLength(0);

    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/categories/${c.id}/restore`,
      cookies: { ...auth, ...csrf },
      headers: csrfHeader,
    });
    expect(restored.json().data.category.archivedAt).toBeNull();
  });

  it("returns 404 for an unknown category id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/categories/${crypto.randomUUID()}`,
      cookies: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
