import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import { generateCsrfToken } from "../../lib/tokens";
import { CSRF_COOKIE_NAME, setCsrfCookie } from "./session";

/**
 * Double-submit CSRF (docs/security.md §4). We set a non-httpOnly `mk_csrf`
 * cookie and hand the same value back in the JSON body; the client echoes it in
 * the `X-CSRF-Token` header on every state-changing request. A forged cross-site
 * request cannot read the token to set the header, so header == cookie proves
 * intent. The session cookie itself is additionally `SameSite`-restricted.
 */
export function issueCsrfToken(reply: FastifyReply): string {
  const token = generateCsrfToken();
  setCsrfCookie(reply, token);
  return token;
}

export async function requireCsrf(request: FastifyRequest): Promise<void> {
  const cookieToken = request.cookies[CSRF_COOKIE_NAME];
  const headerRaw = request.headers["x-csrf-token"];
  const headerToken = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw new AppError("FORBIDDEN", "Invalid or missing CSRF token.");
  }
}
