import type { Queryable, Trx } from '../db/kysely.js'
import { ipToBuffer, randomToken, sha256Hex } from './crypto.js'
import { nowSqlDateTime, sqlDateTimeIn } from './dates.js'

/**
 * Session create, read, rotate and destroy (spec 2.5, 6.1).
 *
 * The cookie holds a 32-byte random value; the database stores only its
 * SHA-256. A database disclosure therefore does not hand over working
 * cookies, which is the same reasoning as not storing passwords in plain
 * text. There is no need for a slow hash here because the value is 256 bits
 * of entropy rather than something guessable.
 *
 * Expiry is absolute at 12 hours, not sliding: last_seen_at is updated for
 * idle display in the sessions screen and does not extend the session. A
 * sliding session on a shared site computer never expires.
 */

export const COOKIE_NAME = 'ncc_sid'

/** Office and admin flavour: absolute 12 hours, never extended (spec 2.5). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60
/** Site-staff flavour: 30 days, sliding at half-life (DECISIONS 34.1). */
export const STAFF_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
/** A session past half its life is renewed on the next request, so an
 * actively used staff phone never hits the wall. Renewals are therefore at
 * most one per ~15 days per session -- off the hot path. */
export const RENEWAL_FRACTION = 0.5

/**
 * Which flavour a login gets, decided from the user's ROLE KEYS at login
 * time (DECISIONS 34.1, extended 34.2) -- not a per-user flag, so a new hire
 * assigned a site role gets the long session automatically and an account
 * promoted into the office keeps it on the next login. A user holding ANY
 * staff role gets the staff flavour: the longest session follows the most
 * field-facing hat they wear.
 *
 * The owner's decision on 2026-09-26 (34.2) gives the rolling month to every
 * operational role that works away from a shared office machine: the three
 * original field roles, plus project_manager, procurement_executive,
 * sales_exec, ops_manager and digital_marketing. What stays on the absolute
 * 12 h is the small set of privileged, sensitive-data, often-2FA roles --
 * owner, admin, accounts_manager, hr_manager -- because a 30-day cookie on a
 * shared desk is the exact exposure the short flavour exists to bound
 * (company money, user/role administration, employee PII). Those four are
 * DELIBERATELY absent from this list; see 34.2 for the reasoning.
 */
export const STAFF_ROLE_KEYS: readonly string[] = [
  'site_engineer',
  'site_supervisor',
  'qa_qc',
  'project_manager',
  'procurement_executive',
  'sales_exec',
  'ops_manager',
  'digital_marketing',
]

export function isStaffSession(roleKeys: readonly string[]): boolean {
  return roleKeys.some((k) => STAFF_ROLE_KEYS.includes(k))
}

export function ttlFor(isStaff: boolean): number {
  return isStaff ? STAFF_SESSION_TTL_SECONDS : SESSION_TTL_SECONDS
}

export interface CreatedSession {
  cookieValue: string
  sessionId: string
  csrfToken: string
  expiresAt: string
  /** Which flavour was applied, so callers can set a matching cookie. */
  isStaffFlavour: boolean
}

export async function createSession(
  db: Queryable,
  opts: {
    userId: number
    ip?: string | null
    userAgent?: string | null
    totpVerified?: boolean
    /** Decided by the caller from the user's roles at login (34.1). */
    isStaff?: boolean
  }
): Promise<CreatedSession> {
  const cookieValue = randomToken(32)
  const sessionId = sha256Hex(cookieValue)
  const csrfToken = sha256Hex(randomToken(32))
  const ttl = ttlFor(opts.isStaff ?? false)
  const expiresAt = sqlDateTimeIn(ttl)

  await db
    .insertInto('user_sessions')
    .values({
      id: sessionId,
      user_id: opts.userId,
      expires_at: expiresAt,
      ip: ipToBuffer(opts.ip ?? null),
      user_agent: (opts.userAgent ?? '').slice(0, 255) || null,
      totp_verified: opts.totpVerified ? 1 : 0,
      csrf_token: csrfToken,
    })
    .execute()

  return { cookieValue, sessionId, csrfToken, expiresAt, isStaffFlavour: opts.isStaff ?? false }
}

export interface LoadedSession {
  id: string
  userId: number
  csrfToken: string
  totpVerified: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  /** Epoch ms; 0 when the row somehow parses wrong (then never renew). */
  expiresAtMs: number
}

