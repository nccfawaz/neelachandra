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
export const SESSION_TTL_SECONDS = 12 * 60 * 60

export interface CreatedSession {
  cookieValue: string
  sessionId: string
  csrfToken: string
  expiresAt: string
}

export async function createSession(
  db: Queryable,
  opts: {
    userId: number
    ip?: string | null
    userAgent?: string | null
    totpVerified?: boolean
  }
): Promise<CreatedSession> {
  const cookieValue = randomToken(32)
  const sessionId = sha256Hex(cookieValue)
  const csrfToken = sha256Hex(randomToken(32))
  const expiresAt = sqlDateTimeIn(SESSION_TTL_SECONDS)

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

  return { cookieValue, sessionId, csrfToken, expiresAt }
}

export interface LoadedSession {
  id: string
  userId: number
  csrfToken: string
  totpVerified: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
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

  return {
    id: row.id,
    userId: Number(row.user_id),
    csrfToken: row.csrf_token,
    totpVerified: Number(row.totp_verified) === 1,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
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
 * Rotation on privilege change (spec 6.1). Any successful TOTP verify,
 * password change or role edit issues a new session id and deletes the old
 * row. This is the session fixation mitigation and it is cheap because there
 * is a session table anyway.
 */
export async function rotateSession(
  trx: Trx,
  oldSessionId: string,
  opts: { totpVerified?: boolean; ip?: string | null; userAgent?: string | null } = {}
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

export function cookieOptions(isProd: boolean) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  }
}
