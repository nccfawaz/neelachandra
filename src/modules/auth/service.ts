import type { Db, Trx } from '../../db/kysely.js'
import { getDb } from '../../db/kysely.js'
import { randomToken, sha256Hex } from '../../lib/crypto.js'
import { nowSqlDateTime, sqlDateTimeIn } from '../../lib/dates.js'
import { UnprocessableError } from '../../lib/errors.js'
import { inviteEmail, lockoutAlertEmail, resetEmail, send } from '../../lib/mailer.js'
import { assertPasswordPolicy, burnVerify, hashPassword, verifyPassword } from '../../lib/password.js'
import { RULES, hit } from '../../lib/ratelimit.js'
import { createSession, destroyAllUserSessions, rotateSession } from '../../lib/session.js'
import {
  consumeRecoveryCode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSecret,
  storeRecoveryCodes,
  verifyCode,
} from '../../lib/totp.js'
import { writeAudit } from '../../lib/audit.js'
import { env } from '../../env.js'
import * as q from './queries.js'

/**
 * Auth business logic (spec 6.1).
 *
 * The single most important property here: every failure path costs roughly
 * the same and says exactly the same thing. A wrong password, an unknown
 * email, a suspended account and an unaccepted invite are all
 * GENERIC_FAILURE, and the miss path still burns an argon2 verify. Anything
 * else turns the login form into a user directory.
 */

export const GENERIC_FAILURE = 'That email and password combination is not recognised.'

const INVITE_HOURS = 24
const RESET_HOURS = 2
const SHORT_WINDOW_LIMIT = 5
const SHORT_LOCK_MINUTES = 15
const LONG_WINDOW_LIMIT = 10
const LONG_LOCK_HOURS = 24

export type LoginOutcome =
  | { kind: 'ok'; cookieValue: string; userId: number; needsTotp: boolean; mustChangePassword: boolean }
  | { kind: 'failed'; message: string }
  | { kind: 'locked'; message: string }

/**
 * Progressive lockout (spec 6.1): 5 failures in 15 minutes locks for 15
 * minutes, 10 in an hour locks for 24 hours and emails the owner. Counted
 * from login_attempts and written to users.locked_until so it survives the
 * Hostinger process restarting.
 */
async function applyLockout(
  db: Db,
  user: q.AuthUserRow,
  ip: string | null
): Promise<{ locked: boolean; until: string | null }> {
  const counts = await q.failureCounts(db, user.email, ip)

  if (counts.emailLong >= LONG_WINDOW_LIMIT) {
    const until = sqlDateTimeIn(LONG_LOCK_HOURS * 3600)
    await q.setLock(db, user.id, until)
    // The owner is told because a 24 hour lock is either a real attack or a
    // colleague who cannot get in, and both need a human.
    for (const address of await q.ownerEmails(db)) {
      const mail = lockoutAlertEmail({
        email: user.email,
        attempts: counts.emailLong,
        windowLabel: 'one hour',
      })
      await send(db, {
        to: address,
        subject: mail.subject,
        text: mail.text,
        templateKey: 'auth.lockout_alert',
        entityType: 'users',
        entityId: user.id,
      })
    }
    return { locked: true, until }
  }

  if (counts.emailShort >= SHORT_WINDOW_LIMIT) {
    const until = sqlDateTimeIn(SHORT_LOCK_MINUTES * 60)
    await q.setLock(db, user.id, until)
    return { locked: true, until }
  }

  return { locked: false, until: null }
}

