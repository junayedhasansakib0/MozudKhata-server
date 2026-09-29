import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

/**
 * Single shared PrismaClient. In development we cache it on globalThis so hot
 * reloads don't exhaust the connection pool. Data access lives behind
 * repositories (added from Phase 03); this is the low-level client only.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
