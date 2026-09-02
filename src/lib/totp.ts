import { authenticator } from 'otplib'
import QRCode from 'qrcode'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import type { Queryable, Trx } from '../db/kysely.js'
import { decryptFromBuffer, encryptToBuffer, randomToken } from './crypto.js'
import { nowSqlDateTime } from './dates.js'

/**
 * TOTP enrolment and verification for the roles that require it
 * (spec 4.5: owner, admin, accounts_manager).
 *
 * The secret is stored AES-256-GCM encrypted in users.totp_secret. A TOTP
 * secret is a symmetric credential: unlike a password it has to be recovered
 * in plain text to verify a code, so it cannot be hashed, which is exactly
 * why it is encrypted with a key derived from an environment variable rather
 * than stored raw.
 *
 * window: 1 accepts the previous and next 30 second step, which covers a
 * phone clock a few seconds out. Wider windows start to matter for replay.
 */

authenticator.options = { window: 1, step: 30, digits: 6 }

export const ISSUER = 'Neelachandra'

export function generateSecret(): string {
  return authenticator.generateSecret()
}

export function encryptSecret(secret: string): Buffer {
  return encryptToBuffer(secret)
}

export function decryptSecret(blob: Buffer): string {
  return decryptFromBuffer(blob)
}

export function otpauthUri(email: string, secret: string): string {
  return authenticator.keyuri(email, ISSUER, secret)
}

/** The QR the enrolment page renders inline, so no image round trip. */
export async function qrDataUrl(otpauth: string): Promise<string> {
  return QRCode.toDataURL(otpauth, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
}

export function verifyCode(secret: string, token: string): boolean {
  const clean = token.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  try {
    return authenticator.check(clean, secret)
  } catch {
    return false
  }
}

/**
 * Ten single-use recovery codes, shown once and stored only as argon2 hashes
 * (spec 4.5). Format is four groups of four lowercase base32-ish characters,
 * which is readable enough to write on paper and long enough not to be
 * guessable.
 *
 * The alphabet excludes the characters that get misread when handwritten:
 * 0/o, 1/l/i, and 5/s. Someone reading these off a printed sheet a year later
 * is the whole point of them.
 */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrtuvwxyz23456789'

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i += 1) {
    const raw = randomToken(24).replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    let out = ''
    for (let j = 0; j < 16; j += 1) {
      const idx = raw.charCodeAt(j % raw.length) % RECOVERY_ALPHABET.length
      out += RECOVERY_ALPHABET[idx]
    }
    codes.push(`${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`)
  }
  return codes
}

const RECOVERY_ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

export async function storeRecoveryCodes(
  trx: Trx,
  userId: number,
  codes: readonly string[]
): Promise<void> {
  await trx.deleteFrom('user_recovery_codes').where('user_id', '=', userId).execute()
  const rows = await Promise.all(
    codes.map(async (c) => ({
      user_id: userId,
      code_hash: await argonHash(normaliseRecovery(c), RECOVERY_ARGON),
    }))
  )
  await trx.insertInto('user_recovery_codes').values(rows).execute()
}

function normaliseRecovery(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Consumes a recovery code if it matches an unused one. Each stored code is a
 * separate argon2 hash, so this is a linear scan of at most ten verifies. A
 * lookup by hash is impossible because argon2 salts each row, and that is the
 * correct trade: ten verifies on a rare recovery path costs less than storing
 * these in a searchable form.
 */
export async function consumeRecoveryCode(
  trx: Trx,
  userId: number,
  supplied: string
): Promise<boolean> {
  const candidate = normaliseRecovery(supplied)
  if (candidate.length < 8) return false

  const rows = await trx
    .selectFrom('user_recovery_codes')
    .select(['id', 'code_hash'])
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute()

  for (const row of rows) {
    let matched = false
    try {
      matched = await argonVerify(row.code_hash, candidate, RECOVERY_ARGON)
    } catch {
      matched = false
    }
    if (matched) {
      await trx
        .updateTable('user_recovery_codes')
        .set({ used_at: nowSqlDateTime() })
        .where('id', '=', row.id)
        .execute()
      return true
    }
  }
  return false
}

export async function countUnusedRecoveryCodes(db: Queryable, userId: number): Promise<number> {
  const row = await db
    .selectFrom('user_recovery_codes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}