export async function login(opts: {
  email: string
  password: string
  ip: string | null
  userAgent: string | null
}): Promise<LoginOutcome> {
  const db = getDb()

  // Rate limits are per IP and per email and are checked before any lookup,
  // so a script cannot enumerate at speed even against non-existent accounts.
  if (opts.ip) {
    const byIp = await hit(db, RULES.loginByIp(opts.ip))
    if (!byIp.allowed) {
      return { kind: 'locked', message: `Too many attempts from this network. Try again in ${Math.ceil(byIp.retryAfterSeconds / 60)} minutes.` }
    }
  }
  const byEmail = await hit(db, RULES.loginByEmail(opts.email))
  if (!byEmail.allowed) {
    return { kind: 'locked', message: `Too many attempts for this account. Try again in ${Math.ceil(byEmail.retryAfterSeconds / 60)} minutes.` }
  }

  const user = await q.findUserByEmail(db, opts.email)

  if (!user) {
    // The dummy verify is the whole point: the miss path must cost the same
    // ~40ms as the hit path, or response time alone reveals which addresses
    // are real (spec 6.1).
    await burnVerify(opts.password)
    await q.recordAttempt(db, { email: opts.email, ip: opts.ip, succeeded: false })
    return { kind: 'failed', message: GENERIC_FAILURE }
  }

  if (user.locked_until !== null && String(user.locked_until) > nowSqlDateTime()) {
    await burnVerify(opts.password)
    await q.recordAttempt(db, { email: opts.email, ip: opts.ip, succeeded: false })
    return {
      kind: 'locked',
      message: 'This account is temporarily locked after repeated failed attempts. Try again later or use Forgot password.',
    }
  }

  // An invited account has no hash yet, and a suspended or inactive one must
  // not sign in. Both return the SAME generic failure as a wrong password
  // (spec 6.1), so the form cannot be used to discover account states.
  if (user.password_hash === null || user.status === 'suspended' || user.status === 'inactive') {
    await burnVerify(opts.password)
    await q.recordAttempt(db, { email: opts.email, ip: opts.ip, succeeded: false })
    // Silently reissue an invite whose token has expired, so the person's
    // next action (asking why they cannot get in) has an email waiting.
    if (user.status === 'invited' && user.password_hash === null) {
      await maybeReissueInvite(db, user)
    }
    return { kind: 'failed', message: GENERIC_FAILURE }
  }

  const ok = await verifyPassword(user.password_hash, opts.password)
  if (!ok) {
    await q.recordAttempt(db, { email: opts.email, ip: opts.ip, succeeded: false })
    await q.bumpFailure(db, user.id)
    const lock = await applyLockout(db, user, opts.ip)
    if (lock.locked) {
      return {
        kind: 'locked',
        message: 'This account is now temporarily locked after repeated failed attempts.',
      }
    }
    return { kind: 'failed', message: GENERIC_FAILURE }
  }

  await q.recordAttempt(db, { email: opts.email, ip: opts.ip, succeeded: true })
  await q.markLoginSuccess(db, user.id, opts.ip)

  const session = await createSession(db, {
    userId: user.id,
    ip: opts.ip,
    userAgent: opts.userAgent,
    // Half authenticated until TOTP passes (spec 6.1).
    totpVerified: false,
  })

  await db.transaction().execute(async (trx) => {
    await writeAudit(trx, {
      userId: user.id,
      action: 'auth.login',
      entityType: 'users',
      entityId: user.id,
      ip: opts.ip,
    })
  })

  return {
    kind: 'ok',
    cookieValue: session.cookieValue,
    userId: user.id,
    needsTotp: user.totp_confirmed_at !== null,
    mustChangePassword: user.must_change_password === 1,
  }
}

/** Reissues an invite only when no live invite token remains. */
async function maybeReissueInvite(db: Db, user: q.AuthUserRow): Promise<void> {
  const live = await db
    .selectFrom('password_reset_tokens')
    .select('id')
    .where('user_id', '=', user.id)
    .where('purpose', '=', 'invite')
    .where('used_at', 'is', null)
    .where('expires_at', '>', nowSqlDateTime())
    .executeTakeFirst()
  if (live) return
  await issueInvite(db, user.id, user.email, user.full_name, null)
}

/* Invites and resets ----------------------------------------------------- */

export async function issueInvite(
  db: Db,
  userId: number,
  email: string,
  fullName: string,
  ip: string | null
): Promise<string> {
  const token = randomToken(32)
  await q.insertToken(db, {
    userId,
    tokenHash: sha256Hex(token),
    purpose: 'invite',
    expiresAt: sqlDateTimeIn(INVITE_HOURS * 3600),
    ip,
  })
  const link = `${env.APP_BASE_URL}/reset-password/${token}`
  const mail = inviteEmail({ fullName, link, hours: INVITE_HOURS })
  await send(db, {
    to: email,
    subject: mail.subject,
    text: mail.text,
    templateKey: 'auth.invite',
    entityType: 'users',
    entityId: userId,
  })
  return link
}

/**
 * Always reports success to the caller regardless of whether the address
 * exists (spec 6.1). The rate limit is the only thing that differs, and it is
 * applied to the address as typed so a miss still consumes quota.
 */
