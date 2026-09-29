import type { User } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { hashPassword, verifyPassword } from "../../lib/password";
import { generateSessionToken, hashToken } from "../../lib/tokens";
import * as repo from "./repository";
import { SESSION_ROLL_THRESHOLD_MS, SESSION_TTL_MS } from "./session";
import type { ChangePasswordInput, LoginInput, RegisterInput, UpdateProfileInput } from "./schema";

/** The user shape safe to return to clients (never includes the password hash). */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface SessionContext {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  user: PublicUser;
  token: string;
  expiresAt: Date;
}

async function issueSession(userId: string, ctx: SessionContext): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await repo.createSession({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: ctx.userAgent ?? null,
    ip: ctx.ip ?? null,
  });
  return { token, expiresAt };
}

// A stable hash to verify against when the email is unknown, so login takes a
// similar amount of time whether or not the account exists (mitigates user
// enumeration via timing). Computed once, lazily.
let decoyHash: Promise<string> | null = null;
function getDecoyHash(): Promise<string> {
  return (decoyHash ??= hashPassword("decoy-password-for-constant-time-login"));
}

export async function register(input: RegisterInput, ctx: SessionContext): Promise<IssuedSession> {
  const existing = await repo.findUserByEmail(input.email);
  if (existing) {
    throw new AppError("CONFLICT", "An account with this email already exists.");
  }
  const passwordHash = await hashPassword(input.password);
  const user = await repo.createUser({
    email: input.email,
    passwordHash,
    name: input.name ?? null,
  });
  const { token, expiresAt } = await issueSession(user.id, ctx);
  return { user: toPublicUser(user), token, expiresAt };
}

export async function login(input: LoginInput, ctx: SessionContext): Promise<IssuedSession> {
  const user = await repo.findUserByEmail(input.email);
  if (!user) {
    await verifyPassword(await getDecoyHash(), input.password);
    throw new AppError("UNAUTHORIZED", "Invalid email or password.");
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    throw new AppError("UNAUTHORIZED", "Invalid email or password.");
  }
  const { token, expiresAt } = await issueSession(user.id, ctx);
  return { user: toPublicUser(user), token, expiresAt };
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await repo.deleteSessionByTokenHash(hashToken(token));
}

export interface ValidatedSession {
  user: PublicUser;
  sessionId: string;
  expiresAt: Date;
  refreshed: boolean;
}

/**
 * Resolve an opaque session token to its user, enforcing expiry and applying
 * rolling renewal. Returns null for missing/expired sessions (and reaps the
 * expired row). `refreshed` tells the caller to re-issue the cookie with the
 * extended lifetime.
 */
export async function validateSession(token: string): Promise<ValidatedSession | null> {
  const session = await repo.findSessionByTokenHash(hashToken(token));
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await repo.deleteSession(session.id).catch(() => undefined);
    return null;
  }

  let expiresAt = session.expiresAt;
  let refreshed = false;
  if (session.expiresAt.getTime() - now < SESSION_ROLL_THRESHOLD_MS) {
    expiresAt = new Date(now + SESSION_TTL_MS);
    await repo.touchSession(session.id, expiresAt);
    refreshed = true;
  }

  return { user: toPublicUser(session.user), sessionId: session.id, expiresAt, refreshed };
}

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<PublicUser> {
  const user = await repo.updateUserProfile(userId, { name: input.name });
  return toPublicUser(user);
}

export async function changePassword(
  userId: string,
  currentSessionId: string,
  input: ChangePasswordInput,
): Promise<void> {
  const user = await repo.findUserById(userId);
  if (!user) {
    throw new AppError("UNAUTHORIZED", "Authentication required.");
  }
  const ok = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!ok) {
    throw new AppError("VALIDATION_ERROR", "Current password is incorrect.", [
      { path: "currentPassword", message: "Current password is incorrect." },
    ]);
  }
  await repo.updateUserPassword(userId, await hashPassword(input.newPassword));
  // Revoke every other session so a stolen session cannot outlive the change.
  await repo.deleteOtherUserSessions(userId, currentSessionId);
}
