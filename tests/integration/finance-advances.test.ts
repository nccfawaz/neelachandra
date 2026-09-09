import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { issueSiteAdvance, openAdvanceOutstanding } from '../../src/modules/finance/service.js'
import { runBudgetAlerts } from '../../src/modules/finance/budgetAlerts.js'
import { invalidateSettings } from '../../src/lib/settings.js'
import { UnprocessableError } from '../../src/lib/errors.js'

/**
 * Finance slice 3 (spec 6.8 rule 6 and the budget-alerts cron).
 *
 *   1. Rule 6: issuing an advance that would take an employee's open
 *      outstanding past the site_advance_open_threshold setting is refused,
 *      naming the figures. A missing settings row reads as zero — proven by
 *      deleting the row and watching a fresh advance refuse.
 *   2. The §26.3-shaped reconciliation for advances: outstanding read through
 *      openAdvanceOutstanding equals SUM(net_payable_paise - paid_paise)
 *      computed independently in SQL for every fixture employee.
 *   3. Budget alerts read the 020 views, never recompute: the zero-rows case
 *      returns no alert (and not a NULL comparison — the SQL COALESCEs, the
 *      assertion is on the empty result), and a fixture whose committed +
 *      actual crosses its approved budget produces exactly one alert for that
 *      head.
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'audit_log',
  'expense_lines',
  'expenses',
  'project_budgets',
  'approval_limits',
  'notifications',
  'settings',
  'employees',
  'projects',
  'clients',
  'users',
] as const

let projectId: number
let clientId: number
let employeeId: number
let actor: { userId: number; ip: string | null }

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

  actor = { userId: await insertUser(`fixture.adv.actor.${randomUUID().slice(0, 8)}@example.invalid`, 'Fixture Advance Actor', 2), ip: '127.0.0.1' }
  // The actor also holds accounts_manager so the budget-alert notification
  // recipients query finds at least one active watcher (roles 1 and 6).
  await db.insertInto('user_roles').values({ user_id: actor.userId, role_id: 6 }).execute()

  const client = await db
    .insertInto('clients')
    .values({ code: `FIXCL-ADV${randomUUID().slice(0, 6)}`, name: 'Fixture Client for advances', client_type: 'company', city: 'Bengaluru' })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  const project = await db
    .insertInto('projects')
    .values({
      code: `FIXPR-ADV${randomUUID().slice(0, 6)}`,
      name: 'Fixture project for advances',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 9, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: actor.userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)

  const employee = await db
    .insertInto('employees')
    .values({
      employee_code: `TMP-${randomUUID().slice(0, 8)}`,
      full_name: 'Fixture Advance Employee',
      employment_type: 'permanent',
      date_of_joining: '2026-01-01',
    })
    .executeTakeFirst()
  employeeId = Number(employee.insertId ?? 0)

  // The threshold setting: 10,00,000 paise open-advance ceiling.
  await db
    .insertInto('settings')
    .values({ key_name: 'site_advance_open_threshold', value_json: '1000000', data_type: 'money', label: 'fixture threshold' })
    .onDuplicateKeyUpdate({ label: 'fixture threshold' })
    .execute()
})

afterAll(async () => {
  await sql`delete from user_roles where user_id > ${highWater.get('users') ?? 0}`.execute(db)
  await sql`delete from audit_log where id > ${highWater.get('audit_log') ?? 0}`.execute(db)
  await sql`delete from notifications where id > ${highWater.get('notifications') ?? 0}`.execute(db)
  await sql`delete from expense_lines where expense_id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from expenses where id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from budget_lines where budget_id > ${highWater.get('project_budgets') ?? 0}`.execute(db)
  await sql`delete from project_budgets where id > ${highWater.get('project_budgets') ?? 0}`.execute(db)
  await sql`delete from settings where key_name = 'site_advance_open_threshold'`.execute(db)
  await sql`delete from approval_limits where id > ${highWater.get('approval_limits') ?? 0}`.execute(db)
  await sql`delete from employees where id > ${highWater.get('employees') ?? 0}`.execute(db)
  await sql`delete from projects where id > ${highWater.get('projects') ?? 0}`.execute(db)
  await sql`delete from clients where id > ${highWater.get('clients') ?? 0}`.execute(db)
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db)
  await closePool()
})

describe('rule 6: site advances', () => {
  it('an advance within the threshold is issued as an approved expense row', async () => {
    const result = await issueSiteAdvance(db, actor, {
      employeeId,
      projectId,
      amountPaise: 400_000,
      narration: null,
    })
    expect(result.expenseNo).toMatch(/^NCC\/EXP\//)
    expect(result.openOutstandingPaise).toBe(400_000)

    const row = await db
      .selectFrom('expenses')
      .select(['status', 'payee_type', 'net_payable_paise'])
      .where('id', '=', result.expenseId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('approved')
    expect(row.payee_type).toBe('employee')
    expect(Number(row.net_payable_paise)).toBe(400_000)
  })

  it('an advance that would cross the threshold is refused, naming the figures', async () => {
    try {
      await issueSiteAdvance(db, actor, { employeeId, projectId, amountPaise: 700_000, narration: null })
      throw new Error('expected the threshold refusal')
    } catch (err) {
      if (err instanceof Error && err.message === 'expected the threshold refusal') throw err
      expect(err).toBeInstanceOf(UnprocessableError)
      const message = String((err as Error).message)
      expect(message).toContain('4,000.00') // outstanding in rupees
      expect(message).toContain('10,000.00') // threshold in rupees
    }
  })

  it('a missing settings row reads as a zero threshold, not an unbounded one', async () => {
    await sql`delete from settings where key_name = 'site_advance_open_threshold'`.execute(db)
    invalidateSettings() // the 60s TTL would otherwise serve the deleted row
    try {
      await issueSiteAdvance(db, actor, { employeeId, projectId, amountPaise: 1, narration: null })
      throw new Error('expected the zero-threshold refusal')
    } catch (err) {
      if (err instanceof Error && err.message === 'expected the zero-threshold refusal') throw err
      expect(err).toBeInstanceOf(UnprocessableError)
      expect(String((err as Error).message)).toContain('0.00')
    }
  })

  it('outstanding read through the service reconciles with independent SQL (§26.3 shape)', async () => {
    const viaService = await openAdvanceOutstanding(db, employeeId)
    const res = await sql<{ s: string | null }>`
      select coalesce(sum(net_payable_paise - paid_paise), 0) as s
      from expenses
      where employee_id = ${employeeId}
        and payee_type = 'employee'
        and advance_settlement_of is null
        and status in ('pending_approval', 'approved', 'part_paid')
    `.execute(db)
    expect(viaService).toBe(Number(res.rows[0]?.s ?? 0))
  })
})

describe('budget alerts read the 020 views', () => {
  it('zero rows at or over budget returns no alert, not a NULL comparison', async () => {
    // Nothing in the fixture has a budget, so the enumeration is empty. The
    // COALESCEs in the query mean each candidate row compares numbers; the
    // empty result is what proves the query itself does not blow up or
    // fabricate an alert out of a NULL.
    const result = await runBudgetAlerts(db)
    expect(result.alerts).toHaveLength(0)
    expect(result.notified).toBe(0)
  })

  it('a head whose committed + actual reaches its budget alerts exactly once', async () => {
    // Approved budget of 5,00,000 paise; an approved expense of 5,00,000 on
    // the same head puts actual on the line (>= threshold).
    const head = await db.selectFrom('cost_heads').select('id').where('code', '=', 'LAB').executeTakeFirstOrThrow()
    const headId = Number(head.id)
    const budget = await db
      .insertInto('project_budgets')
      .values({
        project_id: projectId,
        total_paise: 500_000,
        prepared_by: actor.userId,
        approved_by: actor.userId,
        approved_at: '2026-01-01',
        status: 'approved',
      })
      .executeTakeFirst()
    const budgetId = Number(budget.insertId ?? 0)
    await db
      .insertInto('budget_lines')
      .values({ budget_id: budgetId, cost_head_id: headId, amount_paise: 500_000 })
      .execute()

    // The advance route is not used here; a direct approved expense keeps the
    // fixture independent of the approval service.
    const todayRow = await sql<{ d: string }>`select curdate() as d`.execute(db)
    const d = todayRow.rows[0]!.d
    const inserted = await db
      .insertInto('expenses')
      .values({
        expense_no: `TMP-${randomUUID().slice(0, 12)}`,
        expense_date: d,
        project_id: projectId,
        expense_type: 'other',
        payee_type: 'other',
        source_type: 'manual',
        narration: 'Budget alert fixture',
        total_paise: 500_000,
        net_payable_paise: 500_000,
        status: 'approved',
        created_by: actor.userId,
      })
      .executeTakeFirst()
    const expenseId = Number(inserted.insertId ?? 0)
    const expenseNo = `NCC/EXP/2099-26/${randomUUID().slice(0, 6).toUpperCase()}`
    await db.updateTable('expenses').set({ expense_no: expenseNo }).where('id', '=', expenseId).execute()
    await db.insertInto('expense_lines').values({
      expense_id: expenseId,
      cost_head_id: headId,
      description: 'Budget alert fixture line',
      amount_paise: 500_000,
    }).execute()

    const result = await runBudgetAlerts(db)
    const mine = result.alerts.filter((a) => a.projectId === projectId && a.costHeadId === headId)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.budgetPaise).toBe(500_000)
    expect(mine[0]!.spentPaise).toBe(500_000)
    // Notifications went to every active holder of the two watching roles.
    expect(result.notified).toBeGreaterThan(0)
  })
})
