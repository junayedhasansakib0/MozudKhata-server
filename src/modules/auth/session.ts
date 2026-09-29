import type { FastifyReply } from "fastify";
import { env } from "../../config/env";

/**
 * Session + cookie policy (owner decision 2026-09-28): 30-day **rolling**,
 * revocable sessions with no idle timeout. "Rolling" = an active session's
 * expiry is pushed back to a full 30 days whenever it drops below the refresh
 * threshold, so a user who keeps using the app is never logged out; an idle one
 * lapses 30 days after its last use.
 */
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

// Re-extend the session once less than this remains (half the TTL) — bounds the
// per-request write rate while keeping active sessions effectively perpetual.
export const SESSION_ROLL_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000;

/** CSRF cookie name — readable by client JS for the double-submit scheme. */
export const CSRF_COOKIE_NAME = "mk_csrf";

const isProd = env.NODE_ENV === "production";

// Cross-site (SPA and API on different sites) requires SameSite=None + Secure in
// production. In local dev the client reaches the API same-origin via the Vite
// `/api` proxy, so Lax works without HTTPS.
const sameSite = isProd ? ("none" as const) : ("lax" as const);

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(env.SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: isProd,
    sameSite,
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(env.SESSION_COOKIE_NAME, { path: "/" });
}

export function setCsrfCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(CSRF_COOKIE_NAME, token, {
    path: "/",
    httpOnly: false, // must be readable so the client can echo it in a header
    secure: isProd,
    sameSite,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}
