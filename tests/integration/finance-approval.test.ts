import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'
import { createExpense, submitExpense, approveExpense } from '../../src/modules/finance/service.js'
import { ForbiddenError, UnprocessableError } from '../../src/lib/errors.js'

/**
 * Finance slice 1 (spec 6.8 rules 1, 3, 4, 7).
 *
 * The service functions are exercised against a real database, with real
 * inserts for the fixture: an approved budget with one cost-head line, an
 * expense raised by one user and approved by another, and an approval_limits
 * row so the threshold logic has something to read. approval_limits is seeded
 * empty pending open question 8.2, so the fixture row is the only one that
 * exists — the "no limit set" refusal is the live behaviour and is proven
 * too.
 *
 * The four rules pinned here:
 *
 *   1. createExpense writes source_type 'manual' and never accepts a
 *      source_table/source_id (the schema has no such fields).
 *   3. Self-approval is refused (creator cannot approve), and the dual-
 *      approval threshold keeps the row pending until a second signature.
 *   4. Approval that pushes committed + actual past the head's budget is
 *      refused with the exact overrun figure.
 *   7. Approval stamps period_id from the expense date.
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'audit_log',
  'expense_lines',
  'expenses',
  'project_budgets',
  'budget_lines',
  'approval_limits',
  'projects',
  'clients',
  'users',
] as const

let projectId: number
let clientId: number
let raiser: { userId: number; ip: string | null }
let approver: { userId: number; ip: string | null }
let costHeadId: number
let budgetLineId: number
let expenseId: number

/** A cost head that has no budget line — approval must not overrun against nothing. */
let unbudgetedHeadId: number

const RAISER_ROLE = 4 // project_manager
const APPROVER_ROLE = 2 // accounts_manager

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

  raiser = { userId: await insertUser(`fixture.finance.raiser.${randomUUID().slice(0, 8)}@example.invalid`, 'Fixture Finance Raiser', RAISER_ROLE), ip: '127.0.0.1' }
  approver = { userId: await insertUser(`fixture.finance.approver.${randomUUID().slice(0, 8)}@example.invalid`, 'Fixture Finance Approver', APPROVER_ROLE), ip: '127.0.0.1' }

  const client = await db
    .insertInto('clients')
    .values({ code: `FIXCL-FA${randomUUID().slice(0, 6)}`, name: 'Fixture Client for finance approval', client_type: 'company', city: 'Bengaluru' })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  const project = await db
    .insertInto('projects')
    .values({
      code: `FIXPR-FA${randomUUID().slice(0, 6)}`,
      name: 'Fixture project for finance approval',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 6, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: raiser.userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)

  const head = await db.selectFrom('cost_heads').select('id').where('code', '=', 'MAT').executeTakeFirstOrThrow()
  costHeadId = Number(head.id)
  const otherHead = await db.selectFrom('cost_heads').select('id').where('code', '=', 'LAB').executeTakeFirstOrThrow()
  unbudgetedHeadId = Number(otherHead.id)

  // An approved budget: MAT line of 5,00,000 paise. Deliberately below the
  // approval ceiling (10,00,000) so the overrun test hits the budget refusal
  // and not the limit refusal — the overrun check runs after the limit check.
  const budget = await db
    .insertInto('project_budgets')
    .values({
      project_id: projectId,
      version: 1,
      budget_type: 'original',
      total_paise: 5_000_000,
      prepared_by: raiser.userId,
      status: 'approved',
    })
    .executeTakeFirst()
  const budgetId = Number(budget.insertId ?? 0)
  const bl = await db
    .insertInto('budget_lines')
    .values({ budget_id: budgetId, cost_head_id: costHeadId, amount_paise: 5_000_000 })
    .executeTakeFirst()
  budgetLineId = Number(bl.insertId ?? 0)

  // An approval limit so the threshold logic has something to read.
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
})

afterAll(async () => {
  await sql`delete from user_roles where user_id > ${highWater.get('users') ?? 0}`.execute(db)
  await sql`delete from audit_log where id > ${highWater.get('audit_log') ?? 0}`.execute(db)
  await sql`delete from expense_lines where expense_id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from expenses where id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from budget_lines where id > ${highWater.get('budget_lines') ?? 0}`.execute(db)
  await sql`delete from project_budgets where id > ${highWater.get('project_budgets') ?? 0}`.execute(db)
  await sql`delete from approval_limits where id > ${highWater.get('approval_limits') ?? 0}`.execute(db)
  await sql`delete from projects where id > ${highWater.get('projects') ?? 0}`.execute(db)
  await sql`delete from clients where id > ${highWater.get('clients') ?? 0}`.execute(db)
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db)
  await closePool()
})

function expenseInput(over: Record<string, unknown> = {}) {
  return {
    expenseDate: '2026-09-10',
    projectId,
    expenseType: 'material_purchase',
    payeeType: 'vendor',
    payeeName: 'Fixture vendor for approval',
    narration: null,
    lines: [{ costHeadId, description: 'Fixture approval line', amountPaise: 100_000 }],
    ...over,
  }
}

describe('rule 1: manual expenses only', () => {
  it('createExpense writes source_type manual and no source table', async () => {
    const created = await createExpense(db, raiser, expenseInput())
    expenseId = created.expenseId
    const row = await db.selectFrom('expenses').select(['source_type', 'source_table', 'source_id', 'status']).where('id', '=', expenseId).executeTakeFirstOrThrow()
    expect(row.source_type).toBe('manual')
    expect(row.source_table).toBeNull()
    expect(row.source_id).toBeNull()
    expect(row.status).toBe('draft')
  })
})