export async function loadSession(
  db: Queryable,
  cookieValue: string
): Promise<LoadedSession | null> {
  const id = sha256Hex(cookieValue)
  const row = await db
    .selectFrom('user_sessions')
    .select([
      'id',
      'user_id',
      'csrf_token',
      'totp_verified',
      'created_at',
      'last_seen_at',
      'expires_at',
      'revoked_at',
    ])
    .where('id', '=', id)
    .executeTakeFirst()

  if (!row) return null
  if (row.revoked_at !== null) return null
  if (String(row.expires_at) <= nowSqlDateTime()) return null

  const expiresAtMs = Date.parse(String(row.expires_at).replace(' ', 'T') + '+05:30') || 0

  return {
    id: row.id,
    userId: Number(row.user_id),
    csrfToken: row.csrf_token,
    totpVerified: Number(row.totp_verified) === 1,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
    expiresAtMs,
  }
}

/** Idle display only. Deliberately does not extend expires_at. */
export async function touchSession(db: Queryable, sessionId: string): Promise<void> {
  await db
    .updateTable('user_sessions')
    .set({ last_seen_at: nowSqlDateTime() })
    .where('id', '=', sessionId)
    .execute()
}

/**
 * Sliding renewal for the staff flavour (DECISIONS 34.1): push expires_at a
 * full TTL into the future. Called only when the session is past half its
 * life, so writes are rare. Returns the new expiry for the cookie rewrite.
 */
export async function extendSession(
  db: Queryable,
  sessionId: string,
  ttlSeconds: number
): Promise<string> {
  const expiresAt = sqlDateTimeIn(ttlSeconds)
  await db
    .updateTable('user_sessions')
    .set({ expires_at: expiresAt })
    .where('id', '=', sessionId)
    .execute()
  return expiresAt
}

/**
 * Whether a session is past half its TTL and due for renewal. Unknown or
 * unparsable expiry never renews (fail closed: the old absolute expiry
 * stands, which is at worst the previous behaviour).
 */
export function dueForRenewal(expiresAtMs: number, ttlSeconds: number, nowMs = Date.now()): boolean {
  if (expiresAtMs <= 0) return false
  const remaining = expiresAtMs - nowMs
  return remaining < ttlSeconds * 1000 * RENEWAL_FRACTION
}

/**
 * Rotation on privilege change (spec 6.1). Any successful TOTP verify,
 * password change or role edit issues a new session id and deletes the old
 * row. This is the session fixation mitigation and it is cheap because there
 * is a session table anyway.
 */
export async function rotateSession(
  trx: Trx,
  oldSessionId: string,
  opts: { totpVerified?: boolean; ip?: string | null; userAgent?: string | null; isStaff?: boolean } = {}
): Promise<CreatedSession> {
  const existing = await trx
    .selectFrom('user_sessions')
    .select(['user_id', 'totp_verified', 'ip', 'user_agent'])
    .where('id', '=', oldSessionId)
    .executeTakeFirstOrThrow()

  const created = await createSession(trx, {
    userId: Number(existing.user_id),
    ip: opts.ip ?? null,
    userAgent: opts.userAgent ?? existing.user_agent ?? null,
    totpVerified: opts.totpVerified ?? Number(existing.totp_verified) === 1,
    // A rotation preserves the user's CURRENT flavour only when the caller
    // says so; callers that know better (password change after a role
    // change) recompute. Defaulting to false keeps every existing call site
    // at the office TTL, which is the conservative choice.
    isStaff: opts.isStaff,
  })

  await trx.deleteFrom('user_sessions').where('id', '=', oldSessionId).execute()
  return created
}

export async function markTotpVerified(db: Queryable, sessionId: string): Promise<void> {
  await db
    .updateTable('user_sessions')
    .set({ totp_verified: 1 })
    .where('id', '=', sessionId)
    .execute()
}

export async function destroySession(db: Queryable, sessionId: string): Promise<void> {
  await db.deleteFrom('user_sessions').where('id', '=', sessionId).execute()
}

/**
 * Deletes every session for a user. Called on password reset (so a stolen
 * session cannot survive a reset), on deactivation (so a departing employee
 * does not keep a working cookie for up to 12 hours) and on a forced logout
 * from the admin screen.
 */
export async function destroyAllUserSessions(
  db: Queryable,
  userId: number,
  exceptSessionId?: string
): Promise<number> {
  let q = db.deleteFrom('user_sessions').where('user_id', '=', userId)
  if (exceptSessionId) q = q.where('id', '!=', exceptSessionId)
  const result = await q.executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}

export async function listUserSessions(db: Queryable, userId: number) {
  return db
    .selectFrom('user_sessions')
    .select(['id', 'created_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent', 'totp_verified'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', nowSqlDateTime())
    .orderBy('last_seen_at', 'desc')
    .execute()
}

/** Nightly cron housekeeping. Expired rows are not needed for anything. */
export async function purgeExpiredSessions(db: Queryable): Promise<number> {
  const result = await db
    .deleteFrom('user_sessions')
    .where('expires_at', '<', nowSqlDateTime())
    .executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}

export function cookieOptions(isProd: boolean, ttlSeconds: number = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: ttlSeconds,
  }
}
