import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToString } from 'hono/jsx/dom/server'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { AppShell } from '../../src/dashboard/layouts/AppShell.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'
/**
 * The brand mark's two halves, both through real machinery (DECISIONS 29.57,
 * corrected):
 *
 *  1. The asset itself — GET /assets/images/header/logo.svg must 200 with
 *     content-type image/svg+xml through the real router. A missing static
 *     handler or a wrong MIME type shows up here as a hard failure.
 *
 *  2. The crop geometry — the sidebar renders the full logo.svg inside a
 *     clipping wrapper (CSS-only crop; no <view> fragment, no edit to the
 *     asset, which stays byte-identical to its committed state). The
 *     rendered markup must carry the wrapper and the full-asset src, and
 *     must NOT reference a #fragment that no longer exists.
 */
describe('the brand mark serves and crops', () => {
  beforeAll(async () => {
    const db = getDb()
    await sweepFixtures(db as never)
    await db
      .insertInto('users')
      .values({
        email: fixtureEmail('logo'),
        full_name: fixtureName('Logo User'),
        status: 'active',
        must_change_password: 0,
      })
      .execute()
  })

  afterAll(async () => {
    const db = getDb()
    await sweepFixtures(db as never)
    await closePool()
  })

  it('serves the logo at 200 with an SVG content type through the real router', async () => {
    const res = await app.request('/assets/images/header/logo.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
  })

  it('renders the full lockup: un-cropped asset, no crop wrapper, no dead fragment', () => {
    const html = renderToString(
      AppShell({
        title: 'Dashboard',
        user: { id: 1, email: 'a@b.c', fullName: 'A', roleId: 2 } as never,
        perms: new Set(Object.values(PERMISSIONS)),
        csrfToken: 't',
        path: '/app',
        children: <p>body</p>,
      } as never),
    )
    // Full lockup (29.59): the whole asset at natural aspect — no clipping
    // wrapper, no CSS crop — plus the small STAFF PLATFORM label beneath.
    expect(html).toContain('ncc-sidebar__lockup')
    expect(html).toContain('src="/assets/images/header/logo.svg"')
    expect(html).toContain('STAFF PLATFORM')
    expect(html).not.toContain('ncc-sidebar__mark-wrap')
    // The <view id="arch"> fragment was removed from the asset; a reference
    // to it would render a broken image.
    expect(html).not.toContain('#arch')
  })
})
