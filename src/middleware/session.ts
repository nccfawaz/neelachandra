import type { MiddlewareHandler } from 'hono'
import { getCookie, deleteCookie, setCookie } from 'hono/cookie'
import { getDb } from '../db/kysely.js'
import {
  COOKIE_NAME,
  loadSession,
  touchSession,
  extendSession,
  dueForRenewal,
  isStaffSession,
  STAFF_SESSION_TTL_SECONDS,
  cookieOptions,
} from '../lib/session.js'
import { loadEffectivePermissions } from '../lib/permissions.js'
import { randomToken } from '../lib/crypto.js'
import { isProd } from '../env.js'
import type { AppEnv, CurrentUser } from '../types.js'

/**
 * Runs on every request, authenticated or not (spec 4.1).
 *
 * It populates c.var with the db handle, the client ip, and, when a valid
 * cookie is present, the user, session and effective permission set. It never
 * rejects: a missing or dead cookie leaves user null and lets the route's own
 * guard decide whether that matters. That split is what lets the public site
 * and /app share one middleware chain.
 */

function readClientIp(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | null {
  // Hostinger puts Apache in front of Node, so the socket address is always
  // 127.0.0.1. The forwarded header is the only source of the real address,
  // and the leftmost entry is the client.
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? null
}

// Touching last_seen_at on every request would be one write per page view for
// display-only data. Once a minute is plenty to drive the "active sessions"
// screen and keeps the write rate off the hot path.
const TOUCH_INTERVAL_MS = 60_000
const lastTouched = new Map<string, number>()
const lastRenewal = new Map<string, number>()

export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const db = getDb()
    c.set('db', db)
    c.set('requestId', randomToken(8))
    c.set('clientIp', readClientIp(c))
    c.set('user', null)
    c.set('session', null)
    c.set('perms', new Set<string>())
    c.set('roleKeys', [])
    c.set('scope', null)
    c.set('requires2fa', false)

    const cookie = getCookie(c, COOKIE_NAME)
    if (!cookie) return next()

    const session = await loadSession(db, cookie)
    if (!session) {
      // Clear a cookie that no longer resolves, so a revoked session stops
      // costing a lookup on every subsequent request.
      deleteCookie(c, COOKIE_NAME, cookieOptions(isProd))
      return next()
    }

    const row = await db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'full_name',
        'status',
        'must_change_password',
        'totp_confirmed_at',
        'employee_id',
      ])
      .where('id', '=', session.userId)
      .executeTakeFirst()

    // A suspended or deactivated account keeps its session row until the next
    // cron purge, so status is rechecked here rather than trusted from login.
    if (!row || (row.status !== 'active' && row.status !== 'invited')) {
      deleteCookie(c, COOKIE_NAME, cookieOptions(isProd))
      return next()
    }

    const user: CurrentUser = {
      id: Number(row.id),
      email: row.email,
      fullName: row.full_name,
      status: row.status,
      mustChangePassword: Number(row.must_change_password) === 1,
      totpConfirmed: row.totp_confirmed_at !== null,
      employeeId: row.employee_id === null ? null : Number(row.employee_id),
    }

    const effective = await loadEffectivePermissions(db, user.id)

    c.set('user', user)
    c.set('session', {
      id: session.id,
      csrfToken: session.csrfToken,
      totpVerified: session.totpVerified,
      expiresAt: session.expiresAt,
    })
    c.set('perms', effective.perms)
    c.set('roleKeys', effective.roleKeys)
    c.set('requires2fa', effective.requires2fa)
    c.set('scope', {
      userId: user.id,
      scopeToAssignedProjects: effective.scopeToAssignedProjects,
    })

    const now = Date.now()
    const previous = lastTouched.get(session.id) ?? 0
    if (now - previous > TOUCH_INTERVAL_MS) {
      lastTouched.set(session.id, now)
      if (lastTouched.size > 500) lastTouched.clear()
      await touchSession(db, session.id)
    }

    /* Sliding renewal (DECISIONS 34.1): ONLY for the staff flavour, ONLY
     * once the session is past half its 30-day life. The office flavour
     * keeps its absolute 12 h -- the shared-computer risk the original spec
     * cites. The flavour is recomputed from the SAME roles this middleware
     * already loaded, so no extra query and no stored flag to keep in step:
     * a role change takes effect on the very next request. Below half left,
     * push expires_at a fresh 30 days and rewrite the cookie so the
     * BROWSER's clock extends too (a DB row that outlives its cookie would
     * log the worker out anyway). At most one renewal per ~15 days per
     * active session, so this stays off the hot path. */
    const staff = isStaffSession(effective.roleKeys)
    if (
      staff &&
      dueForRenewal(session.expiresAtMs, STAFF_SESSION_TTL_SECONDS, now) &&
      now - (lastRenewal.get(session.id) ?? 0) > TOUCH_INTERVAL_MS
    ) {
      const expiresAt = await extendSession(db, session.id, STAFF_SESSION_TTL_SECONDS)
      lastRenewal.set(session.id, now)
      if (lastRenewal.size > 500) lastRenewal.clear()
      setCookie(c, COOKIE_NAME, cookie, {
        ...cookieOptions(isProd, STAFF_SESSION_TTL_SECONDS),
        expires: new Date(expiresAt.replace(' ', 'T') + '+05:30'),
      })
    }

    return next()
  }
}
