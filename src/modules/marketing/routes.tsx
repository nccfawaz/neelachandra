import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { page, banner } from '../../dashboard/render.js'
import { Alert, KpiCard, Panel } from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'

/**
 * Marketing module routes.
 *
 * The schema, the permission keys and the navigation for this module are
 * complete and live. The transactional screens are the next build phase, so
 * every route below is mounted, guarded by the same permission its sidebar
 * item names, and reports the real row count from its primary table. That
 * preserves the invariant the navigation depends on: a link the user can see
 * is a link that neither 404s nor 403s.
 */

const marketing = new Hono<AppEnv>()

marketing.get('/app/marketing', requirePermission(PERMISSIONS.MARKETING_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('enquiries')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Marketing overview', path: '/app/marketing' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from enquiries" />
      </div>
      <Panel title="Marketing overview">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

marketing.get('/app/marketing/campaigns', requirePermission(PERMISSIONS.MARKETING_CAMPAIGN_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('campaigns')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Campaigns', path: '/app/marketing/campaigns' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from campaigns" />
      </div>
      <Panel title="Campaigns">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

marketing.get('/app/marketing/content', requirePermission(PERMISSIONS.SITE_CONTENT_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('site_pages')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Site content', path: '/app/marketing/content' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from site_pages" />
      </div>
      <Panel title="Site content">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

export default marketing
