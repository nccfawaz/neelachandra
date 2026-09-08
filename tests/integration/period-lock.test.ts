import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'

/**
 * The §6.8 rule 7 period lock (migration 021).
 *
 * The lock is a pair of BEFORE triggers per table on expenses.expense_date,
 * payments.payment_date and client_invoices.invoice_date, refusing any row
 * whose date falls inside an accounting_periods row with status
 * 'soft_closed' or 'closed'. The trigger reads accounting_periods with a
 * range scan over (status, period_start, period_end), which is what
 * idx_period_lock indexes.
 *
 * Four shapes are proven here by direct insert, the same four the trigger
 * design exists for:
 *
 *   1. A row dated inside an open period is admitted.
 *   2. A row dated inside a closed period is refused. This shape sets
 *      period_id to the closed period — it is the case a period_id-based
 *      check (the spec sketch's "single indexed check") would catch.
 *   3. An UPDATE moving a row's date into a closed period is refused (and so
 *      is any update to a row already dated inside one — the lock is about
 *      the row's date, not the change).
 *   4. A draft with period_id NULL dated inside a closed period is refused.
 *      This is the hole a period_id-based check cannot see: drafts are
 *      stamped with period_id only on approval, so a date-based check is the
 *      only one that sees the draft at all. The spec's own sketch at
 *      NCC_BUILD_SPEC.md:2146 says the refusal is about the date.
 *
 * Fixtures use a financial year ('2099-00') that no seeded period occupies,
 * so the uq_period (financial_year, month) key is safe and no fixture date
 * can collide with the twelve seeded 2026-27 periods (all 'open').
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'expenses',
  'payments',
  'client_invoices',
  'accounting_periods',
  'projects',
  'clients',
  'users',
] as const

let projectId: number
let clientId: number
let userId: number
let closedPeriodId: number

const OPEN_DATE = '2099-01-15'
const CLOSED_DATE = '2099-02-15'
const SOFT_CLOSED_DATE = '2099-03-15'

/**
 * Runs the promise, asserts the trigger refused it, and fails the test if
 * the statement was admitted instead.
 */
