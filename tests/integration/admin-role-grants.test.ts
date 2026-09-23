import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'

/**
 * Pinned grants on the admin role (DECISIONS 29.73).
 *
 * 29.73: Fawaz (website administrator, admin role) is the production staff
 * administrator but held hr.employee_view only — he could read an employee
 * record and not correct its code, the exact operation the employees panel
 * of the edit screen gates on hr.employee_manage (29.71). Migration 028
 * grants it; seed-staff.mjs re-applies it idempotently on re-seed. This
 * suite pins the grant so nothing can silently drop it.
 *
 * The empty-green rule applies: assert the grant exists (>=1 row), so a
 * broken query cannot pass by finding nothing.
 */

afterAll(async () => {
  await closePool()
})

describe('admin role pinned grants (29.73)', () => {
  it('admin holds hr.employee_manage (migration 028 / seed-staff top-up)', async () => {
    const db = getDb()
    const rows = await sql`
      SELECT p.\`key\` AS k
        FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        JOIN permissions p ON p.id = rp.permission_id
       WHERE r.\`key\` = 'admin' AND p.\`key\` = 'hr.employee_manage'`.execute(db)
    const list = (rows as { rows?: { k: string }[] }).rows ?? (rows as unknown as { k: string }[])
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list[0].k).toBe('hr.employee_manage')
  })
})
