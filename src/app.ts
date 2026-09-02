import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { AppEnv } from './types.js'
import { sessionMiddleware } from './middleware/session.js'
import { legacyRedirects } from './middleware/legacyRedirects.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { csrfProtect } from './middleware/csrf.js'
import { requireAuth } from './middleware/requireAuth.js'
import publicSite from './public/routes.js'
import auth, { account } from './modules/auth/routes.js'
import admin from './modules/admin/routes.js'
import projects from './modules/projects/routes.js'
import inventory from './modules/inventory/routes.js'
import crm from './modules/crm/routes.js'
import finance from './modules/finance/routes.js'
import hr from './modules/hr/routes.js'
import marketing from './modules/marketing/routes.js'
import dashboard from './dashboard/routes.js'
import cron from './internal/cron/routes.js'

/**
 * Route composition and middleware order (spec 3).
 *
 * The order below is the security model, so it is stated once, here, rather
 * than being an emergent property of import order:
 *
 *  1. secureHeaders   before anything can produce a response
 *  2. legacyRedirects before routing, because a 301 must not depend on
 *                     whether a route happens to exist
 *  3. session         on every request including public ones, so the header
 *                     of a marketing page can say "signed in as"
 *  4. csrfProtect     on /app and /api only, mounted before the auth guard
 *                     so a forged POST is rejected without a database read
 *  5. requireAuth     on /app and /api
 *  6. permissions     per route, inside each module
 *
 * requireAuth deliberately sits after csrfProtect. Reversing them means an
 * unauthenticated forged request gets a login redirect instead of a 403,
 * which tells an attacker their token was never checked.
 */

const app = new Hono<AppEnv>()

app.onError(errorHandler)
app.notFound(notFoundHandler)

/*
 * Content-Security-Policy is set per area rather than globally.
 *
 * The public pages carry inline <style> and inline <script> blocks that the
 * freeze forbids touching, and GA4 loads from googletagmanager. So they get a
 * policy that permits inline, which is weak but honest. /app is ours, has no
 * inline script, and gets the strict policy. Writing one lax policy for both
 * would give away the dashboard's protection to satisfy frozen markup.
 */
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'SAMEORIGIN',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
  })
)

app.use('*', legacyRedirects())
app.use('*', sessionMiddleware())

app.use('/app/*', csrfProtect())
app.use('/api/*', csrfProtect())
app.use('/login', csrfProtect())
app.use('/forgot-password', csrfProtect())

/* Authentication: /login, /logout, /2fa/*, /forgot-password, /reset-password */
app.route('/', auth)

/* Internal cron, authenticated by X-Cron-Key and never by a session. */
app.route('/internal/cron', cron)

/* Everything below the auth wall. */
app.use('/app/*', requireAuth())
app.use('/api/*', requireAuth())

app.route('/app/account', account)
app.route('/', dashboard)
app.route('/', admin)
app.route('/', projects)
app.route('/', inventory)
app.route('/', crm)
app.route('/', finance)
app.route('/', hr)
app.route('/', marketing)

/* The public marketing site is last, so its catch-all /assets/* handler
 * cannot shadow a dashboard route. */
app.route('/', publicSite)

export default app
