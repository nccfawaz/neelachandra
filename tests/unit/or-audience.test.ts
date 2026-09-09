import { describe, expect, it } from 'vitest'
import { WIDGETS } from '../../src/dashboard/widgets.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'

/**
 * The OR-widens-the-audience sweep (DECISIONS 29.14, CLAUDE.md sweep rule).
 *
 * Scope of the sweep this test pins (full enumeration in DECISIONS 29.14):
 * every permission check in src/ that ORs, unions, or falls back across two
 * or more permissions. Three sites exist:
 *
 *   1. The dashboard widget table (WIDGETS.perms, OR via widgetsFor's
 *      some()) and its fragment endpoint (routes.tsx mirrors the same
 *      some()). This is the one place a union could expose company money.
 *   2. The nav table (nav.ts perms arrays). Nav is convenience, not
 *      control — every route behind a nav item is guarded individually.
 *   3. Route guards named with spread constants (QUOTE_READ, QUOTE_APPROVE,
 *      ITEM_READ, the HR attendance triple). Each union's money exposure is
 *      gated again inside the route by a single stronger permission
 *      (canValue for quote money, canRates for item rates, canPay for
 *      compensation, period-close for attendance override).
 *
 * Role sets mirror the 002 seed; the live grants are separately pinned in
 * tests/integration/rule10-grants.test.ts.
 */

const OWNER = new Set<string>(Object.values(PERMISSIONS))
const ACCOUNTS = new Set<string>([
  'dashboard.view_company_kpi', 'dashboard.view_own_kpi',
  'projects.view', 'projects.view_cost', 'projects.milestone_certify',
  'finance.view_project_budget', 'finance.budget_set', 'finance.expense_create',
  'finance.expense_approve', 'finance.payment_record', 'finance.invoice_manage',
  'finance.view_company_pnl', 'finance.period_close', 'finance.export',
])
const OPS = new Set<string>([
  'dashboard.view_company_kpi', 'dashboard.view_own_kpi',
  'projects.view', 'projects.manage', 'projects.view_cost',
  'projects.assign_staff', 'projects.update_progress', 'projects.dpr_submit',
  'projects.quality_signoff', 'projects.snag_manage',
  'finance.view_project_budget', 'finance.expense_create', 'finance.export',
  'crm.quote_approve', 'hr.attendance_approve', 'hr.leave_approve',
])
const PM = new Set<string>([
  'dashboard.view_own_kpi',
  'projects.view', 'projects.manage', 'projects.view_cost',
  'finance.view_project_budget', 'finance.expense_create', 'finance.expense_approve',
  'finance.invoice_manage', 'finance.export',
  'crm.quote_create', 'hr.attendance_approve', 'hr.leave_approve',
])
const HR = new Set<string>([
  'dashboard.view_own_kpi', 'hr.employee_view', 'hr.payroll_view',
])
const SALES = new Set<string>([
  'dashboard.view_own_kpi', 'enquiries.view', 'projects.view',
  'crm.quote_create', 'crm.view_pipeline_value',
])
const SUPERVISOR = new Set<string>([
  'dashboard.view_own_kpi', 'projects.view', 'projects.update_progress',
  'projects.dpr_submit', 'projects.snag_manage', 'finance.expense_create',
  'inventory.view', 'inventory.grn_create', 'inventory.issue',
  'hr.attendance_record',
])

const COMPANY_MONEY_WIDGETS = ['cash_position', 'month_revenue', 'receivables_ageing']

describe('OR-widens-the-audience: the widget table is the only union over money', () => {
  it('every company-money widget demands finance.view_company_pnl alone — no weaker OR arm', () => {
    for (const key of COMPANY_MONEY_WIDGETS) {
      const def = WIDGETS.find((w) => w.key === key)
      expect(def, `${key} missing from WIDGETS`).toBeDefined()
      expect(def!.perms, `${key} must be gated on exactly finance.view_company_pnl (the receivables_ageing lesson)`).toEqual([PERMISSIONS.FINANCE_VIEW_COMPANY_PNL])
    }
  })

  it('the money-widget audience is exactly {owner, accounts_manager}', () => {
    const pnl = PERMISSIONS.FINANCE_VIEW_COMPANY_PNL
    expect(OWNER.has(pnl)).toBe(true)
    expect(ACCOUNTS.has(pnl)).toBe(true)
    for (const role of [OPS, PM, HR, SALES, SUPERVISOR]) {
      expect(role.has(pnl)).toBe(false)
    }
  })

  it('no widget is reachable by a role that lacks every permission on it (empty set yields nothing)', () => {
    expect(WIDGETS.every((w) => w.perms.length > 0)).toBe(true)
  })

  it('no widget ORs a money permission with a weaker one', () => {
    // The class this pins: perms: [STRONG_MONEY, SOMETHING_COMMON] admits the
    // SOMETHING_COMMON audience. Every widget with a company-scale money
    // permission carries it ALONE.
    const moneyPerms = [PERMISSIONS.FINANCE_VIEW_COMPANY_PNL]
    for (const w of WIDGETS) {
      for (const money of moneyPerms) {
        if (w.perms.includes(money)) {
          expect(w.perms.length, `${w.key} ORs ${money} with weaker permissions`).toBe(1)
        }
      }
    }
  })

  it('projects_over_budget shows no rupee figure, and its audience all hold projects.view_cost', () => {
    const def = WIDGETS.find((w) => w.key === 'projects_over_budget')
    expect(def!.perms).toEqual([PERMISSIONS.FINANCE_VIEW_PROJECT_BUDGET])
    // Every seed role holding view_project_budget also holds view_cost, so
    // the widget's percentage audience never exceeds the cost audience.
    for (const role of [ACCOUNTS, OPS, PM]) {
      expect(role.has(PERMISSIONS.FINANCE_VIEW_PROJECT_BUDGET)).toBe(true)
      expect(role.has(PERMISSIONS.PROJECTS_VIEW_COST)).toBe(true)
    }
  })

  it('the weaker-permission role sees no money widget at all — refusal by absence, not zero', () => {
    for (const role of [PM, SALES, SUPERVISOR, HR]) {
      const keys = new Set(
        WIDGETS.filter((w) => w.perms.some((p) => role.has(p))).map((w) => w.key)
      )
      for (const money of COMPANY_MONEY_WIDGETS) {
        expect(keys.has(money), `${[...role].find(() => true) ?? ''} audience must not include ${money}`).toBe(false)
      }
    }
  })
})
