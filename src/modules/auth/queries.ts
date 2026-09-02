import { sql } from 'kysely'
import type { Queryable, Trx } from '../../db/kysely.js'
import { ipToBuffer } from '../../lib/crypto.js'
import { nowSqlDateTime } from '../../lib/dates.js'

/**
 * Data access for the auth module. Nothing here decides anything: the rules
 * live in service.ts. Keeping the split means the lockout policy can be read
 * in one place instead of being spread across five SQL statements.
 */

export interface AuthUserRow {
  id: number
  email: string
  full_name: string
  password_hash: string | null
  status: 'invited' | 'active' | 'suspended' | 'inactive'
  must_change_password: number
  totp_secret: Buffer | null
  totp_confirmed_at: string | null
  locked_until: string | null
  failed_login_count: number
}

export async function findUserByEmail(db: Queryable, email: string): Promise<AuthUserRow | null> {
  const row = await db
    .selectFrom('users')
    .select([
      'id',
      'email',
      'full_name',
      'password_hash',
      'status',
      'must_change_password',
      'totp_secret',
      'totp_confirmed_at',
      'locked_until',
      'failed_login_count',
    ])
    .where('email', '=', email.trim().toLowerCase())
    .executeTakeFirst()

  if (!row) return null
  return {
    id: Number(row.id),
    email: row.email,
    full_name: row.full_name,
    password_hash: row.password_hash,
    status: row.status,
    must_change_password: Number(row.must_change_password),
    totp_secret: row.totp_secret,
    totp_confirmed_at: row.totp_confirmed_at === null ? null : String(row.totp_confirmed_at),
    locked_until: row.locked_until === null ? null : String(row.locked_until),
    failed_login_count: Number(row.failed_login_count),
  }
}

export async function findUserById(db: Queryable, id: number): Promise<AuthUserRow | null> {
  const row = await db
    .selectFrom('users')
    .select([
      'id',
      'email',
      'full_name',
      'password_hash',
      'status',
      'must_change_password',
      'totp_secret',
      'totp_confirmed_at',
      'locked_until',
      'failed_login_count',
    ])
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) return null
  return {
    id: Number(row.id),
    email: row.email,
    full_name: row.full_name,
    password_hash: row.password_hash,
    status: row.status,
    must_change_password: Number(row.must_change_password),
    totp_secret: row.totp_secret,
    totp_confirmed_at: row.totp_confirmed_at === null ? null : String(row.totp_confirmed_at),
    locked_until: row.locked_until === null ? null : String(row.locked_until),
    failed_login_count: Number(row.failed_login_count),
  }
}

export async function recordAttempt(
  db: Queryable,
  opts: { email: string | null; ip: string | null; succeeded: boolean }
): Promise<void> {
  await db
    .insertInto('login_attempts')
    .values({
      email: opts.email === null ? null : opts.email.trim().toLowerCase().slice(0, 190),
      ip: ipToBuffer(opts.ip),
      succeeded: opts.succeeded ? 1 : 0,
      attempted_at: nowSqlDateTime(),
    })
    .execute()
}

/**
 * Failure counts for the two lockout windows in one round trip, because
 * running them as two queries at different instants can straddle a window
 * boundary and produce an inconsistent decision.
 */
export async function failureCounts(
  db: Queryable,
  email: string,
  ip: string | null
): Promise<{ emailShort: number; emailLong: number; ipShort: number; ipLong: number }> {
  const normalised = email.trim().toLowerCase()
  const ipBuf = ipToBuffer(ip)

  const result = await sql<{
    email_short: number
    email_long: number
    ip_short: number
    ip_long: number
  }>`
    SELECT
      SUM(succeeded = 0 AND email = ${normalised} AND attempted_at >= NOW() - INTERVAL 15 MINUTE) AS email_short,
      SUM(succeeded = 0 AND email = ${normalised} AND attempted_at >= NOW() - INTERVAL 60 MINUTE) AS email_long,
      SUM(succeeded = 0 AND ip = ${ipBuf} AND attempted_at >= NOW() - INTERVAL 15 MINUTE) AS ip_short,
      SUM(succeeded = 0 AND ip = ${ipBuf} AND attempted_at >= NOW() - INTERVAL 60 MINUTE) AS ip_long
    FROM login_attempts
    WHERE attempted_at >= NOW() - INTERVAL 60 MINUTE
  `.execute(db)

  const r = result.rows[0]
  return {
    emailShort: Number(r?.email_short ?? 0),
    emailLong: Number(r?.email_long ?? 0),
    ipShort: Number(r?.ip_short ?? 0),
    ipLong: Number(r?.ip_long ?? 0),
  }
}

