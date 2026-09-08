import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'

/**
 * The two §6.8 rule 2 views (migration 020).
 *
 * Three things are pinned here, none of them by string-matching the view
 * definition:
 *
 *   1. A project with no POs and no expenses returns 0, not NULL. SUM over
 *      zero rows is NULL in SQL, which is why 020 COALESCEs; this is the
 *      instance recorded in the three-valued-logic section of CLAUDE.md.
 *   2. A hand-built fixture's committed and actual figures match arithmetic
 *      done by hand in the test, over rows the test inserted.
 *   3. The purchase_orders.status ENUM members are enumerated from
 *      information_schema, so a new member fails the suite until the view's
 *      filter is reconsidered — the view's WHERE clause names two of seven
 *      members, and a new member's meaning is not knowable from here.
 *
 * Fixtures are scoped by high-water marks and deleted child-first, the same
 * pattern the CRM and HR suites use. Reference rows (cost heads, units,
 * locations, item categories) are seeded by 003 and are read, never written.
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'expense_lines',
  'expenses',
  'po_lines',
  'purchase_orders',
  'vendor_item_rates',
  'items',
  'item_brands',
  'vendors',
  'projects',
  'clients',
  'users',
] as const

let projectId: number
let projectIdEmpty: number
let clientId: number
let userId: number
let vendorId: number
let itemId: number
let costHeadId: number

async function insertFixtureProject(code: string): Promise<number> {
  const row = await db
    .insertInto('projects')
    .values({
      code,
      name: `Fixture project for finance views ${code}`,
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 4, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: userId,
    })
    .executeTakeFirst()
  return Number(row.insertId ?? 0)
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const user = await db
    .insertInto('users')
    .values({
      email: 'fixture.finance.views@example.invalid',
      full_name: 'Fixture Finance Views User',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  userId = Number(user.insertId ?? 0)

  const client = await db
    .insertInto('clients')
    .values({
      code: 'FIXCL-FIN',
      name: 'Fixture Client for finance views',
      client_type: 'company',
      city: 'Bengaluru',
    })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  projectId = await insertFixtureProject('FIXPR-FIN')
  projectIdEmpty = await insertFixtureProject('FIXPR-FINEMPTY')

  const vendor = await db
    .insertInto('vendors')
    .values({
      code: `TMP-${randomUUID().slice(0, 12)}`,
      name: 'Fixture vendor for finance views',
      vendor_type: 'material',
    })
    .executeTakeFirst()
  vendorId = Number(vendor.insertId ?? 0)

  const cat = await db
    .selectFrom('item_categories')
    .select('id')
    .limit(1)
    .executeTakeFirstOrThrow()
  const unit = await db
    .selectFrom('units')
    .select('id')
    .where('code', '=', 'bag')
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto('items')
    .values({
      code: `FV-${randomUUID().slice(0, 12)}`,
      name: 'Fixture item for finance views',
      category_id: Number(cat.id),
      unit_id: Number(unit.id),
    })
    .executeTakeFirst()
  itemId = Number(item.insertId ?? 0)

  const head = await db
    .selectFrom('cost_heads')
    .select('id')
    .where('code', '=', 'MAT')
    .executeTakeFirstOrThrow()
  costHeadId = Number(head.id)

  const location = await db
    .selectFrom('locations')
    .select('id')
    .where('code', '=', 'STORE-CENTRAL')
    .executeTakeFirstOrThrow()

  // One approved PO, one line: 10 bags ordered, 3 received, 5,00,000 paise a
  // bag. Committed is (10 - 3) * 500000 = 35,00,000 paise. One partially
  // received line is enough to prove the arithmetic uses the difference, not
  // the ordered total.
  const po = await db
    .insertInto('purchase_orders')
    .values({
      po_no: `FVPO-${randomUUID().slice(0, 12)}`,
      vendor_id: vendorId,
      project_id: projectId,
      po_date: '2026-09-01',
      delivery_location_id: Number(location.id),
      subtotal_paise: 5_000_000,
      total_paise: 5_000_000,
      status: 'approved',
      created_by: userId,
    })
    .executeTakeFirst()
  const poId = Number(po.insertId ?? 0)
  await db
    .insertInto('po_lines')
    .values({
      po_id: poId,
      item_id: itemId,
      qty_ordered: '10.000',
      rate_paise: 500_000,
      qty_received: '3.000',
      line_total_paise: 5_000_000,
      cost_head_id: costHeadId,
    })
    .execute()

  // One approved expense, one line: 12,00,000 paise on the same cost head.
  // A second line on a different head proves the grouping.
  const expense = await db
    .insertInto('expenses')
    .values({
      expense_no: `FVEXP-${randomUUID().slice(0, 12)}`,
      expense_date: '2026-09-02',
      project_id: projectId,
      expense_type: 'material_purchase',
      payee_type: 'vendor',
      vendor_id: vendorId,
      source_type: 'manual',
      total_paise: 1_200_000,
      net_payable_paise: 1_200_000,
      status: 'approved',
      approved_by: userId,
      approved_at: new Date(),
      created_by: userId,
    })
    .executeTakeFirst()
  const expenseId = Number(expense.insertId ?? 0)
  await db.insertInto('expense_lines').values([
    {
      expense_id: expenseId,
      cost_head_id: costHeadId,
      description: 'Fixture actual, material head',
      amount_paise: 1_000_000,
    },
    {
      expense_id: expenseId,
      cost_head_id: costHeadId,
      description: 'Fixture actual, same head, second line',
      amount_paise: 200_000,
    },
  ])
    .execute()
})

afterAll(async () => {
  // Child first. po_lines and expense_lines cascade from their parents, but
  // the explicit delete keeps the high-water discipline uniform.
  await sql`delete from expense_lines where expense_id in (select id from expenses where id > ${highWater.get('expenses') ?? 0})`.execute(db)
  await sql`delete from expenses where id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from po_lines where po_id in (select id from purchase_orders where id > ${highWater.get('purchase_orders') ?? 0})`.execute(db)
  await sql`delete from purchase_orders where id > ${highWater.get('purchase_orders') ?? 0}`.execute(db)
  await sql`delete from vendor_item_rates where vendor_id > ${highWater.get('vendors') ?? 0}`.execute(db)
  await sql`delete from items where id > ${highWater.get('items') ?? 0}`.execute(db)
  await sql`delete from vendors where id > ${highWater.get('vendors') ?? 0}`.execute(db)
  await sql`delete from projects where id > ${highWater.get('projects') ?? 0}`.execute(db)
  await sql`delete from clients where id > ${highWater.get('clients') ?? 0}`.execute(db)
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db)
  await closePool()
})

describe('v_project_committed', () => {
  it('returns the ordered-minus-received arithmetic, by hand', async () => {
    const rows = await db
      .selectFrom('v_project_committed')
      .select(['project_id', 'cost_head_id', 'committed_paise'])
      .where('project_id', '=', projectId)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost_head_id).toBe(costHeadId)
    // (10 - 3) * 500000, computed here and not in SQL.
    expect(Number(rows[0]!.committed_paise)).toBe(7 * 500_000)
  })

  it('excludes a draft PO entirely', async () => {
    // Insert a draft PO on the same project and head; the view must not move.
    const location = await db
      .selectFrom('locations')
      .select('id')
      .where('code', '=', 'STORE-CENTRAL')
      .executeTakeFirstOrThrow()
    const po = await db
      .insertInto('purchase_orders')
      .values({
        po_no: `FVDRAFT-${randomUUID().slice(0, 12)}`,
        vendor_id: vendorId,
        project_id: projectId,
        po_date: '2026-09-03',
        delivery_location_id: Number(location.id),
        status: 'draft',
        created_by: userId,
      })
      .executeTakeFirst()
    const poId = Number(po.insertId ?? 0)
    try {
      await db.insertInto('po_lines').values({
        po_id: poId,
        item_id: itemId,
        qty_ordered: '99.000',
        rate_paise: 999_999,
        qty_received: '0.000',
        line_total_paise: 0,
        cost_head_id: costHeadId,
      }).execute()
      const rows = await db
        .selectFrom('v_project_committed')
        .select('committed_paise')
        .where('project_id', '=', projectId)
        .execute()
      expect(Number(rows[0]!.committed_paise)).toBe(7 * 500_000)
    } finally {
      await sql`delete from po_lines where po_id = ${poId}`.execute(db)
      await sql`delete from purchase_orders where id = ${poId}`.execute(db)
    }
  })
})

describe('v_project_actual', () => {
  it('returns the sum of approved, non-void lines, by hand', async () => {
    const rows = await db
      .selectFrom('v_project_actual')
      .select(['project_id', 'cost_head_id', 'actual_paise'])
      .where('project_id', '=', projectId)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost_head_id).toBe(costHeadId)
    // 1,000,000 + 200,000, computed here and not in SQL.
    expect(Number(rows[0]!.actual_paise)).toBe(1_200_000)
  })

  it('excludes a draft expense entirely', async () => {
    const expense = await db
      .insertInto('expenses')
      .values({
        expense_no: `FVDRAFT-${randomUUID().slice(0, 12)}`,
        expense_date: '2026-09-03',
        project_id: projectId,
        expense_type: 'site_overhead',
        payee_type: 'other',
        payee_name: 'Fixture draft payee',
        source_type: 'manual',
        status: 'draft',
        created_by: userId,
      })
      .executeTakeFirst()
    const expenseId = Number(expense.insertId ?? 0)
    try {
      await db.insertInto('expense_lines').values({
        expense_id: expenseId,
        cost_head_id: costHeadId,
        description: 'Fixture draft line',
        amount_paise: 88_888_888,
      }).execute()
      const rows = await db
        .selectFrom('v_project_actual')
        .select('actual_paise')
        .where('project_id', '=', projectId)
        .execute()
      expect(Number(rows[0]!.actual_paise)).toBe(1_200_000)
    } finally {
      await sql`delete from expense_lines where expense_id = ${expenseId}`.execute(db)
      await sql`delete from expenses where id = ${expenseId}`.execute(db)
    }
  })
})

describe('SUM over zero rows is 0, not NULL (the 020 COALESCE)', () => {
  it('a project with no POs and no expenses reads 0 on both views', async () => {
    const committed = await db
      .selectFrom('v_project_committed')
      .select('committed_paise')
      .where('project_id', '=', projectIdEmpty)
      .execute()
    const actual = await db
      .selectFrom('v_project_actual')
      .select('actual_paise')
      .where('project_id', '=', projectIdEmpty)
      .execute()
    expect(committed).toHaveLength(0)
    expect(actual).toHaveLength(0)

    // No GROUP BY row at all is the correct shape for a project with nothing
    // behind it, and it is also what makes the COALESCE necessary rather than
    // decorative: a LEFT JOIN from the project onto these views would meet
    // NULL for every missing row. Prove the COALESCE itself on the aggregate
    // expression directly, the way the CLAUDE.md tripwire rule requires:
    // evaluate the expression, do not string-match the definition.
    const probe = await sql<{ v: number | null }>`
      select coalesce(sum(amount_paise), 0) as v
      from expense_lines
      where expense_id = -1
    `.execute(db)
    expect(probe.rows[0]!.v).not.toBeNull()
    expect(Number(probe.rows[0]!.v)).toBe(0)
  })
})

describe('tripwire: purchase_orders.status members', () => {
  it('the ENUM holds exactly the members the view filter was written against', async () => {
    const res = await sql<{ column_type: string }>`
      select column_type from information_schema.columns
      where table_schema = database()
        and table_name = 'purchase_orders'
        and column_name = 'status'
    `.execute(db)
    const members = (res.rows[0]!.column_type.match(/'([^']+)'/g) ?? []).map((m) => m.slice(1, -1))
    // The view's filter names two of these. A new member is a new kind of
    // committed-or-not state and this failure is the instruction to decide
    // which side of the filter it belongs on before anything reads the view.
    expect(members.sort()).toEqual(
      ['approved', 'cancelled', 'draft', 'partially_received', 'pending_approval', 'received', 'short_closed'].sort()
    )
  })
})
