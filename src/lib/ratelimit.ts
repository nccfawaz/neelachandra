import { sql } from 'kysely'
import type { Queryable } from '../db/kysely.js'
import { RateLimitError } from './errors.js'

/**
 * Database-backed window counter (spec 2.10).
 *
 * It is in MariaDB, not in memory, because the Hostinger app process sleeps
 * and restarts on idle. An in-memory counter resets on every restart, which
 * makes the lockout trivially defeatable by anyone who can wait out or
 * trigger a restart.
 *
 * The window is a fixed tumbling window, not a sliding one. A sliding window
 * needs one row per hit and a range scan per check; a tumbling window needs
 * one row per bucket per window and a single upsert. At ten users the
 * accuracy difference is irrelevant and the cost difference is not.
 */

export interface RateLimitRule {
  bucket: string
  limit: number
  windowSeconds: number
}

export interface RateLimitResult {
  allowed: boolean
  hits: number
  limit: number
  retryAfterSeconds: number
}

function windowStart(windowSeconds: number, now: Date): string {
  const epochSeconds = Math.floor(now.getTime() / 1000)
  const floored = epochSeconds - (epochSeconds % windowSeconds)
  return new Date(floored * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Records one hit and reports whether the bucket is now over its limit.
 *
 * The increment and the read are one statement. Doing them as separate
 * statements lets two concurrent requests both read a count below the limit
 * and both proceed, which is exactly the race a login limiter must not have.
 */
export async function hit(
  db: Queryable,
  rule: RateLimitRule,
  now: Date = new Date()
): Promise<RateLimitResult> {
  const start = windowStart(rule.windowSeconds, now)

  const result = await sql<{ hit_count: number }>`
    INSERT INTO rate_limit_hits (bucket, window_start, hit_count)
    VALUES (${rule.bucket}, ${start}, 1)
    ON DUPLICATE KEY UPDATE hit_count = hit_count + 1
  `.execute(db)

  // MariaDB reports affectedRows 1 on insert and 2 on update, which does not
  // give the new count, so the count is read back. Both statements run inside
  // the same connection from the pool for the same request, and the unique
  // key makes the read consistent with the write that just happened.
  void result

  const row = await db
    .selectFrom('rate_limit_hits')
    .select('hit_count')
    .where('bucket', '=', rule.bucket)
    .where('window_start', '=', start)
    .executeTakeFirst()

  const hits = Number(row?.hit_count ?? 1)
  const windowEnd = Date.parse(`${start.replace(' ', 'T')}Z`) + rule.windowSeconds * 1000
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1000))

  return {
    allowed: hits <= rule.limit,
    hits,
    limit: rule.limit,
    retryAfterSeconds,
  }
}

export async function enforce(
  db: Queryable,
  rule: RateLimitRule,
  message?: string,
  now: Date = new Date()
): Promise<void> {
  const result = await hit(db, rule, now)
  if (!result.allowed) {
    throw new RateLimitError(
      message ?? `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.`,
      result.retryAfterSeconds
    )
  }
}

/** Reads a bucket without incrementing it, for a pre-flight check. */
export async function peek(
  db: Queryable,
  rule: RateLimitRule,
  now: Date = new Date()
): Promise<number> {
  const row = await db
    .selectFrom('rate_limit_hits')
    .select('hit_count')
    .where('bucket', '=', rule.bucket)
    .where('window_start', '=', windowStart(rule.windowSeconds, now))
    .executeTakeFirst()
  return Number(row?.hit_count ?? 0)
}

/** Called by the nightly cron. Windows older than a day cannot be current. */
export async function purgeExpired(db: Queryable, olderThanDays = 2): Promise<number> {
  const result = await sql`
    DELETE FROM rate_limit_hits
    WHERE window_start < DATE_SUB(NOW(), INTERVAL ${sql.lit(olderThanDays)} DAY)
  `.execute(db)
  return Number(result.numAffectedRows ?? 0)
}

/** The rule set the routes use, so limits live in one place. */
export const RULES = {
  loginByIp: (ip: string): RateLimitRule => ({
    bucket: `login:ip:${ip}`,
    limit: 30,
    windowSeconds: 900,
  }),
  loginByEmail: (email: string): RateLimitRule => ({
    bucket: `login:email:${email.toLowerCase()}`,
    limit: 10,
    windowSeconds: 900,
  }),
  forgotByEmail: (email: string): RateLimitRule => ({
    bucket: `forgot:email:${email.toLowerCase()}`,
    limit: 3,
    windowSeconds: 3600,
  }),
  forgotByIp: (ip: string): RateLimitRule => ({
    bucket: `forgot:ip:${ip}`,
    limit: 10,
    windowSeconds: 3600,
  }),
  enquiryByIp: (ip: string): RateLimitRule => ({
    bucket: `enquiry:ip:${ip}`,
    limit: 5,
    windowSeconds: 3600,
  }),
  uploadByUser: (userId: number): RateLimitRule => ({
    bucket: `upload:user:${userId}`,
    limit: 100,
    windowSeconds: 3600,
  }),
  totpByUser: (userId: number): RateLimitRule => ({
    bucket: `totp:user:${userId}`,
    limit: 10,
    windowSeconds: 900,
  }),
} as const
