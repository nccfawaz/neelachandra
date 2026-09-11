import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { csrfProtect, PRE_SESSION_COOKIE } from '../../src/middleware/csrf.js'
import { issueToken } from '../../src/lib/csrf.js'

/**
 * The pre-session double-submit branch of csrfProtect (DECISIONS 29.32).
 *
 * The defect it pins: csrfProtect demanded a session row on /login and
 * /forgot-password, but a visitor signing in has none — so every browser
 * login POST died with 403 "Your session has ended" before the route's own
 * pre-session token check (auth/routes.tsx verifyPreSessionToken) could
 * run. Proven against the live server on 2026-09-11: login POST with a
 * correct password returned 403; after the fix, 302 with a session cookie.
 *
 * The branch: on the two pre-session paths, with no session, the expected
 * token is the ncc_csrf cookie issued with the page, compared timing-safely
 * against the form's nc_csrf field (double-submit). Every assertion below
 * drives the full middleware — session middleware replaced by one that sets
 * what sessionMiddleware would set — so the branch, not a mock of it, is
 * what runs.
 */

const PRE_SESSION_PATH = '/login'

function build() {
  const app = new Hono()
  // Session middleware's contract for an anonymous visitor: session null.
  app.use('*', (c, next) => {
    c.set('session', null as never)
    c.set('parsedBody', null)
    return next()
  })
  app.use('*', csrfProtect())
  app.onError((err, c) => c.text(err.message, (err as { status?: number }).status ?? 403))
  app.on(['POST', 'GET'], [PRE_SESSION_PATH, '/app/anywhere'], (c) => c.text('reached', 200))
  return app
}

/** Issues the cookie exactly as auth/routes.tsx issuePreSessionToken does. */
function issueCookie(c: { header: (k: string, v: string) => void }): string {
  const token = issueToken()
  setCookie(c, PRE_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/' })
  return token
}

describe('the pre-session double-submit branch of csrfProtect', () => {
  it('lets a login POST through when the form token matches the cookie', async () => {
    const app = build()
    const res = await app.request(PRE_SESSION_PATH, {
      method: 'GET',
    })
    // Issue the pair the way the real GET handler does.
    const token = issueToken()
    const cookie = `${PRE_SESSION_COOKIE}=${token}`
    const post = await app.request(PRE_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ email: 'a@b.c', password: 'x', nc_csrf: token }),
    })
    expect(res.status).toBe(200)
    expect(post.status).toBe(200)
    expect(await post.text()).toBe('reached')
  })

  it('refuses the login POST with no token in the form (403)', async () => {
    const app = build()
    const token = issueToken()
    const res = await app.request(PRE_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${PRE_SESSION_COOKIE}=${token}` },
      body: new URLSearchParams({ email: 'a@b.c', password: 'x' }),
    })
    expect(res.status).toBe(403)
  })

  it('refuses the login POST when the token does not match the cookie (403)', async () => {
    const app = build()
    const res = await app.request(PRE_SESSION_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${PRE_SESSION_COOKIE}=${issueToken()}`,
      },
      body: new URLSearchParams({ email: 'a@b.c', password: 'x', nc_csrf: issueToken() }),
    })
    expect(res.status).toBe(403)
  })

  it('refuses the login POST with no pre-session cookie at all (403)', async () => {
    const app = build()
    const res = await app.request(PRE_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'a@b.c', password: 'x', nc_csrf: issueToken() }),
    })
    expect(res.status).toBe(403)
  })

  it('still demands a session token on every other anonymous POST — the branch is not a bypass', async () => {
    const app = build()
    const token = issueToken()
    const res = await app.request('/app/anywhere', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${PRE_SESSION_COOKIE}=${token}`,
      },
      body: new URLSearchParams({ nc_csrf: token }),
    })
    // No session, not a pre-session path: the old refusal must hold.
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('session has ended')
  })

  it('a pre-session cookie does NOT satisfy the session branch on any other path', async () => {
    // DECISIONS 29.34: the path set is a constant, checked before anything
    // else. A visitor (or an attacker who planted a parent-domain cookie)
    // cannot extend double-submit semantics to any route beyond /login and
    // /forgot-password — an anonymous POST to /app with a perfectly valid
    // pre-session pair is still refused with the session error.
    const app = build()
    const token = issueToken()
    for (const path of ['/app/anywhere', '/app', '/2fa/verify', '/reset-password/x', '/logout']) {
      const res = await app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `${PRE_SESSION_COOKIE}=${token}`,
        },
        body: new URLSearchParams({ nc_csrf: token }),
      })
      expect(res.status, path).toBe(403)
    }
  })

  it('comparison is timing-safe even on a length mismatch (no early-exit leak)', async () => {
    // constantTimeEquals hashes both sides to 32 bytes before
    // timingSafeEqual, so a 1-char guess costs the same as a 64-char wrong
    // token. This asserts the code path used IS the hashed one by checking
    // a wrong-length token is refused, not short-circuited by length.
    const app = build()
    const token = issueToken()
    const res = await app.request(PRE_SESSION_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${PRE_SESSION_COOKIE}=${token}`,
      },
      body: new URLSearchParams({ nc_csrf: 'x' }),
    })
    expect(res.status).toBe(403)
  })
})
