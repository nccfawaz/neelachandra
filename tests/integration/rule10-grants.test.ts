import { afterAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'

/**
 * Rule 10 grants, pinned live (§6.8 rule 10, DECISIONS 29.12).
 *
 * The dashboard gates company money on finance.view_company_pnl, and the
 * projects module gates contract value on projects.view_cost. Both gates are
 * only as correct as the grant rows behind them, so the grants are read from
 * the live role_permissions join (not from the 002 seed text) and compared
 * to the expected role sets with non-zero floors.
 *
 * A new grant of either permission fails here until the visibility decision
 * is recorded — the same tripwire shape as the source_type ENUM check:
 * enumerate from the database, refuse drift, force the reconsideration.
 */

const db = getDb()

afterAll(async () => {
  await closePool()
})

async function rolesHolding(permissionKey: string): Promise<string[]> {
  const rows = await db
    .selectFrom('role_permissions')
    .innerJoin('permissions', 'permissions.id', 'role_permissions.permission_id')
    .innerJoin('roles', 'roles.id', 'role_permissions.role_id')
    .select('roles.key as roleKey')
    .where('permissions.key', '=', permissionKey)
    .orderBy('roles.key')
    .execute()
  return rows.map((r) => r.roleKey)
}

describe('rule 10: the grant rows behind the visibility gates', () => {
  it('finance.view_company_pnl is held by exactly owner and accounts_manager', async () => {
    const roles = await rolesHolding('finance.view_company_pnl')
    expect(roles.length).toBeGreaterThan(0) // non-zero floor
    expect(roles).toEqual(['accounts_manager', 'owner'])
  })

  it('projects.view_cost is held by exactly the four cost-seeing roles', async () => {
    const roles = await rolesHolding('projects.view_cost')
    expect(roles.length).toBeGreaterThan(0) // non-zero floor
    expect(roles).toEqual(['accounts_manager', 'ops_manager', 'owner', 'project_manager'])
  })

  it('site_supervisor holds neither — the spec names them explicitly', async () => {
    const pnl = await rolesHolding('finance.view_company_pnl')
    const cost = await rolesHolding('projects.view_cost')
    expect(pnl).not.toContain('site_supervisor')
    expect(cost).not.toContain('site_supervisor')
  })
})