export async function requestReset(opts: {
  email: string
  ip: string | null
}): Promise<void> {
  const db = getDb()

  if (opts.ip) {
    const byIp = await hit(db, RULES.forgotByIp(opts.ip))
    if (!byIp.allowed) return
  }
  const byEmail = await hit(db, RULES.forgotByEmail(opts.email))
  if (!byEmail.allowed) return

  const user = await q.findUserByEmail(db, opts.email)
  if (!user) return
  if (user.status === 'inactive' || user.status === 'suspended') return

  const token = randomToken(32)
  await q.insertToken(db, {
    userId: user.id,
    tokenHash: sha256Hex(token),
    // An invited user asking to reset gets an invite-purpose token, because
    // the reset screen must not ask them for a current password they do not
    // have.
    purpose: user.password_hash === null ? 'invite' : 'reset',
    expiresAt: sqlDateTimeIn(RESET_HOURS * 3600),
    ip: opts.ip,
  })

  const link = `${env.APP_BASE_URL}/reset-password/${token}`
  const mail =
    user.password_hash === null
      ? inviteEmail({ fullName: user.full_name, link, hours: RESET_HOURS })
      : resetEmail({ fullName: user.full_name, link, hours: RESET_HOURS })
  await send(db, {
    to: user.email,
    subject: mail.subject,
    text: mail.text,
    templateKey: user.password_hash === null ? 'auth.invite' : 'auth.reset',
    entityType: 'users',
    entityId: user.id,
  })
}

export async function lookupToken(token: string): Promise<q.TokenRow | null> {
  return q.findLiveToken(getDb(), sha256Hex(token))
}

/**
 * Completes a reset or an invite.
 *
 * Deletes every session for the user in the same transaction, so a session
 * stolen before the reset cannot outlive it (spec 6.1).
 */
export async function completeReset(opts: {
  token: string
  password: string
  ip: string | null
}): Promise<{ userId: number }> {
  const db = getDb()
  const row = await q.findLiveToken(db, sha256Hex(opts.token))
  if (!row) {
    throw new UnprocessableError('That link has expired or has already been used. Request a new one.')
  }

  const user = await q.findUserById(db, row.userId)
  if (!user) throw new UnprocessableError('That link is no longer valid.')

  await assertPasswordPolicy(opts.password, { email: user.email, fullName: user.full_name })
  const hash = await hashPassword(opts.password)

  await db.transaction().execute(async (trx: Trx) => {
    await q.consumeToken(trx, row.id)
    await q.invalidateOtherTokens(trx, row.userId, row.id)
    await q.setPassword(trx, row.userId, hash)
    await trx
      .updateTable('users')
      .set({ status: 'active' })
      .where('id', '=', row.userId)
      .where('status', '=', 'invited')
      .execute()
    await destroyAllUserSessions(trx, row.userId)
    await writeAudit(trx, {
      userId: row.userId,
      action: row.purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset',
      entityType: 'users',
      entityId: row.userId,
      ip: opts.ip,
    })
  })

  return { userId: row.userId }
}

/**
 * Change from inside the app. A current password is required unless the user
 * has none yet, which is the invited case where requireAuth has parked them
 * on this screen.
 */
export async function changeOwnPassword(opts: {
  userId: number
  sessionId: string
  current: string | undefined
  password: string
  ip: string | null
  userAgent: string | null
}): Promise<{ cookieValue: string }> {
  const db = getDb()
  const user = await q.findUserById(db, opts.userId)
  if (!user) throw new UnprocessableError('Account not found.')

  if (user.password_hash !== null) {
    if (!opts.current) throw new UnprocessableError('Enter your current password.')
    const ok = await verifyPassword(user.password_hash, opts.current)
    if (!ok) throw new UnprocessableError('Your current password is not correct.')
  }

  await assertPasswordPolicy(opts.password, { email: user.email, fullName: user.full_name })
  const hash = await hashPassword(opts.password)

  return db.transaction().execute(async (trx) => {
    await q.setPassword(trx, opts.userId, hash)
    // Rotation on privilege change (spec 6.1). The new cookie is returned so
    // the caller can set it; the old row is gone, so a fixated session dies.
    const rotated = await rotateSession(trx, opts.sessionId, {
      ip: opts.ip,
      userAgent: opts.userAgent,
    })
    await destroyAllUserSessions(trx, opts.userId, rotated.sessionId)
    await writeAudit(trx, {
      userId: opts.userId,
      action: 'auth.password_changed',
      entityType: 'users',
      entityId: opts.userId,
      ip: opts.ip,
    })
    return { cookieValue: rotated.cookieValue }
  })
}

