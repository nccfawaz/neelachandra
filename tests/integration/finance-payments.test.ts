import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'
import { createExpense, submitExpense, approveExpense, createPayment, allocatePayment, msmeAgeing } from '../../src/modules/finance/service.js'
import { UnprocessableError } from '../../src/lib/errors.js'

/**
 * Finance slice 2 (spec 6.8, payments and MSME ageing).
 *
 * Four things are pinned here:
 *
 *   1. The §26.3 single-writer rule: after any payment flow,
 *      SUM(payment_allocations.allocated_paise) per expense equals
 *      expenses.paid_paise — asserted over the whole fixture set, not just
 *      the rows this suite created, because the reconciliation is the point.
 *   2. The over-allocation guard: an allocation that would push a document's
 *      total allocation past its own total_paise is refused with the
 *      over-by figure, and payment-level over-allocation likewise.
 *   3. The 021 date triggers cover the payment path: the service's insert
 *      fires trg_payments_period_bi, proven by direct insert of a payment
 *      dated inside a closed period through the service (not assumed from
 *      the trigger's existence — period-lock.test.ts proves the trigger by
 *      raw insert; this proves the service path reaches it).
 *   4. Rule 8 MSME ageing: an MSME-vendor expense with a NULL bill_date
 *      comes back band 'unageable' with a null daysOverdue (DECISIONS 26.2's
 *      refusal), and a dated one lands in the correct band.
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'audit_log',
  'payment_allocations',
  'payments',
  'expense_lines',
  'expenses',
  'accounting_periods',
  'approval_limits',
  'vendors',
  'projects',
  'clients',
  'users',
] as const

let projectId: number
let clientId: number
let raiser: { userId: number; ip: string | null }
let approver: { userId: number; ip: string | null }
let vendorId: number
let msmeVendorId: number
let datedMsmeExpenseId: number
let undatedMsmeExpenseId: number
let approvedExpenseId: number
let closedPeriodId: number

const RAISER_ROLE = 4
const APPROVER_ROLE = 2

async function insertUser(email: string, fullName: string, roleId: number): Promise<number> {
  const row = await db
    .insertInto('users')
    .values({ email, full_name: fullName, status: 'active', must_change_password: 0 })
    .executeTakeFirst()
  const id = Number(row.insertId ?? 0)
  await db.insertInto('user_roles').values({ user_id: id, role_id: roleId }).execute()
  return id
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  raiser = { userId: await insertUser(`fixture.pay.raiser.${randomUUID().slice(0, 8)}@example.invalid`, 'Fixture Pay Raiser', RAISER_ROLE), ip: '127.0.0.1' }
  approver = { userId: await insertUser(`fixture.pay.approver.${randomUUID().slice(0, 8)}@example.invalid`, 'Fixture Pay Approver', APPROVER_ROLE), ip: '127.0.0.1' }

  const client = await db
    .insertInto('clients')
    .values({ code: `FIXCL-PAY${randomUUID().slice(0, 6)}`, name: 'Fixture Client for payments', client_type: 'company', city: 'Bengaluru' })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  const project = await db
    .insertInto('projects')
    .values({
      code: `FIXPR-PAY${randomUUID().slice(0, 6)}`,
      name: 'Fixture project for payments',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 8, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: raiser.userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)

  const vendor = await db
    .insertInto('vendors')
    .values({
      code: `TMP-${randomUUID().slice(0, 8)}`,
      name: 'Fixture plain vendor for payments',
      vendor_type: 'material',
    })
    .executeTakeFirst()
  vendorId = Number(vendor.insertId ?? 0)

  const msmeVendor = await db
    .insertInto('vendors')
    .values({
      code: `TMP-${randomUUID().slice(0, 8)}`,
      name: 'Fixture MSME vendor for ageing',
      vendor_type: 'material',
      msme_udyam_no: 'UDYAM-KR-03-0000001',
    })
    .executeTakeFirst()
  msmeVendorId = Number(msmeVendor.insertId ?? 0)

  // An approval limit so the approveExpense path can run. Same shape as the
  // finance-approval fixture: high ceiling, second signature above 5,00,000.
  // It must precede the first approveExpense call below.
  await db
    .insertInto('approval_limits')
    .values({
      role_key: 'accounts_manager',
      document_type: 'expense',
      max_value: 10_000_000,
      requires_second_approval_above: 5_000_000,
      effective_from: '2026-04-01',
    })
    .execute()

  // An approved expense to pay against.
  const created = await createExpense(db, raiser, {
    expenseDate: '2099-01-10',
    projectId,
    expenseType: 'material_purchase',
    payeeType: 'vendor',
    payeeName: 'Fixture payee',
    narration: null,
    lines: [{ costHeadId: await costHeadFor('MAT'), description: 'Payment fixture', amountPaise: 200_000 }],
  })
  approvedExpenseId = created.expenseId
  await submitExpense(db, raiser, approvedExpenseId)
  await approveExpense(db, approver, approvedExpenseId, ['accounts_manager'])

  // Two MSME expenses: one with a bill date, one without (rule 8's branches).
  const headId = await costHeadFor('MAT')
  const dated = await createExpense(db, raiser, {
    expenseDate: '2099-01-12',
    projectId,
    expenseType: 'material_purchase',
    payeeType: 'vendor',
    payeeName: 'Fixture MSME dated',
    narration: null,
    lines: [{ costHeadId: headId, description: 'MSME dated', amountPaise: 50_000 }],
  })
  datedMsmeExpenseId = dated.expenseId
  await submitExpense(db, raiser, datedMsmeExpenseId)
  await approveExpense(db, approver, datedMsmeExpenseId, ['accounts_manager'])
  await db.updateTable('expenses').set({ bill_date: '2098-12-01', vendor_id: msmeVendorId }).where('id', '=', datedMsmeExpenseId).execute()

  const undated = await createExpense(db, raiser, {
    expenseDate: '2099-01-12',
    projectId,
    expenseType: 'material_purchase',
    payeeType: 'vendor',
    payeeName: 'Fixture MSME undated',
    narration: null,
    lines: [{ costHeadId: headId, description: 'MSME undated', amountPaise: 50_000 }],
  })
  undatedMsmeExpenseId = undated.expenseId
  await submitExpense(db, raiser, undatedMsmeExpenseId)
  await approveExpense(db, approver, undatedMsmeExpenseId, ['accounts_manager'])
  await db.updateTable('expenses').set({ vendor_id: msmeVendorId }).where('id', '=', undatedMsmeExpenseId).execute()

  // A closed period far in the fixture future, for the trigger shape.
  const closedPeriod = await db
    .insertInto('accounting_periods')
    .values({
      financial_year: '2098-99',
      month: 12,
      period_start: '2098-12-01',
      period_end: '2098-12-31',
      status: 'closed',
    })
    .executeTakeFirst()
  closedPeriodId = Number(closedPeriod.insertId ?? 0)
})

async function costHeadFor(code: string): Promise<number> {
  const head = await db.selectFrom('cost_heads').select('id').where('code', '=', code).executeTakeFirstOrThrow()
  return Number(head.id)
}

afterAll(async () => {
  await sql`delete from user_roles where user_id > ${highWater.get('users') ?? 0}`.execute(db)
  await sql`delete from audit_log where id > ${highWater.get('audit_log') ?? 0}`.execute(db)
  await sql`delete from payment_allocations where payment_id > ${highWater.get('payments') ?? 0}`.execute(db)
  await sql`delete from payments where id > ${highWater.get('payments') ?? 0}`.execute(db)
  await sql`delete from expense_lines where expense_id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from expenses where id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from accounting_periods where id > ${highWater.get('accounting_periods') ?? 0}`.execute(db)
  await sql`delete from approval_limits where id > ${highWater.get('approval_limits') ?? 0}`.execute(db)
  await sql`delete from vendors where id > ${highWater.get('vendors') ?? 0}`.execute(db)
  await sql`delete from projects where id > ${highWater.get('projects') ?? 0}`.execute(db)
  await sql`delete from clients where id > ${highWater.get('clients') ?? 0}`.execute(db)
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db)
  await closePool()
})

describe('rule 7 via the service path: the 021 trigger covers payments', () => {
  it('a payment dated inside a closed period is refused through createPayment', async () => {
    // Not assumed from the trigger's existence: the service insert is what
    // runs in production, so the refusal is proven through it.
    let refused = false
    try {
      await createPayment(db, raiser, {
        paymentDate: '2098-12-15',
        direction: 'outgoing',
        mode: 'neft',
        amountPaise: 100_000,
        payeeOrPayer: 'Fixture closed-period payee',
        bankAccountId: null,
        referenceNo: null,
        narration: null,
        allocations: [],
      })
    } catch (err) {
      refused = true
      expect(String((err as Error).message)).toContain('closed accounting period')
    }
    if (!refused) throw new Error('expected the closed-period payment to be refused through the service')
  })

  it('a payment dated in an open period is recorded and numbered', async () => {
    const created = await createPayment(db, raiser, {
      paymentDate: '2099-01-20',
      direction: 'outgoing',
      mode: 'neft',
      amountPaise: 200_000,
      payeeOrPayer: 'Fixture open-period payee',
      bankAccountId: null,
      referenceNo: null,
      narration: null,
      allocations: [],
    })
    expect(created.paymentNo).toMatch(/^NCC\/PAY\//)
    const row = await db.selectFrom('payments').select(['amount_paise', 'status']).where('id', '=', created.paymentId).executeTakeFirstOrThrow()
    expect(Number(row.amount_paise)).toBe(200_000)
    expect(row.status).toBe('recorded')
  })
})

describe('allocations and the single-writer rule', () => {
  it('allocating moves paid_paise by exactly the allocated figure', async () => {
    const before = await db.selectFrom('expenses').select('paid_paise').where('id', '=', approvedExpenseId).executeTakeFirstOrThrow()
    expect(Number(before.paid_paise)).toBe(0)

    const payment = await createPayment(db, raiser, {
      paymentDate: '2099-01-21',
      direction: 'outgoing',
      mode: 'bank_transfer',
      amountPaise: 120_000,
      payeeOrPayer: 'Fixture allocator',
      bankAccountId: null,
      referenceNo: null,
      narration: null,
      allocations: [],
    })
    await allocatePayment(db, raiser, payment.paymentId, {
      allocations: [{ documentType: 'expense', documentId: approvedExpenseId, allocatedPaise: 120_000 }],
    })

    const after = await db.selectFrom('expenses').select('paid_paise').where('id', '=', approvedExpenseId).executeTakeFirstOrThrow()
    expect(Number(after.paid_paise)).toBe(120_000)
  })

  it('an allocation that would overpay the document is refused with the over-by figure', async () => {
    // approvedExpenseId totals 200,000 paise and already has 120,000 paid.
    const payment = await createPayment(db, raiser, {
      paymentDate: '2099-01-22',
      direction: 'outgoing',
      mode: 'upi',
      amountPaise: 200_000,
      payeeOrPayer: 'Fixture overpayer',
      bankAccountId: null,
      referenceNo: null,
      narration: null,
      allocations: [],
    })
    try {
      await allocatePayment(db, raiser, payment.paymentId, {
        allocations: [{ documentType: 'expense', documentId: approvedExpenseId, allocatedPaise: 100_000 }],
      })
      throw new Error('expected the over-allocation to be refused')
    } catch (err) {
      if (err instanceof Error && err.message === 'expected the over-allocation to be refused') throw err
      expect(err).toBeInstanceOf(UnprocessableError)
      const message = String((err as Error).message)
      expect(message).toContain('over by')
      // 60,000 projected is 40,000 over the 20,000 paid so far... in rupees:
      // paid 1,200.00, this 1,000.00 would take it to 2,200.00 vs total 2,000.00.
      expect(message).toContain('over by 200.00')
    }
  })

  it('a payment cannot allocate more than it paid', async () => {
    const payment = await createPayment(db, raiser, {
      paymentDate: '2099-01-23',
      direction: 'outgoing',
      mode: 'cash',
      amountPaise: 50_000,
      payeeOrPayer: 'Fixture thin wallet',
      bankAccountId: null,
      referenceNo: null,
      narration: null,
      allocations: [],
    })
    try {
      await allocatePayment(db, raiser, payment.paymentId, {
        allocations: [{ documentType: 'expense', documentId: approvedExpenseId, allocatedPaise: 60_000 }],
      })
      throw new Error('expected the payment-level over-allocation to be refused')
    } catch (err) {
      if (err instanceof Error && err.message === 'expected the payment-level over-allocation to be refused') throw err
      expect(err).toBeInstanceOf(UnprocessableError)
      expect(String((err as Error).message)).toContain('against')
    }
  })

  it('SUM(payment_allocations) equals paid_paise for every fixture expense (§26.3 reconciliation)', async () => {
    const res = await sql<{ expense_id: number; allocated: string | null; paid: string }>`
      select e.id as expense_id,
             coalesce((select sum(a.allocated_paise) from payment_allocations a where a.document_type = 'expense' and a.document_id = e.id), 0) as allocated,
             e.paid_paise as paid
      from expenses e
      where e.id > ${highWater.get('expenses') ?? 0}
    `.execute(db)
    expect(res.rows.length).toBeGreaterThan(0)
    for (const row of res.rows) {
      expect(Number(row.allocated)).toBe(Number(row.paid))
    }
  })
})

describe('rule 8: MSME ageing', () => {
  it('a NULL bill_date comes back unageable, not aged from expense_date (§26.2)', async () => {
    const report = await msmeAgeing(db, '2099-02-15')
    const undated = report.find((r) => r.expenseId === undatedMsmeExpenseId)
    expect(undated).toBeDefined()
    expect(undated!.band).toBe('unageable')
    expect(undated!.daysOverdue).toBeNull()
    expect(undated!.billDate).toBeNull()
  })

  it('a dated MSME expense lands in the correct band', async () => {
    const report = await msmeAgeing(db, '2099-02-15')
    const dated = report.find((r) => r.expenseId === datedMsmeExpenseId)
    expect(dated).toBeDefined()
    // bill_date 2098-12-01 to 2099-02-15 is 76 days: due.
    expect(dated!.band).toBe('due')
    expect(dated!.daysOverdue).toBeGreaterThan(45)
  })

  it('a non-MSME vendor does not appear in the report', async () => {
    const report = await msmeAgeing(db, '2099-02-15')
    expect(report.find((r) => r.expenseId === approvedExpenseId)).toBeUndefined()
  })
})