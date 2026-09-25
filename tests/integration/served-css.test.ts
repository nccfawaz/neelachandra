import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * The served-CSS tripwire (DECISIONS 29.60).
 *
 * Every visual fix before this one passed its test suite while the browser
 * never saw a byte of it: the markup tests pin renderToString output, but the
 * stylesheet the /app layout links is vite's MINIFIED BUILD of
 * src/dashboard/assets/css into public/assets/css — a copy step three
 * sessions forgot to run. This test fetches every stylesheet the layout
 * references THROUGH THE REAL ROUTER and asserts the declarations that must
 * exist in what a browser actually downloads.
 *
 * Empty-green rule: a non-zero floor on links found, so a broken layout or a
 * broken selector loop cannot pass on an empty set.
 */

/** Declarations that must exist in the served CSS (the 29.59/29.60 fixes). */
const DECLARATIONS: [string, string][] = [
  ['f5f7fa', 'sidebar background #f5f7fa'],
  ['span.ncc-navlink', 'disabled items get the block nav-item rule'],
  ['.ncc-sidebar__lockup', 'logo lockup sizing rule'],
  // The check-in button (DECISIONS 31.11): brand orange, phone-sized.
  ['.ncc-checkin-btn', 'the check-in button rule exists'],
  ['min-height:48px', 'the check-in button is at least 48px tall'],
  ['background:#f48120', 'the check-in button is brand orange #F48120'],
  ['width:100%', 'the check-in button is full width'],
  ['.ncc-checkin-note', 'the location notice is its own small muted rule'],
  // The attendance matrix is the one table allowed to scroll sideways
  // (DECISIONS 37.4); its sideways scroll must not be an invisible
  // affordance. These prove the shared scroll wrapper and the CSS-only
  // edge-shadow reach the browser.
  ['.ncc-table-scroll', 'the shared DataTable scroll wrapper has its own rule'],
  ['overflow-x:auto', 'the scroll wrapper clips overflow to a sideways scroll'],
  ['radial-gradient', 'the matrix carries the edge-shadow gradient layers'],
  [
    'background-attachment:local,local,scroll,scroll',
    'the matrix shadow is the pure-CSS local/scroll layering (visible only while more table is hidden)',
  ],
]

describe('the app layout serves its stylesheet with the required declarations', () => {
  beforeAll(async () => {
    const db = getDb()
    await sweepFixtures(db as never)
    await db
      .insertInto('users')
      .values({
        email: fixtureEmail('css'),
        full_name: fixtureName('Css User'),
        status: 'active',
        must_change_password: 0,
      })
      .execute()
  })

  afterAll(async () => {
    await sweepFixtures(getDb() as never)
    await closePool()
  })

  it('links at least one local stylesheet (non-zero floor)', async () => {
    // The auth layout links the same stylesheet the /app shell links.
    const page = await app.request('/login')
    const text = await page.text()
    const local = [...text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/[^"]+)"/g)].map(
      (m) => m[1],
    )
    expect(local.length, `expected local stylesheet links, got ${JSON.stringify(local)}`).toBeGreaterThan(0)
  })

  it('serves the layout stylesheet (200, text/css) with every required declaration', async () => {
    const page = await app.request('/login')
    const text = await page.text()
    const local = [...text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/[^"]+)"/g)].map(
      (m) => m[1],
    )
    expect(local.length, 'floor on stylesheet links').toBeGreaterThan(0)

    const bodies = await Promise.all(
      local.map(async (href) => {
        const res = await app.request(href)
        expect(res.status, `${href} must be served`).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/css')
        return res.text()
      }),
    )

    const css = bodies.join('\n')
    for (const [needle, what] of DECLARATIONS) {
      expect(css, `served CSS must contain ${what} ("${needle}")`).toContain(needle)
    }
  })
})
