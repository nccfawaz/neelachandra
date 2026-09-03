import { describe, expect, it } from 'vitest'
import { bufferToIp, constantTimeEquals, ipToBuffer, randomToken, sha256Hex } from '../src/lib/crypto.js'
import { CSRF_FIELD, CSRF_HEADER, extractToken, issueToken, requiresCsrf, verifyToken } from '../src/lib/csrf.js'
import { ForbiddenError } from '../src/lib/errors.js'

/**
 * The CSRF guard and the primitives under it (spec 2.5).
 *
 * verifyToken throws rather than returning false, so a route that forgets to
 * check the result cannot proceed unprotected. That is the property worth
 * pinning: every wrong input below must produce a ForbiddenError, not a falsy
 * return value nobody reads.
 */

describe('requiresCsrf', () => {
  it('exempts the methods that must not change state', () => {
    expect(requiresCsrf('GET')).toBe(false)
    expect(requiresCsrf('HEAD')).toBe(false)
    expect(requiresCsrf('OPTIONS')).toBe(false)
  })

  it('covers every state-changing method, whatever the casing', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(requiresCsrf(method), method).toBe(true)
    }
  })
})

describe('verifyToken', () => {
  const token = issueToken()

  it('accepts the matching token', () => {
    expect(() => verifyToken(token, token)).not.toThrow()
  })

  it('throws when the session has no token', () => {
    expect(() => verifyToken(null, token)).toThrow(ForbiddenError)
    expect(() => verifyToken(undefined, token)).toThrow(ForbiddenError)
    expect(() => verifyToken('', token)).toThrow(ForbiddenError)
  })

  it('throws when the form supplies nothing usable', () => {
    for (const supplied of [undefined, null, '', 0, [], {}, [token]]) {
      expect(() => verifyToken(token, supplied)).toThrow(ForbiddenError)
    }
  })

  it('throws on a token that is wrong by one character', () => {
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')
    expect(() => verifyToken(token, tampered)).toThrow(ForbiddenError)
  })

  it('throws on a token that is a prefix of the real one', () => {
    expect(() => verifyToken(token, token.slice(0, 16))).toThrow(ForbiddenError)
  })
})

describe('issueToken', () => {
  it('is a 64-character hex digest', () => {
    expect(issueToken()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => issueToken()))
    expect(tokens.size).toBe(200)
  })
})

describe('extractToken', () => {
  const headers = (value: string | null) => ({ get: (name: string) => (name === CSRF_HEADER ? value : null) })

  it('prefers the hidden form field', () => {
    expect(extractToken({ [CSRF_FIELD]: 'from-body' }, headers('from-header'))).toBe('from-body')
  })

  it('falls back to the htmx header when the body has no field', () => {
    // An hx-post with no form fields still carries the token via hx-headers.
    expect(extractToken({}, headers('from-header'))).toBe('from-header')
    expect(extractToken(null, headers('from-header'))).toBe('from-header')
  })

  it('ignores a repeated field, which is never a real template', () => {
    // parseBody({ all: true }) gives an array for a repeated name. Falling
    // through to the header, and then failing verification, is the fail-closed
    // direction.
    expect(extractToken({ [CSRF_FIELD]: ['a', 'b'] }, headers(null))).toBeNull()
  })

  it('returns null when neither side carries a token', () => {
    expect(extractToken({}, headers(null))).toBeNull()
    expect(extractToken({ [CSRF_FIELD]: '' }, headers(null))).toBeNull()
  })
})

describe('constantTimeEquals', () => {
  it('compares equal strings as equal', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('', '')).toBe(true)
  })

  it('handles different lengths without throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths, so both sides are
    // hashed to 32 bytes first. A throw here would leak length as an exception.
    expect(constantTimeEquals('short', 'considerably longer string')).toBe(false)
    expect(constantTimeEquals('a', '')).toBe(false)
  })
})

describe('sha256Hex and randomToken', () => {
  it('hashes to the known digest', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('produces url-safe tokens of the requested strength', () => {
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(randomToken(32).length).toBeGreaterThanOrEqual(43)
  })
})

describe('ipToBuffer and bufferToIp', () => {
  it('round-trips IPv4', () => {
    expect(bufferToIp(ipToBuffer('203.0.113.9'))).toBe('203.0.113.9')
  })

  it('stores an IPv4-mapped IPv6 address as its IPv4 form', () => {
    // So a lockout counted against an address matches whichever way the proxy
    // presents it.
    expect(bufferToIp(ipToBuffer('::ffff:127.0.0.1'))).toBe('127.0.0.1')
  })

  it('accepts a bracketed address and a compressed IPv6', () => {
    expect(ipToBuffer('[::1]')).toHaveLength(16)
    expect(ipToBuffer('2001:db8::1')).toHaveLength(16)
  })

  it('returns null rather than a bad buffer for junk', () => {
    expect(ipToBuffer(null)).toBeNull()
    expect(ipToBuffer('')).toBeNull()
    expect(ipToBuffer('   ')).toBeNull()
    expect(ipToBuffer('999.1.1.1')).toBeNull()
    expect(ipToBuffer('not-an-address')).toBeNull()
    expect(bufferToIp(null)).toBeNull()
  })
})
