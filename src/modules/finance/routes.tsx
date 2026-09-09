import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, CurrentUser } from '../../types.js'
import { currentUser } from '../../types.js'
import { page, banner, okRedirect, errRedirect } from '../../dashboard/render.js'
import { Alert, KpiCard, Panel } from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'
import { readBody } from '../../middleware/csrf.js'
import { NotFoundError, isAppError } from '../../lib/errors.js'
import * as svc from './service.js'
import { createInvoiceFromMilestone } from './invoiceService.js'
import { clientInvoiceCreateSchema, expenseCreateSchema, firstError, paymentCreateSchema, paymentAllocateSchema, siteAdvanceSchema } from './schemas.js'

/**
 * Finance module routes.
 *
 * The schema, the permission keys and the navigation for this module are
 * complete and live. The transactional screens are the next build phase, so
 * every route below is mounted, guarded by the same permission its sidebar
 * item names, and reports the real row count from its primary table. That
 * preserves the invariant the navigation depends on: a link the user can see
 * is a link that neither 404s nor 403s.
 *
 * Slice 1 adds the expense lifecycle behind those screens: POST the manual
 * expense form (rule 1: manual only), then approve from the queue (rules 3
 * and 4). The approval action sits on /api/finance/... and is POST, the same
 * settlement CRM and HR reached for HTML forms.
 */

const finance = new Hono<AppEnv>()

type Ctx = Context<AppEnv>

function actorOf(c: Ctx): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}

function idParam(c: Ctx, name = 'expenseId'): number {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('Not found')
  return n
}

async function guard(c: Ctx, back: string, run: () => Promise<string>) {
  try {
    return okRedirect(c, back, await run())
  } catch (err) {
    if (!isAppError(err)) throw err
    return errRedirect(c, back, err.message)
  }
}

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

/* Expense lifecycle, slice 1 (rules 1, 3, 4, 7) --------------------------- */

/**
 * The manual expense form (rule 1).
 *
 * Only manual expenses are creatable here: the schema carries no
 * source_table/source_id fields, so the form cannot claim an upstream
 * document. The GRN, contractor-bill, equipment and campaign paths write
 * their own expenses from their own modules.
 */
finance.post('/app/finance/expenses', requirePermission(PERMISSIONS.FINANCE_EXPENSE_CREATE), async (c) => {
  const parsed = expenseCreateSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/finance/expenses', firstError(parsed.error))

  return guard(c, '/app/finance/expenses', async () => {
    const created = await svc.createExpense(c.get('db'), actorOf(c), parsed.data)
    return `Expense ${created.expenseNo} saved as a draft. Submit it from the expense screen when the details are final.`
  })
})

/**
 * Submits a draft expense to the approval queue.
 */
finance.post('/api/finance/expenses/:expenseId/submit', requirePermission(PERMISSIONS.FINANCE_EXPENSE_CREATE), async (c) => {
  const expenseId = idParam(c)
  return guard(c, '/app/finance/expenses', async () => {
    const expenseNo = await svc.submitExpense(c.get('db'), actorOf(c), expenseId)
    return `${expenseNo} submitted. It shows in the approval queue until somebody holding finance.expense_approve decides it.`
  })
})

/**
 * Approves an expense from the queue (rules 3 and 4).
 *
 * The route takes no body: the refusals are all about the row and the actor,
 * and the service reads roleKeys from the session's effective roles the same
 * way approvePo does. The user-facing message is whatever the service
 * returned (approved, awaiting a second signature) or the refusal reason.
 */
finance.post('/api/finance/expenses/:expenseId/approve', requirePermission(PERMISSIONS.FINANCE_EXPENSE_APPROVE), async (c) => {
  const expenseId = idParam(c)
  return guard(c, '/app/finance/expenses', async () => {
    const result = await svc.approveExpense(c.get('db'), actorOf(c), expenseId, c.get('roleKeys'))
    if (result.status === 'awaiting_second_approval') {
      return `${result.expenseNo} is above the single-approval threshold: the first signature is recorded and a second is required before it can be paid.`
    }
    return `${result.expenseNo} approved for ${result.totalPaise} paise. The period lock now guards its date.`
  })
})

/* Payments, slice 2 ------------------------------------------------------- */

/**
 * Records a payment, optionally with its first allocations.
 */
finance.post('/app/finance/payments', requirePermission(PERMISSIONS.FINANCE_PAYMENT_RECORD), async (c) => {
  const parsed = paymentCreateSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/finance/payments', firstError(parsed.error))

  return guard(c, '/app/finance/payments', async () => {
    const created = await svc.createPayment(c.get('db'), actorOf(c), parsed.data)
    return `Payment ${created.paymentNo} recorded for ${created.amountPaise} paise. The period lock now guards its date.`
  })
})

/**
 * Allocates an existing recorded payment against documents.
 */
finance.post('/api/finance/payments/:paymentId/allocate', requirePermission(PERMISSIONS.FINANCE_PAYMENT_RECORD), async (c) => {
  const paymentId = idParam(c, 'paymentId')
  const parsed = paymentAllocateSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/finance/payments', firstError(parsed.error))

  return guard(c, '/app/finance/payments', async () => {
    const result = await svc.allocatePayment(c.get('db'), actorOf(c), paymentId, parsed.data)
    return `${result.paymentNo}: ${result.allocatedCount} allocation${result.allocatedCount === 1 ? '' : 's'} recorded. paid_paise on each expense moved by exactly the allocated figure.`
  })
})

/* Site advances, slice 3 (rule 6) ------------------------------------------ */

/**
 * Issues a site advance. The body is minimal because the rule lives in the
 * service: it refuses when the employee's open advances would cross the
 * site_advance_open_threshold setting, and records the advance as an expenses
 * row so every existing guard sees it.
 */
finance.post('/app/finance/advances', requirePermission(PERMISSIONS.FINANCE_PAYMENT_RECORD), async (c) => {
  const parsed = siteAdvanceSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/finance/advances', firstError(parsed.error))

  return guard(c, '/app/finance/advances', async () => {
    const result = await svc.issueSiteAdvance(c.get('db'), actorOf(c), parsed.data)
    return `Site advance ${result.expenseNo} issued. Open outstanding on this employee is now ${result.openOutstandingPaise} paise.`
  })
})

export default finance

/* Client invoices, slice 4 (rule 5) ------------------------------------------ */

/**
 * Raises an invoice from a certified milestone. The rule lives in the
 * service: certification required, one invoice per milestone, GST split from
 * the stated place of supply, retention read through the milestone's
 * project. Reaches the 021 period-lock trigger through the service insert
 * exactly as the payment and expense paths do.
 */
finance.post('/app/finance/invoices', requirePermission(PERMISSIONS.FINANCE_INVOICE_MANAGE), async (c) => {
  const parsed = clientInvoiceCreateSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/finance/invoices', firstError(parsed.error))

  return guard(c, '/app/finance/invoices', async () => {
    const r = await createInvoiceFromMilestone(c.get('db'), actorOf(c), parsed.data)
    const split = r.igstPaise > 0 ? `IGST ${r.igstPaise}` : `CGST ${r.cgstPaise} + SGST ${r.sgstPaise}`
    return `Invoice ${r.invoiceNo} raised: taxable ${r.taxablePaise}, ${split}, retention ${r.retentionPaise}, net receivable ${r.netReceivablePaise}.`
  })
})
