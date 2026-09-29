import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// In-memory stand-in for the Prisma-backed repository so the full auth flow
// (routes → service → guard → CSRF → cookies) can be exercised without a live
// database, mirroring how the health tests avoid the DB.
const store = vi.hoisted(() => ({
  users: [] as Array<{
    id: string;
    email: string;
    passwordHash: string;
    name: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
  sessions: [] as Array<{
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
    lastUsedAt: Date | null;
    userAgent: string | null;
    ip: string | null;
  }>,
  seq: { n: 0 },
}));

vi.mock("../src/modules/auth/repository", () => {
  const nextId = (prefix: string) => `${prefix}-${(store.seq.n += 1)}`;
  return {
    createUser: async (data: { email: string; passwordHash: string; name?: string | null }) => {
      const user = {
        id: nextId("user"),
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.users.push(user);
      return user;
    },
    findUserByEmail: async (email: string) =>
      store.users.find((u) => u.email === email) ?? null,
    findUserById: async (id: string) => store.users.find((u) => u.id === id) ?? null,
    updateUserProfile: async (id: string, data: { name: string | null }) => {
      const user = store.users.find((u) => u.id === id)!;
      user.name = data.name;
      user.updatedAt = new Date();
      return user;
    },
    updateUserPassword: async (id: string, passwordHash: string) => {
      const user = store.users.find((u) => u.id === id)!;
      user.passwordHash = passwordHash;
      user.updatedAt = new Date();
      return user;
    },
    createSession: async (data: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent?: string | null;
      ip?: string | null;
    }) => {
      const session = {
        id: nextId("sess"),
        userId: data.userId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
        lastUsedAt: null,
        userAgent: data.userAgent ?? null,
        ip: data.ip ?? null,
      };
      store.sessions.push(session);
      return session;
    },
    findSessionByTokenHash: async (tokenHash: string) => {
      const session = store.sessions.find((s) => s.tokenHash === tokenHash);
      if (!session) return null;
      const user = store.users.find((u) => u.id === session.userId)!;
      return { ...session, user };
    },
    touchSession: async (id: string, expiresAt: Date) => {
      const session = store.sessions.find((s) => s.id === id)!;
      session.expiresAt = expiresAt;
      session.lastUsedAt = new Date();
      return session;
    },
    deleteSession: async (id: string) => {
      store.sessions = store.sessions.filter((s) => s.id !== id);
    },
    deleteSessionByTokenHash: async (tokenHash: string) => {
      store.sessions = store.sessions.filter((s) => s.tokenHash !== tokenHash);
    },
    deleteOtherUserSessions: async (userId: string, keepSessionId: string) => {
      store.sessions = store.sessions.filter(
        (s) => s.userId !== userId || s.id === keepSessionId,
      );
    },
    deleteAllUserSessions: async (userId: string) => {
      store.sessions = store.sessions.filter((s) => s.userId !== userId);
    },
  };
});

import { buildApp } from "../src/app";

const CSRF = "test-csrf-token";
const csrf = { mk_csrf: CSRF };
const csrfHeader = { "x-csrf-token": CSRF };

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  return res.cookies.find((c) => c.name === "mk_session")?.value ?? "";
}

describe("auth routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    store.users = [];
    store.sessions = [];
  });

  async function register(email: string, password = "supersecret", name?: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email, password, name },
    });
  }

  it("registers a user, returns 201 + public user, and sets a session cookie", async () => {
    const res = await register("alice@example.com", "supersecret", "Alice");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.user.email).toBe("alice@example.com");
    expect(body.data.user.name).toBe("Alice");
    expect(body.data.user.passwordHash).toBeUndefined();
    expect(sessionCookie(res)).not.toBe("");
  });

  it("normalizes email and rejects a duplicate with 409 CONFLICT", async () => {
    await register("Bob@Example.com");
    const res = await register("bob@example.com");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("rejects a too-short password with 400 VALIDATION_ERROR", async () => {
    const res = await register("weak@example.com", "short");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a state-changing request without a matching CSRF token (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "nocsrf@example.com", password: "supersecret" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("logs in with correct credentials and rejects wrong ones with 401", async () => {
    await register("carol@example.com", "supersecret");

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "carol@example.com", password: "wrongpass" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("UNAUTHORIZED");

    const good = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      cookies: csrf,
      headers: csrfHeader,
      payload: { email: "carol@example.com", password: "supersecret" },
    });
    expect(good.statusCode).toBe(200);
    expect(sessionCookie(good)).not.toBe("");
  });

  it("returns the current user from /auth/me only with a valid session", async () => {
    const reg = await register("dave@example.com");
    const token = sessionCookie(reg);

    const anon = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(anon.statusCode).toBe(401);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { mk_session: token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.email).toBe("dave@example.com");
  });

  it("logout revokes the session so the cookie no longer authenticates", async () => {
    const reg = await register("erin@example.com");
    const token = sessionCookie(reg);

    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { ...csrf, mk_session: token },
      headers: csrfHeader,
    });
    expect(out.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { mk_session: token },
    });
    expect(me.statusCode).toBe(401);
  });

  it("changing the password revokes other sessions but keeps the current one", async () => {
    await register("frank@example.com", "supersecret");

    // Two independent sessions for the same user.
    const loginRes = async () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        cookies: csrf,
        headers: csrfHeader,
        payload: { email: "frank@example.com", password: "supersecret" },
      });
    const sessionA = sessionCookie(await loginRes());
    const sessionB = sessionCookie(await loginRes());

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      cookies: { ...csrf, mk_session: sessionA },
      headers: csrfHeader,
      payload: { currentPassword: "supersecret", newPassword: "brand-new-secret" },
    });
    expect(changed.statusCode).toBe(200);

    // Session A (used for the change) still works; B was revoked.
    const meA = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { mk_session: sessionA },
    });
    expect(meA.statusCode).toBe(200);

    const meB = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { mk_session: sessionB },
    });
    expect(meB.statusCode).toBe(401);
  });
});