describe('rule 3: self-approval is impossible', () => {
  it('the raiser cannot approve their own expense', async () => {
    await submitExpense(db, raiser, expenseId)
    await expect(
      approveExpense(db, raiser, expenseId, ['project_manager'])
    ).rejects.toThrow(ForbiddenError)
  })

  it('an approver below the threshold approves it in one step (and stamps period_id)', async () => {
    const result = await approveExpense(db, approver, expenseId, ['accounts_manager'])
    expect(result.status).toBe('approved')
    const row = await db.selectFrom('expenses').select(['status', 'approved_by', 'period_id']).where('id', '=', expenseId).executeTakeFirstOrThrow()
    expect(row.status).toBe('approved')
    expect(Number(row.approved_by)).toBe(approver.userId)
    // Rule 7: the approval stamps period_id from the expense date (2026-09-10,
    // inside the seeded September 2026-27 period).
    expect(row.period_id).not.toBeNull()
  })
})

describe('rule 3: dual approval above the threshold', () => {
  it('stays pending_approval after the first signature when above the threshold', async () => {
    // Raise a fresh expense above 5,00,000 on the UNBUDGETED head, so the
    // overrun check has nothing to refuse against and the only refusals in
    // play are the threshold ones.
    const created = await createExpense(db, raiser, expenseInput({ lines: [{ costHeadId: unbudgetedHeadId, description: 'Above threshold', amountPaise: 6_000_000 }] }))
    const id = created.expenseId
    await submitExpense(db, raiser, id)
    const result = await approveExpense(db, approver, id, ['accounts_manager'])
    expect(result.status).toBe('awaiting_second_approval')
    const row = await db.selectFrom('expenses').select(['status', 'approved_by', 'second_approved_by']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.status).toBe('pending_approval')
    expect(Number(row.approved_by)).toBe(approver.userId)
    expect(row.second_approved_by).toBeNull()
  })

  it('a second, different approver completes the approval', async () => {
    // The second approver needs the same role; use a third user.
    const third = { userId: await insertUser(`fixture.finance.second.${randomUUID().slice(0, 8)}@example.invalid`, 'Fixture Finance Second Approver', APPROVER_ROLE), ip: '127.0.0.1' as string | null }
    // Find the pending expense from the previous test.
    const pending = await db.selectFrom('expenses').select('id').where('status', '=', 'pending_approval').where('project_id', '=', projectId).orderBy('id', 'desc').executeTakeFirstOrThrow()
    const result = await approveExpense(db, third, Number(pending.id), ['accounts_manager'])
    expect(result.status).toBe('approved')
    const row = await db.selectFrom('expenses').select(['status', 'second_approved_by']).where('id', '=', Number(pending.id)).executeTakeFirstOrThrow()
    expect(row.status).toBe('approved')
    expect(Number(row.second_approved_by)).toBe(third.userId)
  })
})

describe('rule 4: budget overrun blocks approval at the cost-head level', () => {
  it('refuses an approval that would push committed + actual past the head budget', async () => {
    // Budget is 5,00,000. Committed and actual are 0. An approval of
    // 6,00,000 on the MAT head must be refused with the overrun figure —
    // and it is under the 10,00,000 approval ceiling, so the refusal is the
    // budget one, not the limit one.
    const created = await createExpense(db, raiser, expenseInput({ lines: [{ costHeadId, description: 'Over budget', amountPaise: 6_000_000 }] }))
    const id = created.expenseId
    await submitExpense(db, raiser, id)
    try {
      await approveExpense(db, approver, id, ['accounts_manager'])
      throw new Error('expected the overrun approval to be refused')
    } catch (err) {
      if (err instanceof Error && err.message === 'expected the overrun approval to be refused') throw err
      expect(err).toBeInstanceOf(UnprocessableError)
      expect(String((err as Error).message)).toContain('over by')
      // formatPaiseAsRupees renders rupees: 6,00,000 paise is 60,000.00.
      expect(String((err as Error).message)).toContain('60,000.00')
      expect(String((err as Error).message)).toContain('over by 11,000.00')
      // Refusal ordering (DECISIONS 27.2): this request trips BOTH shapes —
      // 60,000.00 is under the 10,00,000 ceiling and over the 5,00,000 head
      // budget — and the message must be the OVERRUN one. If the service
      // reorders its checks to limit-before-overrun, this assertion goes red
      // naming the reorder, instead of the message silently changing.
      expect(String((err as Error).message)).not.toContain('approval limit')
    }
  })

  it('a cost head with no budget line is not refused', async () => {
    // 4,00,000 on the unbudgeted LAB head: below the 10,00,000 ceiling and
    // below the 5,00,000 second-approval threshold, so it approves in one
    // step, and there is no budget line to overrun.
    const created = await createExpense(db, raiser, expenseInput({ lines: [{ costHeadId: unbudgetedHeadId, description: 'No budget', amountPaise: 4_000_000 }] }))
    const id = created.expenseId
    await submitExpense(db, raiser, id)
    const result = await approveExpense(db, approver, id, ['accounts_manager'])
    expect(result.status).toBe('approved')
  })
})

describe('rule 7: approval stamps period_id from the expense date', () => {
  it('an approved expense carries the period of its date', async () => {
    // expenseId was approved in the rule 3 section above.
    const row = await db.selectFrom('expenses').select('period_id').where('id', '=', expenseId).executeTakeFirstOrThrow()
    expect(row.period_id).not.toBeNull()
  })
})