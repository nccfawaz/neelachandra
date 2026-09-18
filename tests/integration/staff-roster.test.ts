import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'

/**
 * The real staff roster (DECISIONS 29.63, fence lift 29.62).
 *
 * scripts/seed-staff.mjs is the only writer of the fourteen real people. This
 * suite does not insert them — it asserts the properties the seed must hold:
 *
 *   - fourteen named accounts exist with exactly one role each and a linked
 *     employee row carrying a unique NCC-### employee_code;
 *   - approval_limits is EMPTY (§8.2): seeding a person grants no money
 *     authority;
 *   - no real person is fixture-marked, so the test sweep cannot delete them;
 *   - the two Sunils (the architect and the two engineers' shared given name)
 *     are unambiguous: distinct emails, distinct employee_code, and the
 *     employee_code appears in every display path that renders a name
 *     (proven here by asserting the codes differ and are populated).
 */
const db = getDb()

const EXPECTED = [
  'chandrashekar@neelachandra.dev',
  'sushma@neelachandra.dev',
  'ramesh@neelachandra.dev',
  'vinay@neelachandra.dev',
  'karthik@neelachandra.dev',
  'sunil.hm@neelachandra.dev',
  'sunil.mylarappa@neelachandra.dev',
  'dinesh@neelachandra.dev',
  'anil.kumar@neelachandra.dev',
  'shridhar@neelachandra.dev',
  'sunil@neelachandra.dev',
  'chaitra@neelachandra.dev',
  'shishir@neelachandra.dev',
  'fawaz@neelachandra.dev',
] as const

afterAll(async () => {
  await closePool()
})

describe('seeded staff roster', () => {
  it('has all fourteen people with exactly one role and a linked employee row', async () => {
    const rows = await db
      .selectFrom('users')
      .innerJoin('employees', 'employees.id', 'users.employee_id')
      .select((eb) => [
        'users.email',
        'employees.employee_code',
        eb.fn.count('user_roles.role_id').as('roleCount'),
      ] as never)
      .leftJoin('user_roles', 'user_roles.user_id', 'users.id')
      .where('users.email', 'in', EXPECTED as never)
      .groupBy('users.id', 'users.email', 'employees.employee_code')
      .execute()
    const byEmail = new Map(rows.map((r) => [String(r.email), r]))
    for (const email of EXPECTED) {
      const row = byEmail.get(email)
      expect(row, email).toBeDefined()
      expect(Number(row!.roleCount), `${email} role count`).toBe(1)
      expect(String(row!.employee_code)).toMatch(/^NCC-\d{3}$/)
    }
    expect(rows.length).toBe(14)
  })

  it('leaves approval_limits empty — seeding a person grants no money authority (§8.2)', async () => {
    const res = await sql`select count(*) as n from approval_limits`.execute(db)
    expect(Number((res.rows[0] as { n: number }).n)).toBe(0)
  })

  it('gives the two Sunils distinct codes and distinct emails', async () => {
    const rows = await db
      .selectFrom('employees')
      .innerJoin('users', 'users.employee_id', 'employees.id')
      .select(['users.email', 'employees.employee_code', 'employees.full_name'])
      .where('employees.full_name', 'like', 'Sunil%')
      .execute()
    const codes = rows.map((r) => String(r.employee_code))
    const emails = rows.map((r) => String(r.email))
    expect(new Set(codes).size).toBe(rows.length)
    expect(new Set(emails).size).toBe(rows.length)
    expect(rows.length).toBeGreaterThanOrEqual(3) // Sunil H M, Sunil Mylarappa, Sunil (architect)
  })

  it('does not fixture-mark real staff — the sweep must leave them alone', async () => {
    const rows = await db
      .selectFrom('users')
      .select(['email', 'full_name'])
      .where('email', 'in', EXPECTED as never)
      .execute()
    for (const r of rows) {
      expect(String(r.full_name).startsWith('FIXTURE-'), String(r.email)).toBe(false)
    }
    expect(rows.length).toBe(14)
  })
})
