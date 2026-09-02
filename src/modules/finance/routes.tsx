import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { page, banner } from '../../dashboard/render.js'
import { Alert, KpiCard, Panel } from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'

/**
 * Finance module routes.
 *
 * The schema, the permission keys and the navigation for this module are
 * complete and live. The transactional screens are the next build phase, so
 * every route below is mounted, guarded by the same permission its sidebar
 * item names, and reports the real row count from its primary table. That
 * preserves the invariant the navigation depends on: a link the user can see
 * is a link that neither 404s nor 403s.
 */

const finance = new Hono<AppEnv>()

finance.get('/app/finance/budgets', requirePermission(PERMISSIONS.FINANCE_VIEW_PROJECT_BUDGET), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('project_budgets')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Budgets', path: '/app/finance/budgets' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from project_budgets" />
      </div>
      <Panel title="Budgets">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

finance.get('/app/finance/expenses', requirePermission(PERMISSIONS.FINANCE_EXPENSE_CREATE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('expenses')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Expenses', path: '/app/finance/expenses' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from expenses" />
      </div>
      <Panel title="Expenses">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

finance.get('/app/finance/invoices', requirePermission(PERMISSIONS.FINANCE_INVOICE_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('client_invoices')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Client invoices', path: '/app/finance/invoices' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from client_invoices" />
      </div>
      <Panel title="Client invoices">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

finance.get('/app/finance/payments', requirePermission(PERMISSIONS.FINANCE_PAYMENT_RECORD), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('payments')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Payments', path: '/app/finance/payments' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from payments" />
      </div>
      <Panel title="Payments">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

finance.get('/app/finance/periods', requirePermission(PERMISSIONS.FINANCE_PERIOD_CLOSE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('accounting_periods')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Accounting periods', path: '/app/finance/periods' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from accounting_periods" />
      </div>
      <Panel title="Accounting periods">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

export default finance
