import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types.js'

/**
 * The /app gate (spec 4.5).
 *
 * Three redirects in a fixed order, because each is a precondition for the
 * next:
 *   1. no session            -> /login?next=
 *   2. must_change_password  -> /app/account/password
 *   3. role requires 2FA     -> /2fa/enrol, then /2fa/verify
 *
 * The password redirect comes before the 2FA one on purpose. An invited user
 * has no password yet, and asking them to enrol an authenticator for an
 * account they cannot yet sign into properly is the wrong order.
 */

// Paths that must stay reachable while a redirect condition is active,
// otherwise the fix for the condition is itself blocked by the condition.
const PASSWORD_EXEMPT = new Set(['/app/account/password', '/logout'])
const TOTP_EXEMPT = new Set(['/2fa/enrol', '/2fa/verify', '/2fa/recovery', '/logout'])

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user')
    const path = new URL(c.req.url).pathname

    if (!user) {
      // htmx swaps a fragment into the page, so a 302 to the login HTML would
      // paint the login form inside a table cell. HX-Redirect makes the
      // browser navigate instead.
      if (c.req.header('hx-request')) {
        c.header('HX-Redirect', `/login?next=${encodeURIComponent(path)}`)
        return c.body(null, 204)
      }
      const next_ = path === '/app' ? '' : `?next=${encodeURIComponent(path)}`
      return c.redirect(`/login${next_}`, 302)
    }

    if (user.mustChangePassword && !PASSWORD_EXEMPT.has(path)) {
      return c.redirect('/app/account/password', 302)
    }

    if (c.get('requires2fa') && !TOTP_EXEMPT.has(path)) {
      if (!user.totpConfirmed) return c.redirect('/2fa/enrol', 302)
      const session = c.get('session')
      if (session && !session.totpVerified) return c.redirect('/2fa/verify', 302)
    }

    return next()
  }
}
