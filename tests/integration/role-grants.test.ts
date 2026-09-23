import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'

/**
 * Pinned grants for the four roles added in migration 029 (DECISIONS 29.74).
 *
 * Each role's exact permission set is asserted: a grant added later or
 * dropped silently fails this test. The empty-green rule applies — every
 * assertion demands >=1 row and the exact expected set, so a broken query
 * cannot pass by finding nothing.
 */

const EXPECTED: Record<string, string[]> = {
  site_engineer: [
    'dashboard.view_own_kpi',
    'projects.view',
    'projects.update_progress',
    'projects.dpr_submit',
    'inventory.view',
    'inventory.grn_create',
    'inventory.issue',
    'hr.attendance_record',
  ],
  qa_qc: [
    'dashboard.view_own_kpi',
    'projects.view',
    'projects.quality_signoff',
    'projects.snag_manage',
    'inventory.view',
    'hr.attendance_record',
  ],
  architect: [
    'dashboard.view_own_kpi',
    'projects.view',
    'inventory.view',
    'hr.attendance_record',
  ],
  procurement_executive: [
    'dashboard.view_own_kpi',
    'inventory.view',
    'inventory.po_create',
    'inventory.grn_create',
    'inventory.view_rates',
  ],
}

afterAll(async () => {
  await closePool()
})

describe('pinned grants for the 029 roles (29.74)', () => {
  for (const [roleKey, expected] of Object.entries(EXPECTED)) {
    it(`${roleKey} holds exactly its ${expected.length} pinned permissions`, async () => {
      const db = getDb()
      const result = await sql
        .raw(
          `SELECT p.\`key\` AS k FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE r.\`key\` = '${roleKey}' ORDER BY p.\`key\``
        )
        .execute(db)
      const rows = (result as { rows?: { k: string }[] }).rows ?? (result as unknown as { k: string }[])
      const held = rows.map((r) => r.k).sort()
      expect(held).toEqual([...expected].sort())
    })
  }

  it('the four roles hold no money-approval permission', async () => {
    const db = getDb()
    const result = await sql.raw(
      `SELECT p.\`key\` AS k FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE r.\`key\` IN ('site_engineer','qa_qc','architect','procurement_executive')
         AND (p.\`key\` LIKE 'finance.%' OR p.\`key\` IN ('inventory.approve_po','hr.leave_approve','hr.attendance_approve','crm.quote_approve','projects.milestone_certify'))`
    ).execute(db)
    const rows = (result as { rows?: { k: string }[] }).rows ?? (result as unknown as { k: string }[])
    expect(rows.map((r) => r.k)).toEqual([])
  })

  it('the three missing designation rows exist (029)', async () => {
    const db = getDb()
    const result = await sql.raw(
      `SELECT code FROM designations WHERE code IN ('QA-QC-QS','ARCHITECT','PROC-EXEC') ORDER BY code`
    ).execute(db)
    const rows = (result as { rows?: { code: string }[] }).rows ?? (result as unknown as { code: string }[])
    expect(rows.map((r) => r.code)).toEqual(['ARCHITECT', 'PROC-EXEC', 'QA-QC-QS'])
  })
})
