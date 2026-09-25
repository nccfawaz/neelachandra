import { sql } from 'kysely'
import { afterAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'

/*
 * The digital_marketing role, pinned (DECISIONS 35.1).
 *
 * Role permission sets drift by accretion: someone adds "just this one
 * permission, it's easier than a new role", and a year later the marketing
 * intern can approve expenses. This test pins the SET, both ways:
 *
 *   - the five marketing.* grants are present (a missing grant breaks the
 *     team's actual work), and
 *   - NOTHING ELSE is present -- explicitly asserting the money/HR/
 *     procurement/project-cost families are absent, so an accidental grant
 *     fails here before it fails an audit.
 */

const db = getDb()

const GRANTED = [
  'marketing.view',
  'marketing.analytics_view',
  'marketing.content_publish',
  'marketing.campaign_manage',
  'marketing.spend_record',
]

const FORBIDDEN_FAMILIES = ['finance', 'hr', 'procurement', 'inventory', 'admin', 'auth', 'projects', 'crm', 'sales'] as const

afterAll(async () => {
  await closePool()
})

describe('the digital_marketing role (35.1)', () => {
  it('exists as a system role, not 2FA-gated, not project-scoped', async () => {
    const role = await db
      .selectFrom('roles')
      .select(['id', 'require_2fa', 'scope_to_assigned_projects', 'is_system'])
      .where('key', '=', 'digital_marketing')
      .executeTakeFirst()
    expect(role, 'migration 034 must have created the role').toBeDefined()
    expect(Number(role!.require_2fa)).toBe(0)
    expect(Number(role!.scope_to_assigned_projects)).toBe(0)
    expect(Number(role!.is_system)).toBe(1)
  })

  it('holds EXACTLY the five marketing permissions', async () => {
    const rows = await sql<{ key: string }>`
      select p.\`key\` as \`key\` from role_permissions rp
      join roles r on r.id = rp.role_id
      join permissions p on p.id = rp.permission_id
      where r.\`key\` = 'digital_marketing'
      order by p.\`key\`
    `.execute(db)
    const keys = rows.rows.map((r) => r.key).sort()
    expect(keys).toEqual([...GRANTED].sort())
  })

  it('grants each expected permission individually (failure names the gap)', async () => {
    for (const key of GRANTED) {
      const hit = await sql<{ n: number }>`
        select count(*) as n from role_permissions rp
        join roles r on r.id = rp.role_id
        join permissions p on p.id = rp.permission_id
        where r.\`key\` = 'digital_marketing' and p.\`key\` = ${key}
      `.execute(db)
      expect(Number(hit.rows[0]?.n ?? 0), `${key} must be granted`).toBe(1)
    }
  })

  it('touches no money-approval, HR, procurement or project-cost permission', async () => {
    const rows = await sql<{ key: string; module: string }>`
      select p.\`key\` as \`key\`, p.module from role_permissions rp
      join roles r on r.id = rp.role_id
      join permissions p on p.id = rp.permission_id
      where r.\`key\` = 'digital_marketing'
    `.execute(db)
    const forbidden = rows.rows.filter((r) => (FORBIDDEN_FAMILIES as readonly string[]).includes(r.module))
    expect(forbidden, `forbidden grants found: ${forbidden.map((f) => f.key).join(', ')}`).toEqual([])
    // spend_record RECORDS spend; no permission in the set approves or pays it.
    const approvals = rows.rows.filter((r) => /approv|pay|write_off|invoice_|payment/.test(r.key))
    expect(approvals, `approval-shaped grants found: ${approvals.map((f) => f.key).join(', ')}`).toEqual([])
  })
})
