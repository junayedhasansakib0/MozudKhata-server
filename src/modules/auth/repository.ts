import type { Session, User } from "@prisma/client";
import { prisma } from "../../lib/db";

/**
 * Data access for auth (users + sessions). All Prisma access for this feature
 * lives here (AGENTS.md §5); the service layer holds the business rules.
 */

export interface NewSession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
  ip?: string | null;
}

export function createUser(data: {
  email: string;
  passwordHash: string;
  name?: string | null;
}): Promise<User> {
  return prisma.user.create({
    data: { email: data.email, passwordHash: data.passwordHash, name: data.name ?? null },
  });
}

export function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export function updateUserProfile(id: string, data: { name: string | null }): Promise<User> {
  return prisma.user.update({ where: { id }, data: { name: data.name } });
}

export function updateUserPassword(id: string, passwordHash: string): Promise<User> {
  return prisma.user.update({ where: { id }, data: { passwordHash } });
}

export function createSession(data: NewSession): Promise<Session> {
  return prisma.session.create({
    data: {
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      userAgent: data.userAgent ?? null,
      ip: data.ip ?? null,
    },
  });
}

export function findSessionByTokenHash(
  tokenHash: string,
): Promise<(Session & { user: User }) | null> {
  return prisma.session.findUnique({ where: { tokenHash }, include: { user: true } });
}

export function touchSession(id: string, expiresAt: Date): Promise<Session> {
  return prisma.session.update({
    where: { id },
    data: { expiresAt, lastUsedAt: new Date() },
  });
}

export async function deleteSession(id: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id } });
}

export async function deleteSessionByTokenHash(tokenHash: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash } });
}

export async function deleteOtherUserSessions(userId: string, keepSessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId, NOT: { id: keepSessionId } } });
}

export async function deleteAllUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
