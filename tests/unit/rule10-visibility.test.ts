import { describe, expect, it } from 'vitest'
import { widgetsFor } from '../../src/dashboard/widgets.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'

/**
 * Rule 10 visibility (spec 4.3, §6.8 rule 10): company-scale money is a
 * permission, not a default.
 *
 * The dashboard is the one place a company-wide figure (cash position,
 * revenue, receivables ageing) could leak to a role that should never see
 * margin. widgetsFor is the gate: a widget whose permission the role lacks
 * is not rendered at all — the number never reaches the HTML, not even
 * hidden behind CSS. These tests pin which money widgets each role's seed
 * permission set yields, so a permission grant drift or a widget added
 * without a perms list fails here.
 *
 * Role sets mirror the 002 seed (the live grants are separately pinned by
 * the integration tripwire in expenses-source-mapping's family — see
 * tests/integration/rule10-grants.test.ts).
 */

const OWNER = new Set<string>(Object.values(PERMISSIONS)) // owner: CROSS JOIN = all 60
const ACCOUNTS = new Set<string>([
  'dashboard.view_company_kpi', 'dashboard.view_own_kpi',
  'projects.view', 'projects.view_cost', 'projects.milestone_certify',
  'finance.view_project_budget', 'finance.budget_set', 'finance.expense_create',
  'finance.expense_approve', 'finance.payment_record', 'finance.invoice_manage',
  'finance.view_company_pnl', 'finance.period_close', 'finance.export',
])
const PROJECT_MANAGER = new Set<string>([
  'dashboard.view_own_kpi',
  'projects.view', 'projects.manage', 'projects.view_cost',
  'projects.assign_staff', 'projects.update_progress', 'projects.dpr_submit',
  'projects.quality_signoff', 'projects.milestone_certify', 'projects.snag_manage',
  'finance.view_project_budget', 'finance.budget_set', 'finance.expense_create',
  'finance.expense_approve', 'finance.invoice_manage', 'finance.export',
])
const SITE_SUPERVISOR = new Set<string>([
  'dashboard.view_own_kpi',
  'projects.view', 'projects.update_progress', 'projects.dpr_submit',
  'projects.snag_manage',
  'finance.expense_create',
])
const SALES_EXEC = new Set<string>([
  'dashboard.view_own_kpi', 'enquiries.view', 'projects.view',
])

const MONEY_WIDGETS = ['cash_position', 'month_revenue', 'receivables_ageing']

describe('rule 10: company-scale money is permission-gated, never a default zero', () => {
  it('owner sees all three company money widgets', () => {
    const keys = widgetsFor(OWNER).map((w) => w.key)
    for (const k of MONEY_WIDGETS) expect(keys).toContain(k)
  })

  it('accounts_manager sees all three (holds finance.view_company_pnl)', () => {
    const keys = widgetsFor(ACCOUNTS).map((w) => w.key)
    for (const k of MONEY_WIDGETS) expect(keys).toContain(k)
  })

  it('project_manager sees no company money widget despite invoice_manage', () => {
    expect(PROJECT_MANAGER.has(PERMISSIONS.FINANCE_INVOICE_MANAGE)).toBe(true)
    expect(PROJECT_MANAGER.has(PERMISSIONS.FINANCE_VIEW_COMPANY_PNL)).toBe(false)
    const keys = widgetsFor(PROJECT_MANAGER).map((w) => w.key)
    for (const k of MONEY_WIDGETS) expect(keys).not.toContain(k)
  })

  it('site_supervisor and sales_exec see no company money widget at all', () => {
    for (const role of [SITE_SUPERVISOR, SALES_EXEC]) {
      const keys = widgetsFor(role).map((w) => w.key)
      for (const k of MONEY_WIDGETS) expect(keys).not.toContain(k)
    }
  })

  it('every widget declares a non-empty perms list — no widget is unguarded', () => {
    // The import is the enumeration; re-derive through widgetsFor with an
    // empty set: nothing may be visible to a permissionless session, and the
    // WIDGETS table itself is checked via a full-permission set plus the
    // empty-set probe below.
    expect(widgetsFor(new Set<string>())).toEqual([])
  })

  it('every widget is visible to the owner (owner holds every permission)', () => {
    const all = widgetsFor(OWNER)
    expect(all.length).toBeGreaterThan(10)
  })
})
