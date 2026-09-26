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
  // Page background is #f5f7fa (DECISIONS 38). The sidebar was this colour
  // before §38; now the sidebar is white (var(--ncc-surface)) so it stays
  // distinct from the page — sidebar-browser.test.ts proves that separation
  // with computed values.
  ['--ncc-bg: #f5f7fa', 'the page background token is #f5f7fa (38)'],
  ['span.ncc-navlink', 'disabled items get the block nav-item rule'],
  ['.ncc-sidebar__lockup', 'logo lockup sizing rule'],
  // The check-in button (DECISIONS 31.11): brand orange, phone-sized. After
  // the 37.7 accent unification it no longer hard-codes the orange or 48 —
  // both flow from the tokens, so we assert the tokens AND that the button
  // consumes them, which is what proves the unification actually reaches it.
  ['.ncc-checkin-btn', 'the check-in button rule exists'],
  ['--ncc-accent: #f48120', 'the accent token is brand orange #F48120 (one orange, 37.7)'],
  ['--ncc-tap: 48px', 'the tap-target token is 48px (37.5)'],
  ['background:var(--ncc-accent)', 'the check-in button paints from the accent token'],
  ['min-height:var(--ncc-tap)', 'the check-in button is at least one tap-target tall'],
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
  // Stage 2 (DECISIONS 37.8): the single compact breakpoint and the two
  // behaviours a phone layout stands on — the JS-free off-canvas drawer
  // (37.2) and the wide-table card rule (37.4) — must reach the browser.
  ['@media(max-width:768px)', 'the single compact breakpoint replaces the old 900px rule'],
  ['.ncc-nav-toggle:checked', 'the drawer open state is the checkbox, no JS'],
  ['transform:translate(-100%)', 'the drawer sits off-canvas until opened'],
  ['attr(data-label)', 'stacked cards label each cell from its column header'],
  // Stage 2 colour rework and designed list cards (DECISIONS 38): the single
  // overlay scrim token, the nav backdrop consuming it, and the purpose-built
  // list card that replaces the generic transpose on People list pages.
  ['--ncc-scrim-rgb: 20, 24, 31', 'the single overlay scrim token (38)'],
  ['rgba(var(--ncc-scrim-rgb),.45)', 'the nav backdrop paints from the scrim token (38)'],
  ['.ncc-listcard', 'the designed mobile list-card rule reaches the browser (38)'],
  ['.ncc-table-scroll.ncc-carded', 'a carded table hides its transpose on mobile (38)'],
  // The Stage 1 spacing scale and fixed dashboard grid (DECISIONS 40). The
  // tokens, the four/two fixed columns, the full-width wide span, the flex list
  // row that fixes "Attendance days1 unapproved", the two-line label reservation
  // that keeps KPI values on one baseline, and the desktop check-in cap must all
  // reach the browser — dashboard-grid-browser.test.ts proves the geometry, this
  // proves the declarations survive the vite build.
  ['--sp-4: 1rem', 'the spacing scale token reaches the browser (40)'],
  ['.ncc-grid--kpi{grid-template-columns:repeat(4,minmax(0,1fr))}', 'the KPI grid is four fixed columns (40, B)'],
  ['.ncc-grid--2{grid-template-columns:repeat(2,minmax(0,1fr))}', 'the panel grid is two fixed columns (40, B)'],
  ['.ncc-card--wide{grid-column:1 / -1}', 'a wide card spans the whole grid row (40, B)'],
  ['.ncc-list__item{display:flex', 'the panel list row is a flex row — the "days1 unapproved" fix (40, E)'],
  ['justify-content:space-between', 'the list row pushes its value to the far edge (40, E)'],
  ['.ncc-grid--kpi .ncc-kpi__label{min-height:2.6em}', 'a two-line label reservation keeps KPI values aligned (40, C/B)'],
  ['.ncc-checkin-btn{max-width:none}', 'the phone override lifts the desktop check-in cap (40, F)'],
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