export async function setLock(db: Queryable, userId: number, until: string | null): Promise<void> {
  await db.updateTable('users').set({ locked_until: until }).where('id', '=', userId).execute()
}

export async function bumpFailure(db: Queryable, userId: number): Promise<void> {
  await db
    .updateTable('users')
    .set((eb) => ({ failed_login_count: eb('failed_login_count', '+', 1) }))
    .where('id', '=', userId)
    .execute()
}

export async function markLoginSuccess(
  db: Queryable,
  userId: number,
  ip: string | null
): Promise<void> {
  await db
    .updateTable('users')
    .set({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: nowSqlDateTime(),
      last_login_ip: ipToBuffer(ip),
      // An invited user who has just proved a password is active. Leaving
      // them 'invited' would keep the account looking unclaimed on the admin
      // list forever.
      status: 'active',
    })
    .where('id', '=', userId)
    .execute()
}

/* Reset and invite tokens ------------------------------------------------ */

export async function insertToken(
  db: Queryable,
  opts: {
    userId: number
    tokenHash: string
    purpose: 'invite' | 'reset'
    expiresAt: string
    ip: string | null
  }
): Promise<void> {
  await db
    .insertInto('password_reset_tokens')
    .values({
      user_id: opts.userId,
      token_hash: opts.tokenHash,
      purpose: opts.purpose,
      expires_at: opts.expiresAt,
      created_ip: ipToBuffer(opts.ip),
    })
    .execute()
}

export interface TokenRow {
  id: number
  userId: number
  purpose: 'invite' | 'reset'
}

/** Unused and unexpired only. An expired token is indistinguishable from a bad one. */
export async function findLiveToken(db: Queryable, tokenHash: string): Promise<TokenRow | null> {
  const row = await db
    .selectFrom('password_reset_tokens')
    .select(['id', 'user_id', 'purpose'])
    .where('token_hash', '=', tokenHash)
    .where('used_at', 'is', null)
    .where('expires_at', '>', nowSqlDateTime())
    .executeTakeFirst()
  if (!row) return null
  return { id: Number(row.id), userId: Number(row.user_id), purpose: row.purpose }
}

export async function consumeToken(trx: Trx, tokenId: number): Promise<void> {
  await trx
    .updateTable('password_reset_tokens')
    .set({ used_at: nowSqlDateTime() })
    .where('id', '=', tokenId)
    .where('used_at', 'is', null)
    .execute()
}

/** Invalidates every other live token for the user, so an old invite email dies. */
export async function invalidateOtherTokens(
  trx: Trx,
  userId: number,
  exceptId: number
): Promise<void> {
  await trx
    .updateTable('password_reset_tokens')
    .set({ used_at: nowSqlDateTime() })
    .where('user_id', '=', userId)
    .where('id', '!=', exceptId)
    .where('used_at', 'is', null)
    .execute()
}

export async function setPassword(
  trx: Trx,
  userId: number,
  hash: string
): Promise<void> {
  await trx
    .updateTable('users')
    .set({
      password_hash: hash,
      password_algo: 'argon2id',
      must_change_password: 0,
      password_changed_at: nowSqlDateTime(),
      failed_login_count: 0,
      locked_until: null,
    })
    .where('id', '=', userId)
    .execute()
}

export async function setTotpSecret(
  trx: Trx,
  userId: number,
  secret: Buffer | null,
  confirmed: boolean
): Promise<void> {
  await trx
    .updateTable('users')
    .set({
      totp_secret: secret,
      totp_confirmed_at: confirmed ? nowSqlDateTime() : null,
    })
    .where('id', '=', userId)
    .execute()
}

/** The owner's address, for the 24 hour lockout alert. */
export async function ownerEmails(db: Queryable): Promise<string[]> {
  const rows = await db
    .selectFrom('users')
    .innerJoin('user_roles', 'user_roles.user_id', 'users.id')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .select('users.email as email')
    .where('roles.key', '=', 'owner')
    .where('users.status', '=', 'active')
    .execute()
  return rows.map((r) => r.email)
}
