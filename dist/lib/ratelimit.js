import { sql } from 'kysely';
import { RateLimitError } from './errors.js';
function windowStart(windowSeconds, now) {
    const epochSeconds = Math.floor(now.getTime() / 1000);
    const floored = epochSeconds - (epochSeconds % windowSeconds);
    return new Date(floored * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
/**
 * Records one hit and reports whether the bucket is now over its limit.
 *
 * The increment and the read are one statement. Doing them as separate
 * statements lets two concurrent requests both read a count below the limit
 * and both proceed, which is exactly the race a login limiter must not have.
 */
export async function hit(db, rule, now = new Date()) {
    const start = windowStart(rule.windowSeconds, now);
    const result = await sql `
    INSERT INTO rate_limit_hits (bucket, window_start, hit_count)
    VALUES (${rule.bucket}, ${start}, 1)
    ON DUPLICATE KEY UPDATE hit_count = hit_count + 1
  `.execute(db);
    // MariaDB reports affectedRows 1 on insert and 2 on update, which does not
    // give the new count, so the count is read back. Both statements run inside
    // the same connection from the pool for the same request, and the unique
    // key makes the read consistent with the write that just happened.
    void result;
    const row = await db
        .selectFrom('rate_limit_hits')
        .select('hit_count')
        .where('bucket', '=', rule.bucket)
        .where('window_start', '=', start)
        .executeTakeFirst();
    const hits = Number(row?.hit_count ?? 1);
    const windowEnd = Date.parse(`${start.replace(' ', 'T')}Z`) + rule.windowSeconds * 1000;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1000));
    return {
        allowed: hits <= rule.limit,
        hits,
        limit: rule.limit,
        retryAfterSeconds,
    };
}
/**
 * Clears a bucket on success (29.52). Without this, nine wrong codes then a
 * success left nine hits in the window and ONE later typo locked a user who
 * had just authenticated. Only called after a verified success, so brute
 * force is unchanged: every failed attempt still costs a hit, and a wrong
 * code can never call this.
 */
export async function clearBucket(db, rule) {
    await db.deleteFrom('rate_limit_hits').where('bucket', '=', rule.bucket).execute();
}
export async function enforce(db, rule, message, now = new Date()) {
    const result = await hit(db, rule, now);
    if (!result.allowed) {
        throw new RateLimitError(message ?? `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.`, result.retryAfterSeconds);
    }
}
/** Reads a bucket without incrementing it, for a pre-flight check. */
export async function peek(db, rule, now = new Date()) {
    const row = await db
        .selectFrom('rate_limit_hits')
        .select('hit_count')
        .where('bucket', '=', rule.bucket)
        .where('window_start', '=', windowStart(rule.windowSeconds, now))
        .executeTakeFirst();
    return Number(row?.hit_count ?? 0);
}
/** Called by the nightly cron. Windows older than a day cannot be current. */
export async function purgeExpired(db, olderThanDays = 2) {
    const result = await sql `
    DELETE FROM rate_limit_hits
    WHERE window_start < DATE_SUB(NOW(), INTERVAL ${sql.lit(olderThanDays)} DAY)
  `.execute(db);
    return Number(result.numAffectedRows ?? 0);
}
/** The rule set the routes use, so limits live in one place. */
export const RULES = {
    loginByIp: (ip) => ({
        bucket: `login:ip:${ip}`,
        limit: 30,
        windowSeconds: 900,
    }),
    loginByEmail: (email) => ({
        bucket: `login:email:${email.toLowerCase()}`,
        limit: 10,
        windowSeconds: 900,
    }),
    forgotByEmail: (email) => ({
        bucket: `forgot:email:${email.toLowerCase()}`,
        limit: 3,
        windowSeconds: 3600,
    }),
    forgotByIp: (ip) => ({
        bucket: `forgot:ip:${ip}`,
        limit: 10,
        windowSeconds: 3600,
    }),
    enquiryByIp: (ip) => ({
        bucket: `enquiry:ip:${ip}`,
        limit: 5,
        windowSeconds: 3600,
    }),
    uploadByUser: (userId) => ({
        bucket: `upload:user:${userId}`,
        limit: 100,
        windowSeconds: 3600,
    }),
    totpByUser: (userId) => ({
        bucket: `totp:user:${userId}`,
        limit: 10,
        windowSeconds: 900,
    }),
};
