import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { env } from '../env.js'

/**
 * Symmetric crypto and hashing shared across the platform.
 *
 * The AES key is derived from SESSION_SECRET with scrypt rather than used
 * directly, so the secret can be any 44+ character string rather than
 * exactly 32 bytes, and so the same secret used for session id hashing does
 * not double as a raw cipher key.
 *
 * The salt is a fixed application constant, not random. A random salt would
 * have to be stored alongside every ciphertext to be re-derivable, which
 * gains nothing here: the threat is database disclosure, and the attacker who
 * has the database and the environment variable has both halves either way.
 * What this does buy is that a database dump alone cannot decrypt TOTP
 * secrets.
 */
const KEY_SALT = 'ncc.platform.aes256gcm.v1'
let cachedKey: Buffer | undefined

function key(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(env.SESSION_SECRET, KEY_SALT, 32)
  }
  return cachedKey
}

/**
 * AES-256-GCM. Output layout is iv (12 bytes) || tag (16 bytes) ||
 * ciphertext, which is what users.totp_secret VARBINARY(255) holds.
 */
export function encryptToBuffer(plaintext: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}

export function decryptFromBuffer(blob: Buffer): string {
  if (blob.length < 29) {
    throw new Error('Ciphertext too short to contain an iv and a tag')
  }
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const ct = blob.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** SHA-256 hex. Used for session ids, reset tokens and file checksums. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** URL-safe random token. 32 bytes is the session cookie value per spec 6.1. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Constant-time string compare that does not leak length either. Comparing
 * two Buffers of different length throws in timingSafeEqual, and returning
 * early on a length mismatch leaks the length, so both sides are hashed to a
 * fixed 32 bytes first.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Packs an IPv4 or IPv6 textual address into VARBINARY(16). */
export function ipToBuffer(ip: string | undefined | null): Buffer | null {
  if (!ip) return null
  const clean = ip.trim().replace(/^\[|\]$/g, '')
  if (clean === '') return null

  // IPv4-mapped IPv6 such as ::ffff:127.0.0.1 stores as the IPv4 form, so a
  // lockout counted against a v4 address matches whichever way the proxy
  // presents it.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(clean)
  const target = mapped ? mapped[1]! : clean

  if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
    const parts = target.split('.').map((p) => Number(p))
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
    return Buffer.from(parts)
  }

  if (target.includes(':')) {
    try {
      const groups = expandIpv6(target)
      const buf = Buffer.alloc(16)
      groups.forEach((g, i) => buf.writeUInt16BE(g, i * 2))
      return buf
    } catch {
      return null
    }
  }
  return null
}

export function bufferToIp(buf: Buffer | null | undefined): string | null {
  if (!buf) return null
  if (buf.length === 4) return Array.from(buf).join('.')
  if (buf.length === 16) {
    const groups: string[] = []
    for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(i).toString(16))
    return groups.join(':').replace(/(^|:)(0(:0)+)(:|$)/, '::')
  }
  return null
}

function expandIpv6(addr: string): number[] {
  const [head, tail] = addr.split('::')
  const headGroups = head && head.length > 0 ? head.split(':') : []
  const tailGroups = tail && tail.length > 0 ? tail.split(':') : []
  if (addr.includes('::')) {
    const fill = 8 - headGroups.length - tailGroups.length
    if (fill < 0) throw new Error('Invalid IPv6')
    const all = [...headGroups, ...Array<string>(fill).fill('0'), ...tailGroups]
    return all.map((g) => parseInt(g || '0', 16))
  }
  const all = addr.split(':')
  if (all.length !== 8) throw new Error('Invalid IPv6')
  return all.map((g) => parseInt(g || '0', 16))
}
