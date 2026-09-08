import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'

/**
 * The place_of_supply column (migration 022, DECISIONS 27.4).
 *
 * Three shapes, proven by direct insert per the CLAUDE.md rule that a
 * nullable-or-defaulted column inside a constraint is proven against the
 * live server, not by reading the DDL:
 *
 *   1. Omitting the column is refused — NOT NULL with no default, so the
 *      insert must state the place of supply; it cannot inherit one.
 *   2. An invalid code is refused — chk_inv_pos_shape accepts exactly two
 *      upper-case letters.
 *   3. 'KA' is admitted.
 *
 * The refusal to give the column a DEFAULT 'KA' is recorded in 27.4 with the
 * migration-016 reasoning: a sentinel default keeps the sentinel reachable
 * where it would mean something — here, "intra-state" decided by omission
 * for a client who may be registered anywhere.
 */

const db = getDb()

const highWater = new Map<string, number>()
const TRACKED = [
  'client_invoices',
  'projects',
  'clients',
  'users',
] as const

let projectId: number
let clientId: number
let userId: number

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const user = await db
    .insertInto('users')
    .values({
      email: `fixture.pos.${randomUUID().slice(0, 8)}@example.invalid`,
      full_name: 'Fixture Place Of Supply User',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  userId = Number(user.insertId ?? 0)

  const client = await db
    .insertInto('clients')
    .values({
      code: `FIXCL-POS${randomUUID().slice(0, 6)}`,
      name: 'Fixture Client for place of supply',
      client_type: 'company',
      city: 'Bengaluru',
    })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  const project = await db
    .insertInto('projects')
    .values({
      code: `FIXPR-POS${randomUUID().slice(0, 6)}`,
      name: 'Fixture project for place of supply',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 7, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)
})

afterAll(async () => {
  await sql`delete from client_invoices where id > ${highWater.get('client_invoices') ?? 0}`.execute(db)
  await sql`delete from projects where id > ${highWater.get('projects') ?? 0}`.execute(db)
  await sql`delete from clients where id > ${highWater.get('clients') ?? 0}`.execute(db)
  await sql`delete from users where id > ${highWater.get('users') ?? 0}`.execute(db)
  await closePool()
})

function invoiceValues() {
  return {
    invoice_no: `PLPOS-${randomUUID().slice(0, 8)}`,
    project_id: projectId,
    client_id: clientId,
    invoice_date: '2099-01-15',
    due_date: '2099-01-31',
    created_by: userId,
  }
}

describe('place_of_supply (migration 022)', () => {
  it('refuses an insert that omits the column', async () => {
    let refused = false
    try {
      // The column is omitted entirely from the insert list.
      const { place_of_supply: _omit, ...withoutPos } = invoiceValues() as Record<string, unknown>
      await db.insertInto('client_invoices').values(withoutPos as typeof invoiceValues extends Record<string, infer T> ? never : never).execute()
    } catch (err) {
      refused = true
      expect(String((err as Error).message)).toContain("Field 'place_of_supply' doesn't have a default value")
    }
    if (!refused) throw new Error('expected the omitting insert to be refused')
  })

  it('refuses an invalid code (lowercase, three letters, digits)', async () => {
    // 'ka' proves the CHECK is case-sensitive — the first draft of 022 used a
    // plain REGEXP, which follows the column's case-insensitive collation and
    // admitted it. 'KAR' fails on CHAR(2)'s length before the CHECK can fire,
    // so either refusal message proves that shape is closed. 'KA ' is NOT in
    // the list: CHAR strips trailing spaces on storage, so it stores as 'KA',
    // which is standard CHAR semantics rather than a hole.
    for (const bad of ['ka', 'KAR', 'K1', 'k1']) {
      let refused = false
      try {
        await db.insertInto('client_invoices').values({ ...invoiceValues(), place_of_supply: bad }).execute()
      } catch (err) {
        refused = true
        const message = String((err as Error).message)
        expect(message.includes('chk_inv_pos_shape') || message.includes("Data too long for column 'place_of_supply'")).toBe(true)
      }
      if (!refused) throw new Error(`expected '${bad}' to be refused`)
    }
  })

  it("admits 'KA' and reads it back", async () => {
    const row = await db
      .insertInto('client_invoices')
      .values({ ...invoiceValues(), place_of_supply: 'KA' })
      .executeTakeFirst()
    const id = Number(row.insertId ?? 0)
    const stored = await db
      .selectFrom('client_invoices')
      .select('place_of_supply')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(stored.place_of_supply).toBe('KA')
  })
})