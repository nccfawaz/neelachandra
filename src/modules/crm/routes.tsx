import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { page, banner } from '../../dashboard/render.js'
import { Alert, KpiCard, Panel } from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'

/**
 * Crm module routes.
 *
 * The schema, the permission keys and the navigation for this module are
 * complete and live. The transactional screens are the next build phase, so
 * every route below is mounted, guarded by the same permission its sidebar
 * item names, and reports the real row count from its primary table. That
 * preserves the invariant the navigation depends on: a link the user can see
 * is a link that neither 404s nor 403s.
 */

const crm = new Hono<AppEnv>()

crm.get('/app/crm/leads', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('leads')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Leads', path: '/app/crm/leads' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from leads" />
      </div>
      <Panel title="Leads">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

crm.get('/app/crm/visits', requirePermission(PERMISSIONS.CRM_LEAD_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('site_visits')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Site visits', path: '/app/crm/visits' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from site_visits" />
      </div>
      <Panel title="Site visits">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

crm.get('/app/crm/quotes', requirePermission(PERMISSIONS.CRM_QUOTE_CREATE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('quotes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Quotes', path: '/app/crm/quotes' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from quotes" />
      </div>
      <Panel title="Quotes">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

export default crm
