import type { MiddlewareHandler } from 'hono'
import { isProd } from '../env.js'
import { BUILT } from './errorHandler.js'
import { PAGES } from '../public/pages.js'
import type { AppEnv } from '../types.js'

/**
 * The .htaccess rules, in code (spec 3.1, plus one ported rule).
 *
 * Hostinger regenerates public_html/.htaccess on every deploy, so any rule
 * left in that file is a rule that silently disappears on the next push.
 * These groups therefore run before routing, and
 * tests/middleware/legacy-redirects.test.ts asserts every one of them.
 *
 * Order is load bearing. Host canonicalisation is first so a www request is
 * corrected once rather than being 301'd twice; the index special case is
 * next so /index.php lands on / rather than on a route that does not exist;
 * the extension strips follow; the explicit map is applied to the stripped
 * path so /about.php reaches /about-us in ONE hop; the trailing slash strip
 * is last so /about-us/ resolves after the mapping rather than bouncing
 * through it.
 *
 * The .html/.htm strip is the fifth rule and it is NOT in spec 3.1, which
 * lists four. It is ported from .htaccess section 4 because the live site
 * 301s those URLs today and DECISIONS 24.8 records the decision: the spec is
 * short a rule, the deployment wins, and the parity gate's TOLERANCE 0
 * premise points the same way. Unlike the .php strip it fires only where the
 * clean URL has a page behind it — the same -f guard the RewriteRule carries
 * — so /header.html 404s instead of redirecting onto a dead address.
 */

export const CANONICAL_HOST = 'neelachandra.com'

/**
 * Explicit map for the paths that die in the rebuild (spec 3.1 rule 2, plus
 * .htaccess section 6). The four interiors-site and short paths are the
 * spec's list; /home, /privacy and /index are ported from .htaccess section
 * 6 so every URL that 301s today still 301s after cut-over (parity,
 * TOLERANCE 0 — DECISIONS 24.8). /index is the bare form, distinct from the
 * /index.* extension rule above it: .htaccess maps both to /.
 */
export const LEGACY_MAP: Record<string, string> = {
  '/about': '/about-us',
  '/contact': '/contact-us',
  '/process': '/#process',
  '/coming-soon': 'https://neelachandrainteriors.com',
  '/home': '/',
  '/privacy': '/privacy-policy',
  '/index': '/',
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

/**
 * The clean URLs the extension stripper may redirect onto, derived from what
 * the app actually serves rather than from a filesystem probe: the ten
 * public pages, the login screen, and the twelve error documents that
 * public/routes.ts serves from the built files. Mirrors the -f guard in
 * .htaccess section 4; a clean URL outside this set is left alone so the
 * request 404s where it was asked instead of redirecting onto another 404.
 */
const STRIP_TARGETS: ReadonlySet<string> = new Set([
  ...PAGES.filter((p) => p.path !== '/').map((p) => p.path),
  '/login',
  ...[...BUILT].map((code) => `/${code}`),
])

/**
 * Directories .htaccess section 4 excludes from the stripper, so a real
 * .html file inside one (the golden masters) 404s rather than 301ing to a
 * clean URL that serves nothing.
 */
const PROTECTED_DIR = /^\/(?:\.git|\.github|node_modules|scripts|tests|legacy|migrations|src|public)(?:\/|$)/i

const EXTENSION = /\.(html?|php)$/i

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

    // index is special in .htaccess (:77): it must land on "/" and not on
    // "/index", which has no route. Covers every extension, which is what
    // fixes /index.php 301ing to the dead /index.
    const lower = path.toLowerCase()
    if (lower === '/index.php' || lower === '/index.html' || lower === '/index.htm') {
      return c.redirect('/' + url.search, 301)
    }

    // Rules 1 and 5: strip .php (spec 3.1 rule 1, unconditional) and
    // .html/.htm (ported, guarded). The explicit map is applied to the
    // stripped path first, so /about.php and /about.html each reach
    // /about-us in one hop.
    if (EXTENSION.test(path)) {
      const stripped = path.replace(EXTENSION, '')
      const mapped = LEGACY_MAP[stripped]
      if (mapped) {
        return c.redirect(mapped.startsWith('http') ? mapped : mapped + url.search, 301)
      }
      const clean = stripped === '' ? '/' : stripped
      if (path.toLowerCase().endsWith('.php')) {
        // Unconditional, per spec rule 1: /header.php strips to /header and
        // the 404 comes from routing, which is the outcome .htaccess section
        // 3 produces for it too.
        return c.redirect(clean + url.search, 301)
      }
      // .html/.htm: only where the clean URL has a page behind it, and never
      // inside a protected directory.
      if (!PROTECTED_DIR.test(path) && STRIP_TARGETS.has(clean)) {
        return c.redirect(clean + url.search, 301)
      }
      // No page behind the clean URL: fall through to routing, which 404s
      // the extension form directly, exactly as the guarded RewriteRule
      // declines to fire.
      return next()
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