async function expectRefused(promise: Promise<unknown>, label: string): Promise<void> {
  let refused = false
  try {
    await promise
  } catch (err) {
    refused = true
    expect(err instanceof Error ? err.message : String(err)).toContain('closed accounting period')
  }
  if (!refused) {
    throw new Error(`expected ${label} to be refused by the period lock`)
  }
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const user = await db
    .insertInto('users')
    .values({
      email: `fixture.period.lock.${randomUUID().slice(0, 8)}@example.invalid`,
      full_name: 'Fixture Period Lock User',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  userId = Number(user.insertId ?? 0)

  const client = await db
    .insertInto('clients')
    .values({
      code: `FIXCL-PL${randomUUID().slice(0, 6)}`,
      name: 'Fixture Client for period lock',
      client_type: 'company',
      city: 'Bengaluru',
    })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  const project = await db
    .insertInto('projects')
    .values({
      code: `FIXPR-PL${randomUUID().slice(0, 6)}`,
      name: 'Fixture project for period lock',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 5, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)

  await db
    .insertInto('accounting_periods')
    .values({
      financial_year: '2099-00',
      month: 1,
      period_start: '2099-01-01',
      period_end: '2099-01-31',
      status: 'open',
    })
    .executeTakeFirst()

  const closedPeriod = await db
    .insertInto('accounting_periods')
    .values({
      financial_year: '2099-00',
      month: 2,
      period_start: '2099-02-01',
      period_end: '2099-02-28',
      status: 'closed',
    })
    .executeTakeFirst()
  closedPeriodId = Number(closedPeriod.insertId ?? 0)

  await db
    .insertInto('accounting_periods')
    .values({
      financial_year: '2099-00',
      month: 3,
      period_start: '2099-03-01',
      period_end: '2099-03-31',
      status: 'soft_closed',
    })
    .executeTakeFirst()
})

afterAll(async () => {
  // Child first, and before the periods: the period_id FKs are ON DELETE
  // RESTRICT, so the rows must go before the periods they reference.
  await sql`delete from expenses where id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from payments where id > ${highWater.get('payments') ?? 0}`.execute(db)
  await sql`delete from client_invoices where id > ${highWater.get('client_invoices') ?? 0}`.execute(db)
  await sql`delete from accounting_periods where id > ${highWater.get('accounting_periods') ?? 0}`.execute(db)
  await sql`delete from projects where id > ${highWater.get('projects') ?? 0}`.execute(db)
  await sql`delete from clients where id > ${highWater.get('clients') ?? 0}`.execute(db)
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db)
  await closePool()
})

describe('expenses: the four shapes', () => {
  it('shape 1: a row dated inside an open period is admitted', async () => {
    const row = await db
      .insertInto('expenses')
      .values({
        expense_no: `PLEXP-OPEN-${randomUUID().slice(0, 8)}`,
        expense_date: OPEN_DATE,
        project_id: projectId,
        expense_type: 'site_overhead',
        payee_type: 'other',
        payee_name: 'Fixture open-period payee',
        source_type: 'manual',
        status: 'draft',
        created_by: userId,
      })
      .executeTakeFirst()
    expect(Number(row.insertId ?? 0)).toBeGreaterThan(0)
  })

  it('shape 2: a row dated inside a closed period is refused (period_id set)', async () => {
    // period_id points at the closed period: this is the shape a
    // period_id-based check would catch.
    await expectRefused(
      db
        .insertInto('expenses')
        .values({
          expense_no: `PLEXP-CLOSED-${randomUUID().slice(0, 8)}`,
          expense_date: CLOSED_DATE,
          project_id: projectId,
          expense_type: 'site_overhead',
          payee_type: 'other',
          payee_name: 'Fixture closed-period payee',
          source_type: 'manual',
          status: 'draft',
          period_id: closedPeriodId,
          created_by: userId,
        })
        .execute(),
      'an insert dated inside a closed period with period_id set',
    )
  })

  it('shape 3: an UPDATE into a closed period is refused', async () => {
    const row = await db
      .insertInto('expenses')
      .values({
        expense_no: `PLEXP-UPD-${randomUUID().slice(0, 8)}`,
        expense_date: OPEN_DATE,
        project_id: projectId,
        expense_type: 'site_overhead',
        payee_type: 'other',
        payee_name: 'Fixture update payee',
        source_type: 'manual',
        status: 'draft',
        created_by: userId,
      })
      .executeTakeFirst()
    const expenseId = Number(row.insertId ?? 0)
    await expectRefused(
      db.updateTable('expenses').set({ expense_date: CLOSED_DATE }).where('id', '=', expenseId).execute(),
      'an update moving a row into a closed period',
    )
  })

  it('shape 4: a draft with NULL period_id dated inside a closed period is refused', async () => {
    // period_id is omitted entirely — NULL, as every draft is before
    // approval stamps it. A period_id-based check would admit this row; the
    // date-based trigger refuses it. This is the hole the spec sketch's
    // "single indexed check" cannot see.
    await expectRefused(
      db
        .insertInto('expenses')
        .values({
          expense_no: `PLEXP-NULLPER-${randomUUID().slice(0, 8)}`,
          expense_date: CLOSED_DATE,
          project_id: projectId,
          expense_type: 'site_overhead',
          payee_type: 'other',
          payee_name: 'Fixture null-period payee',
          source_type: 'manual',
          status: 'draft',
          created_by: userId,
        })
        .execute(),
      'a draft with NULL period_id dated inside a closed period',
    )
  })

  it('a soft-closed period locks exactly like a closed one', async () => {
    await expectRefused(
      db
        .insertInto('expenses')
        .values({
          expense_no: `PLEXP-SOFT-${randomUUID().slice(0, 8)}`,
          expense_date: SOFT_CLOSED_DATE,
          project_id: projectId,
          expense_type: 'site_overhead',
          payee_type: 'other',
          payee_name: 'Fixture soft-closed payee',
          source_type: 'manual',
          status: 'draft',
          created_by: userId,
        })
        .execute(),
      'an insert dated inside a soft-closed period',
    )
  })
})

describe('payments: the lock fires on payment_date', () => {
  it('admits a payment dated in an open period', async () => {
    const row = await db
      .insertInto('payments')
      .values({
        payment_no: `PLPAY-OPEN-${randomUUID().slice(0, 8)}`,
        payment_date: OPEN_DATE,
        direction: 'outgoing',
        amount_paise: 100_000,
        payee_or_payer: 'Fixture open-period payee',
        project_id: projectId,
        created_by: userId,
      })
      .executeTakeFirst()
    expect(Number(row.insertId ?? 0)).toBeGreaterThan(0)
  })

  it('refuses a payment dated in a closed period', async () => {
    await expectRefused(
      db
        .insertInto('payments')
        .values({
          payment_no: `PLPAY-CLOSED-${randomUUID().slice(0, 8)}`,
          payment_date: CLOSED_DATE,
          direction: 'outgoing',
          amount_paise: 100_000,
          payee_or_payer: 'Fixture closed-period payee',
          project_id: projectId,
          created_by: userId,
        })
        .execute(),
      'a payment dated inside a closed period',
    )
  })
})

describe('client_invoices: the lock fires on invoice_date', () => {
  it('admits an invoice dated in an open period', async () => {
    const row = await db
      .insertInto('client_invoices')
      .values({
        invoice_no: `PLINV-OPEN-${randomUUID().slice(0, 8)}`,
        project_id: projectId,
        client_id: clientId,
        invoice_date: OPEN_DATE,
        due_date: '2099-01-31',
        created_by: userId,
      })
      .executeTakeFirst()
    expect(Number(row.insertId ?? 0)).toBeGreaterThan(0)
  })

  it('refuses an invoice dated in a closed period', async () => {
    await expectRefused(
      db
        .insertInto('client_invoices')
        .values({
          invoice_no: `PLINV-CLOSED-${randomUUID().slice(0, 8)}`,
          project_id: projectId,
          client_id: clientId,
          invoice_date: CLOSED_DATE,
          due_date: '2099-02-28',
          created_by: userId,
        })
        .execute(),
      'an invoice dated inside a closed period',
    )
  })
})