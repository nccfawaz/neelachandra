import { constantTimeEquals, randomToken, sha256Hex } from './crypto.js'
import { ForbiddenError } from './errors.js'

/**
 * CSRF token issue and timing-safe compare (spec 2.5).
 *
 * One token per session, stored on user_sessions.csrf_token and echoed into
 * every form as a hidden field. The synchroniser-token pattern is used rather
 * than double-submit cookies because the session table already exists, so the
 * server-side half is free, and double-submit is defeatable by a subdomain
 * that can write cookies for the parent domain.
 *
 * SameSite=Lax on the session cookie already blocks cross-site POSTs in every
 * current browser. The token is the second layer, for the case of an old
 * browser and for same-site injection.
 */

export const CSRF_FIELD = 'nc_csrf'
export const CSRF_HEADER = 'x-csrf-token'

export function issueToken(): string {
  return sha256Hex(randomToken(32))
}

export function verifyToken(expected: string | null | undefined, supplied: unknown): void {
  if (!expected) {
    throw new ForbiddenError('This form has no session token. Reload the page and try again.')
  }
  if (typeof supplied !== 'string' || supplied.length === 0) {
    throw new ForbiddenError('This form is missing its security token. Reload the page and try again.')
  }
  if (!constantTimeEquals(expected, supplied)) {
    throw new ForbiddenError('This form has expired. Reload the page and try again.')
  }
}

/**
 * Reads the token from a parsed body or from the htmx header. htmx sends the
 * header via hx-headers on the body element, so an hx-post with no form
 * fields is still protected.
 */
export function extractToken(
  body: Record<string, unknown> | null,
  headers: { get(name: string): string | null }
): string | null {
  const fromBody = body?.[CSRF_FIELD]
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody
  return headers.get(CSRF_HEADER)
}

/**
 * Methods that change state. GET and HEAD are exempt because they must not
 * change state in the first place; a GET route that mutates is the bug, not
 * the missing token.
 */
export function requiresCsrf(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}
