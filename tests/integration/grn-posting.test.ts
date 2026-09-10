import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { sweepFixtures } from './fixture-markers.js'
import { closePool, getPool } from '../../src/db/pool.js'
import { postStockMovement } from '../../src/modules/inventory/service.js'
import { createGrn, postGrn } from '../../src/modules/inventory/service.js'
import { grnSchema } from '../../src/modules/inventory/schemas.js'
import { WRITER_MAPPING } from './expense-writer-mapping.js'

/**
 * The GRN expense posting (§6.8 rule 1, "Posting a GRN creates an expenses
 * row with source_type = 'grn'").
 *
 * §6.4 calls the GRN post irreversible; §6.8 rule 1 says the same post
 * writes the expenses row. Before this suite the post wrote the ledger and
 * flipped the PO but left the finance identity behind — the same
 * designed-not-written shape 29.8 closed for contractor bills. Proven here,
 * through postGrn (never a direct insert):
 *
 *   1. The expense row exists with all four identity values
 *      (source_type/source_table/source_id plus the expense_no), and the
 *      GRN's expense_id back-link is set.
 *   2. The amount's single source is the received lines: accepted × rate,
 *      summed in the service — no form input can move it.
 *   3. A second post of the same GRN is refused by postGrn's status guard;
 *      at the database, uq_exp_source refuses the mapped pair again.
 *   4. The 021 period trigger fires on the posting: a GRN received inside a
 *      closed period cannot be posted, and the whole post rolls back (no
 *      ledger row, no PO update, no half-post).
 *
 * Fixtures use the marked shapes from fixture-markers; the GRN path needs
 * its own vendor, item, location and project rows, all swept child-first.
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'expenses',
  'stock_ledger',
  'grn_lines',
  'goods_receipts',
  'item_brands',
  'items',
  'vendors',
  'accounting_periods',
  'projects',
  'clients',
  'audit_log',
  'users',
] as const

let userId = 0
let projectId = 0
let clientId = 0
let vendorId = 0
let locationId = 0
let itemId = 0
let unitId = 0

const GRN_DATE = '2026-09-01'

function grnInput(over: Record<string, unknown> = {}) {
  // Parsed exactly as the route parses it: raw lists through grnSchema, so
  // the transformed `lines` the service expects come out the other side.
  return grnSchema.parse({
    poId: undefined,
    vendorId,
    locationId,
    projectId: String(projectId),
    receivedOn: GRN_DATE,
    vehicleNo: undefined,
    invoiceNo: `FIX-INV-${randomUUID().slice(0, 6)}`,
    invoiceDate: GRN_DATE,
    invoiceAmount: undefined,
    weighbridgeSlipNo: undefined,
    gateEntryNo: undefined,
    inspectedBy: undefined,
    poLineId: [''],
    itemId: [String(itemId)],
    brand: [''],
    qtyChallan: ['100'],
    qtyReceived: ['100'],
    qtyAccepted: ['100'],
    rejectionReason: [''],
    batchNo: [''],
    manufactureDate: [''],
    expiryDate: [''],
    rate: ['50.00'],
    ...over,
  })
}

beforeAll(async () => {
  await sweepFixtures(db)
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const user = await db
    .insertInto('users')
    .values({
      email: `fixture.grn.poster.${randomUUID().slice(0, 8)}@example.invalid`,
      full_name: '[fixture] GRN Poster',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  userId = Number(user.insertId ?? 0)

  const client = await db
    .insertInto('clients')
    .values({
      code: `FIXCL-GRN${randomUUID().slice(0, 6)}`,
      name: 'Fixture Client for GRN posting',
      client_type: 'company',
      city: 'Bengaluru',
    })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  const project = await db
    .insertInto('projects')
    .values({
      code: `FIXPR-GRN${randomUUID().slice(0, 6)}`,
      name: 'Fixture project for GRN posting',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 9, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)

  const vendor = await db
    .insertInto('vendors')
    .values({
      code: `FIXVN-GRN${randomUUID().slice(0, 6)}`,
      name: 'Fixture Vendor for GRN posting',
      vendor_type: 'material',
      city: 'Bengaluru',
      status: 'active',
      created_by: userId,
    })
    .executeTakeFirst()
  vendorId = Number(vendor.insertId ?? 0)

  // 003 seeds the two non-project stores; take one rather than inventing one.
  const loc = await db.selectFrom('locations').select('id').orderBy('id').limit(1).executeTakeFirstOrThrow()
  locationId = Number(loc.id)

  // 003 seeds units; the cement bag unit is among them. Take it by code.
  const unit = await db.selectFrom('units').select('id').where('code', '=', 'bag').executeTakeFirstOrThrow()
  unitId = Number(unit.id)

  // items.category_id is NOT NULL; 003 seeds the categories, take cement.
  const cat = await db.selectFrom('item_categories').select('id').where('code', '=', 'CEMENT').executeTakeFirstOrThrow()

  const item = await db
    .insertInto('items')
    .values({
      code: `FIXIT-GRN${randomUUID().slice(0, 6)}`,
      name: 'Fixture item for GRN posting',
      unit_id: unitId,
      category_id: Number(cat.id),
      created_by: userId,
    })
    .executeTakeFirst()
  itemId = Number(item.insertId ?? 0)
})

afterAll(async () => {
  // Child first; stock_ledger rows reference the GRN and the item.
  await sql`delete from stock_ledger where id > ${highWater.get('stock_ledger') ?? 0}`.execute(db)
  // item_stock keys on item_id, not id.
  await sql`delete from item_stock where item_id > ${highWater.get('items') ?? 0}`.execute(db)
  // The GRN row holds the expense back-link: drop it before expenses.
  await sql`update goods_receipts set expense_id = null where id > ${highWater.get('goods_receipts') ?? 0}`.execute(db)
  await sql`delete from expenses where id > ${highWater.get('expenses') ?? 0}`.execute(db)
  await sql`delete from grn_lines where id > ${highWater.get('grn_lines') ?? 0}`.execute(db)
  await sql`delete from goods_receipts where id > ${highWater.get('goods_receipts') ?? 0}`.execute(db)
  await sql`delete from item_brands where item_id > ${highWater.get('items') ?? 0}`.execute(db)
  // item_stock keys on item_id; package_spec_lines reference seeded items and
  // are never touched by fixtures, so items delete cleanly by high-water.
  await sql`delete from items where id > ${highWater.get('items') ?? 0}`.execute(db)
  await sql`delete from vendors where id > ${highWater.get('vendors') ?? 0}`.execute(db)
  await sql`delete from accounting_periods where id > ${highWater.get('accounting_periods') ?? 0}`.execute(db)
  await sql`delete from projects where id > ${highWater.get('projects') ?? 0}`.execute(db)
  await sql`delete from clients where id > ${highWater.get('clients') ?? 0}`.execute(db)
  await sql`delete from audit_log where id > ${highWater.get('audit_log') ?? 0}`.execute(db)
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db)
  await closePool()
})

describe('the GRN posting writes the expense row (§6.8 rule 1)', () => {
  it('posting creates the expense with all four identity values and back-links the GRN', async () => {
    const grn = await createGrn(db, { userId, ip: '127.0.0.1' }, grnInput())
    const result = await postGrn(db, { userId, ip: '127.0.0.1' }, grn.grnId, true)

    expect(result.grnNo).toBe(grn.grnNo)
    expect(result.ledgerIds.length).toBe(1)

    const posted = await db
      .selectFrom('expenses')
      .select([
        'id', 'expense_no', 'source_type', 'source_table', 'source_id',
        'total_paise', 'expense_type', 'payee_type', 'vendor_id',
        'expense_date', 'status', 'approved_by', 'project_id',
      ])
      .where('source_table', '=', 'goods_receipts')
      .where('source_id', '=', grn.grnId)
      .executeTakeFirstOrThrow()

    // All four identity values.
    expect(posted.source_type).toBe('grn')
    expect(posted.source_table).toBe('goods_receipts')
    // Writer-side mapping assertion (DECISIONS 29.19): the pair this writer
    // actually wrote must be expressible in the shared mapping table.
    const mapped = WRITER_MAPPING[posted.source_type]
    expect(mapped, `postGrn wrote source_type '${posted.source_type}' which the shared mapping does not record`).toBeDefined()
    expect(posted.source_table, `postGrn wrote source_table '${posted.source_table}' but the mapping records '${mapped!.sourceTable}'`).toBe(mapped!.sourceTable)
    expect(Number(posted.source_id)).toBe(grn.grnId)
    expect(posted.expense_no).toMatch(/^NCC\/EXP\//)

    // The amount's single source: 100 accepted × 5,000 paise = 5,00,000.
    expect(Number(posted.total_paise)).toBe(500_000)
    expect(posted.expense_type).toBe('material_purchase')
    expect(posted.payee_type).toBe('vendor')
    expect(Number(posted.vendor_id)).toBe(vendorId)
    expect(String(posted.expense_date)).toBe(GRN_DATE)
    expect(posted.status).toBe('approved')
    expect(Number(posted.approved_by)).toBe(userId)
    expect(Number(posted.project_id)).toBe(projectId)

    // The GRN's expense_id back-link is set.
    const grnRow = await db
      .selectFrom('goods_receipts')
      .select(['status', 'expense_id'])
      .where('id', '=', grn.grnId)
      .executeTakeFirstOrThrow()
    expect(grnRow.status).toBe('posted')
    expect(Number(grnRow.expense_id)).toBe(Number(posted.id))
  })

  it('a second post of the same GRN is refused, and the mapped pair is unique at the database', async () => {
    const grn = await createGrn(db, { userId, ip: '127.0.0.1' }, grnInput())
    await postGrn(db, { userId, ip: '127.0.0.1' }, grn.grnId, true)

    // The service refuses the second post on status.
    await expect(postGrn(db, { userId, ip: '127.0.0.1' }, grn.grnId, true)).rejects.toThrow(
      /already posted/
    )

    // The database refuses the mapped pair again — uq_exp_source, not code.
    let err: (Error & { code?: string; errno?: number }) | undefined
    try {
      await db
        .insertInto('expenses')
        .values({
          expense_no: `FIXEXP/GRNDUP-${randomUUID().slice(0, 8)}`,
          expense_date: GRN_DATE,
          expense_type: 'material_purchase',
          payee_type: 'vendor',
          vendor_id: vendorId,
          source_type: 'grn',
          source_table: 'goods_receipts',
          source_id: grn.grnId,
          total_paise: 1,
          created_by: userId,
        })
        .execute()
    } catch (caught) {
      err = caught as Error & { code?: string; errno?: number }
    }
    expect(err?.code).toBe('ER_DUP_ENTRY')
    expect(err?.errno).toBe(1062)
    expect(err?.message).toMatch(/uq_exp_source/)
  })

  it('the 021 trigger fires on the posting: a GRN received inside a closed period cannot post, and the post rolls back whole', async () => {
    // A closed period containing the GRN's date. GRN_DATE is 2026-09-01,
    // inside the seeded September 2026-27 period — but that one is open, so
    // build a fixture period around the date and close it.
    const closed = await db
      .insertInto('accounting_periods')
      .values({
        financial_year: 'TF-GRN',
        month: 1,
        period_start: '2026-08-31',
        period_end: '2026-09-30',
        status: 'closed',
      })
      .executeTakeFirst()
    const closedId = Number(closed.insertId ?? 0)

    try {
      const grn = await createGrn(db, { userId, ip: '127.0.0.1' }, grnInput())

      let message = ''
      let refused = false
      try {
        await postGrn(db, { userId, ip: '127.0.0.1' }, grn.grnId, true)
      } catch (caught) {
        refused = true
        message = caught instanceof Error ? caught.message : String(caught)
      }
      expect(refused, 'the post went through despite the closed period — the lock did not see the posting').toBe(true)
      expect(message).toContain('closed accounting period')

      // The whole post rolled back: the GRN is still a draft, no ledger row
      // was written, and no expense row exists for it.
      const grnRow = await db
        .selectFrom('goods_receipts')
        .select(['status', 'expense_id'])
        .where('id', '=', grn.grnId)
        .executeTakeFirstOrThrow()
      expect(grnRow.status).toBe('draft')
      expect(grnRow.expense_id).toBeNull()

      const ledger = await db
        .selectFrom('stock_ledger')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('ref_table', '=', 'goods_receipts')
        .where('ref_id', '=', grn.grnId)
        .executeTakeFirstOrThrow()
      expect(Number(ledger.n)).toBe(0)
    } finally {
      await sql`delete from accounting_periods where id = ${closedId}`.execute(db)
    }
  })
})
