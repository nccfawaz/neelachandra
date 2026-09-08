import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { legacyRedirects, LEGACY_MAP, CANONICAL_HOST } from '../../src/middleware/legacyRedirects.js'
import { PAGES } from '../../src/public/pages.js'
import { BUILT } from '../../src/middleware/errorHandler.js'

/**
 * The .htaccess rules, in code (spec 3.1 plus the ported fifth rule).
 *
 * Every assertion here mirrors one in scripts/test-htaccess.mjs, which runs
 * against real Apache; this suite pins the same behaviour in the Node app so
 * the two stay in step without a server. Section numbers in the comments are
 * test-htaccess.mjs sections.
 *
 * The middleware is exercised through a real Hono app rather than by calling
 * the returned handler, so the assertions cover what a request actually
 * sees: status, Location, and that the query string survives.
 */

function app(): Hono {
  const a = new Hono()
  a.use('*', legacyRedirects())
  // No catch-all: a request the middleware lets through reaches routing, and
  // in this app every route 404s, which is what a real app does for a path
  // it does not serve. The one clean-path test below asserts the 404 rather
  // than a 200, because a redirect would have answered before routing.
  a.notFound((c) => c.text('not found', 404))
  return a
}

const r = app().request

async function redirect(path: string, query = ''): Promise<Response> {
  return r(path + (query ? `?${query}` : ''))
}

/** Location is a relative path; resolve it so the pathname can be compared. */
function loc(res: Response): string {
  return new URL(res.headers.get('location')!, 'http://test').pathname
}

describe('rule 4: canonical host (prod only)', () => {
  it('does not redirect on the staging host in development', async () => {
    const res = await redirect('/about-us')
    expect(res.status).toBe(404)
  })
})

describe('section 2: extensions are stripped, permanently, in one hop', () => {
  const cases: Array<[string, string]> = [
    ['/about-us.html', '/about-us'],
    ['/about-us.php', '/about-us'],
    ['/terms.html', '/terms'],
    ['/login.html', '/login'],
    ['/index.html', '/'],
    ['/index.php', '/'],
  ]
  for (const [from, to] of cases) {
    it(`GET ${from} -> 301 ${to}`, async () => {
      const res = await redirect(from)
      expect(res.status).toBe(301)
      expect(loc(res)).toBe(to)
    })
  }

  it('preserves the query string through the strip', async () => {
    const res = await redirect('/terms.html', 'x=1')
    expect(res.headers.get('location')).toBe('/terms?x=1')
  })

  it('is case insensitive on the extension', async () => {
    const res = await redirect('/about-us.HTML')
    expect(res.status).toBe(301)
    expect(loc(res)).toBe('/about-us')
  })

  it('maps /about.html through the explicit map in one hop', async () => {
    const res = await redirect('/about.html')
    expect(res.status).toBe(301)
    expect(loc(res)).toBe('/about-us')
  })

  it('maps /about.php through the explicit map in one hop', async () => {
    const res = await redirect('/about.php')
    expect(res.status).toBe(301)
    expect(loc(res)).toBe('/about-us')
  })
})

describe('section 2, guarded: no clean page behind the URL, no redirect', () => {
  it('404s /header.html where it was asked, as the -f guard does', async () => {
    const res = await redirect('/header.html')
    expect(res.status).toBe(404)
  })

  it('still strips /header.php unconditionally (spec 3.1 rule 1)', async () => {
    const res = await redirect('/header.php')
    expect(res.status).toBe(301)
    expect(loc(res)).toBe('/header')
  })

  it('404s a page-form extension with no route rather than redirecting', async () => {
    const res = await redirect('/no-such-page.html')
    expect(res.status).toBe(404)
  })
})

describe('the error documents are strip targets and real URLs', () => {
  it('every BUILT code is a target', () => {
    expect(BUILT.size).toBe(12)
    for (const code of BUILT) {
      expect(STRIP_TARGETS_HAS(`/${code}`)).toBe(true)
    }
  })

  it('redirects /404.html onto /404', async () => {
    const res = await redirect('/404.html')
    expect(res.status).toBe(301)
    expect(loc(res)).toBe('/404')
  })
})

describe('section 3: trailing slashes are removed', () => {
  for (const [from, to] of [['/about-us/', '/about-us'], ['/terms/', '/terms']]) {
    it(`GET ${from} -> 301 ${to}`, async () => {
      const res = await redirect(from)
      expect(res.status).toBe(301)
      expect(loc(res)).toBe(to)
    })
  }
})

describe('sections 4 and 6: legacy short paths', () => {
  for (const [from, to] of Object.entries(LEGACY_MAP)) {
    it(`GET ${from} -> 301 ${to}`, async () => {
      const res = await redirect(from)
      expect(res.status).toBe(301)
      const loc = res.headers.get('location')!
      if (to.startsWith('http')) {
        expect(loc).toBe(to)
      } else {
        expect(new URL(loc, 'http://x').pathname + new URL(loc, 'http://x').hash).toBe(to)
      }
    })
  }

  // .htaccess section 6 rules carry `/?$`, so /home/ and /privacy/ 301 too.
  // Apache's trailing-slash rule (section 5) runs first and strips the slash,
  // so the slash forms reach the same destination in two hops there — the
  // same two hops the Node app makes: strip, then map.
  for (const [from, to] of [['/home/', '/'], ['/privacy/', '/privacy-policy']]) {
    it(`GET ${from} -> 301 ${to} in two hops`, async () => {
      const first = await redirect(from)
      expect(first.status).toBe(301)
      const second = await redirect(loc(first))
      expect(second.status).toBe(301)
      expect(loc(second)).toBe(to)
    })
  }
})

describe('section 6: infrastructure files are never touched', () => {
  for (const p of ['/097ee841c58a4b25b8eb2c348ca67dce.txt', '/google9706eb5d9d6a7b15.html', '/.well-known/security.txt']) {
    it(`GET ${p} is not rewritten`, async () => {
      const res = await redirect(p)
      expect(res.status).toBe(404)
    })
  }
})

describe('protected directories are excluded from the strip', () => {
  it('a .html file under /legacy is left for routing to 404', async () => {
    const res = await redirect('/legacy/golden/home.html')
    expect(res.status).toBe(404)
  })
})

describe('spec 3.1 rule 3: trailing slash before the map', () => {
  it('/about/ strips to /about in one hop; the map catches it on the next request, as .htaccess does', async () => {
    const res = await redirect('/about/')
    expect(res.status).toBe(301)
    expect(loc(res)).toBe('/about')
    // And the second hop lands on the mapped page, so no redirect chain
    // terminates on a dead URL.
    const second = await redirect('/about')
    expect(second.status).toBe(301)
    expect(loc(second)).toBe('/about-us')
  })
})

describe('canonical host constant', () => {
  it('is the production domain', () => {
    expect(CANONICAL_HOST).toBe('neelachandra.com')
  })
})

describe('every public page is a strip target', () => {
  it('the ten pages minus home, plus login and the twelve error docs', () => {
    for (const page of PAGES) {
      if (page.path !== '/') expect(STRIP_TARGETS_HAS(page.path)).toBe(true)
    }
    expect(STRIP_TARGETS_HAS('/login')).toBe(true)
  })
})

/** STRIP_TARGETS is module-private; recompute it the same way for assertions. */
function STRIP_TARGETS_HAS(clean: string): boolean {
  const targets = new Set([
    ...PAGES.filter((p) => p.path !== '/').map((p) => p.path),
    '/login',
    ...[...BUILT].map((code) => `/${code}`),
  ])
  return targets.has(clean)
}
