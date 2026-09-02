import type { MiddlewareHandler } from 'hono'
import { isProd } from '../env.js'
import type { AppEnv } from '../types.js'

/**
 * The .htaccess rules, in code (spec 3.1).
 *
 * Hostinger regenerates public_html/.htaccess on every deploy, so any rule
 * left in that file is a rule that silently disappears on the next push.
 * These four groups therefore run before routing, and
 * scripts/verify-routes.mjs asserts every one of them.
 *
 * Order is load bearing. Host canonicalisation is first so a www request is
 * corrected once rather than being 301'd twice; the .php strip is next so
 * /about.php reaches the explicit map as /about; the explicit map is next;
 * the trailing slash strip is last so /about-us/ resolves after the mapping
 * rather than bouncing through it.
 */

export const CANONICAL_HOST = 'neelachandra.com'

/**
 * Explicit map for the paths that die in the rebuild (spec 3.1 rule 2).
 * These are the interiors-site paths and the two short forms that the old
 * site served but the new one does not have routes for.
 */
export const LEGACY_MAP: Record<string, string> = {
  '/about': '/about-us',
  '/contact': '/contact-us',
  '/process': '/#process',
  '/coming-soon': 'https://neelachandrainteriors.com',
}

/**
 * Paths that must never be rewritten. The IndexNow key file and the Search
 * Console verification file are literal filenames published to third parties
 * and a redirect on either breaks the verification.
 */
const NEVER_TOUCH = new Set([
  '/097ee841c58a4b25b8eb2c348ca67dce.txt',
  '/google9706eb5d9d6a7b15.html',
  '/.well-known/security.txt',
])

export function legacyRedirects(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url)
    let path = url.pathname

    if (NEVER_TOUCH.has(path)) return next()

    // Rule 4: force the canonical host. Only in production, because in the
    // sandbox and on the staging domain the host is not neelachandra.com and
    // redirecting to it would take every request off the machine.
    if (isProd) {
      const host = c.req.header('host') ?? ''
      const bare = host.replace(/:\d+$/, '')
      if (bare.startsWith('www.')) {
        return c.redirect(`https://${CANONICAL_HOST}${path}${url.search}`, 301)
      }
    }

    // Rule 1: strip .php. Preserves the existing RewriteRule ^ %1 [R=301,L].
    if (path.toLowerCase().endsWith('.php')) {
      path = path.slice(0, -4)
      // Fall through rather than redirecting here, so /about.php reaches the
      // explicit map below and lands on /about-us in ONE hop instead of two.
      const mapped = LEGACY_MAP[path]
      return c.redirect(mapped ?? (path === '' ? '/' : path) + url.search, 301)
    }

    // Rule 2: the explicit map.
    const mapped = LEGACY_MAP[path]
    if (mapped) {
      return c.redirect(mapped.startsWith('http') ? mapped : mapped + url.search, 301)
    }

    // Rule 3: strip a trailing slash on all non-root paths, matching the
    // current ^(.+?)/?$ behaviour.
    if (path.length > 1 && path.endsWith('/')) {
      const stripped = path.replace(/\/+$/, '')
      return c.redirect((stripped || '/') + url.search, 301)
    }

    return next()
  }
}