/* TOTP ------------------------------------------------------------------- */

export interface EnrolmentOffer {
  secret: string
  otpauth: string
}

export async function beginEnrolment(userId: number): Promise<EnrolmentOffer> {
  const db = getDb()
  const user = await q.findUserById(db, userId)
  if (!user) throw new UnprocessableError('Account not found.')
  if (user.totp_confirmed_at !== null) {
    throw new UnprocessableError('Two factor authentication is already set up on this account.')
  }

  // A fresh secret is generated and stored unconfirmed on every visit to the
  // enrolment screen. Storing it means a page reload does not invalidate the
  // QR the user already scanned; leaving totp_confirmed_at null means an
  // abandoned enrolment does not lock anybody out.
  const secret = generateSecret()
  await db.transaction().execute(async (trx) => {
    await q.setTotpSecret(trx, userId, encryptSecret(secret), false)
  })

  const { otpauthUri } = await import('../../lib/totp.js')
  return { secret, otpauth: otpauthUri(user.email, secret) }
}

export async function confirmEnrolment(opts: {
  userId: number
  sessionId: string
  code: string
  ip: string | null
  userAgent: string | null
}): Promise<{ recoveryCodes: string[]; cookieValue: string }> {
  const db = getDb()
  const user = await q.findUserById(db, opts.userId)
  if (!user || user.totp_secret === null) {
    throw new UnprocessableError('Start the setup again from the beginning.')
  }

  const secret = decryptSecret(user.totp_secret)
  if (!verifyCode(secret, opts.code)) {
    throw new UnprocessableError('That code is not correct. Check the app and try the current code.')
  }

  const codes = generateRecoveryCodes(10)

  const cookieValue = await db.transaction().execute(async (trx) => {
    await q.setTotpSecret(trx, opts.userId, user.totp_secret, true)
    await storeRecoveryCodes(trx, opts.userId, codes)
    const rotated = await rotateSession(trx, opts.sessionId, {
      totpVerified: true,
      ip: opts.ip,
      userAgent: opts.userAgent,
    })
    await writeAudit(trx, {
      userId: opts.userId,
      action: 'auth.totp_enrolled',
      entityType: 'users',
      entityId: opts.userId,
      ip: opts.ip,
    })
    return rotated.cookieValue
  })

  return { recoveryCodes: codes, cookieValue }
}

export async function verifyTotp(opts: {
  userId: number
  sessionId: string
  code: string
  ip: string | null
  userAgent: string | null
}): Promise<{ cookieValue: string }> {
  const db = getDb()

  const limited = await hit(db, RULES.totpByUser(opts.userId))
  if (!limited.allowed) {
    throw new UnprocessableError(
      `Too many codes tried. Wait ${Math.ceil(limited.retryAfterSeconds / 60)} minutes.`
    )
  }

  const user = await q.findUserById(db, opts.userId)
  if (!user || user.totp_secret === null || user.totp_confirmed_at === null) {
    throw new UnprocessableError('Two factor authentication is not set up on this account.')
  }

  const looksLikeRecoveryCode = opts.code.includes('-')

  // The whole check and the rotation happen in one transaction, so a recovery
  // code cannot be consumed by two concurrent requests and cannot be spent
  // without the session actually being upgraded.
  return db.transaction().execute(async (trx) => {
    let accepted = false
    if (looksLikeRecoveryCode) {
      accepted = await consumeRecoveryCode(trx, opts.userId, opts.code)
    } else {
      accepted = verifyCode(decryptSecret(user.totp_secret!), opts.code)
    }

    if (!accepted) {
      throw new UnprocessableError('That code is not correct. Try the current code from your app.')
    }

    const rotated = await rotateSession(trx, opts.sessionId, {
      totpVerified: true,
      ip: opts.ip,
      userAgent: opts.userAgent,
    })
    await writeAudit(trx, {
      userId: opts.userId,
      action: looksLikeRecoveryCode ? 'auth.totp_recovery_used' : 'auth.totp_verified',
      entityType: 'users',
      entityId: opts.userId,
      ip: opts.ip,
    })
    return { cookieValue: rotated.cookieValue }
  })
}
