import { describe, expect, it } from 'vitest'
import app from '../../src/app.js'

/**
 * The route-coverage tripwire (DECISIONS 29.35).
 *
 * The lesson that caused this gate: no test posted to /login, the login
 * CSRF deadlock (29.32) sat there for three sessions, and nothing noticed —
 * because coverage was judged by "what do the tests mention", a
 * hand-maintained mirror of the router that drifts the moment a route
 * lands. This gate enumerates from the app's OWN router (Hono's
 * app.routes), so a new route appears here the moment it is mounted, and
 * fails while that route has no test reference.
 *
 * Shape: every concrete route (method + path, excluding the ALL middleware
 * entries and pure asset routes) must appear in either EXERCISED (paths a
 * test drives or references as a route) or the ALLOWLIST below. The
 * allowlist is the coverage debt: it only shrinks. A route removed from
 * the codebase must be removed from the list; a route added must be added
 * here (visible failure) or exercised by a test.
 */

/** Build the mounted-route list from the router itself. */
function mountedRoutes(): string[] {
  const seen = new Set<string>()
  function walk(routes: any[]): void {
    for (const r of routes) {
      if (Array.isArray(r.handlers)) {
        walk(r.handlers)
      } else if (r.method && r.method !== 'ALL' && r.path) {
        // Normalise Hono's internal concat: '//' from empty sub-prefixes.
        const full = r.path.replace(/\/\//g, '/')
        seen.add(`${r.method.toUpperCase()} ${full}`)
      }
    }
  }
  walk(app.routes)
  return [...seen]
}

/**
 * Routes a test exercises or meaningfully references: driven through
 * app.request / a live server, or asserted against by name (nav, redirect
 * maps, print routes exercised through their services). Grep-visible
 * references count: the point is that a NEW route fails here until a test
 * names it.
 */
const EXERCISED = [
  'GET /login', // csrf-pre-session.test.ts
  'POST /login', // csrf-pre-session.test.ts + the live-server proofs
  'GET /forgot-password', // csrf-pre-session.test.ts path-set bounds
  'POST /forgot-password',
  'GET /reset-password/:token',
  'POST /reset-password/:token',
  'POST /logout',
  'GET /2fa/verify',
  'POST /2fa/verify',
  'GET /2fa/enrol',
  'POST /2fa/enrol',
  'POST /api/csp-report', // csp-report + csp-hardening suites
  'GET /app', // nav.test.ts active-state logic
  'GET /app/hr/leave', // nav.test.ts
  'GET /app/inventory', // nav.test.ts
  'GET /app/inventory/vendors', // nav.test.ts
  'GET /app/inventory/vendors/:vendorId', // nav.test.ts (vendors/12)
  'GET /app/projects', // nav.test.ts
  'GET /app/projects/snags', // nav.test.ts
  'GET /app/notifications', // nav.test.ts
  'GET /about-us', // legacy-redirects.test.ts target
  'GET /404', // legacy-redirects clean-path assertion
  'GET /assets/*', // public asset catch-all, exercised by e2e renders
]

/**
 * THE COVERAGE DEBT. Every entry is a mounted route with no test. Sorted,
 * deduplicated, and only ever shrinking.
 */
const ALLOWLIST: string[] = [
  'GET /.well-known/security.txt',
  'GET /097ee841c58a4b25b8eb2c348ca67dce.txt',
  'GET /400',
  'GET /401',
  'GET /403',
  'GET /405',
  'GET /408',
  'GET /410',
  'GET /429',
  'GET /500',
  'GET /502',
  'GET /503',
  'GET /504',
  'GET /apple-touch-icon.png',
  'GET /favicon-96x96.png',
  'GET /favicon.ico',
  'GET /favicon.svg',
  'GET /google9706eb5d9d6a7b15.html',
  'GET /humans.txt',
  'GET /llms-full.txt',
  'GET /llms.txt',
  'GET /og.webp',
  'GET /robots.txt',
  'GET /site.webmanifest',
  'GET /sitemap.xml',
  'GET /api/crm/quotes/:id/print',
  'GET /api/dashboard/widget/:key',
  'GET /api/po/:poId/print',
  'GET /api/projects/:projectId/tab/:tab',
  'GET /app/account/password',
  'GET /app/account/sessions',
  'GET /app/admin/approval-limits',
  'GET /app/admin/audit',
  'GET /app/admin/enquiries',
  'GET /app/admin/reference',
  'GET /app/admin/roles',
  'GET /app/admin/roles/:id',
  'GET /app/admin/settings',
  'GET /app/admin/users',
  'GET /app/admin/users/:id',
  'GET /app/crm',
  'GET /app/crm/leads',
  'GET /app/crm/leads/:id',
  'GET /app/crm/leads/:id/edit',
  'GET /app/crm/leads/new',
  'GET /app/crm/quotes',
  'GET /app/crm/quotes/:id',
  'GET /app/crm/quotes/:id/revise',
  'GET /app/crm/quotes/new',
  'GET /app/crm/reports/funnel',
  'GET /app/crm/reports/losses',
  'GET /app/crm/reports/sources',
  'GET /app/crm/visits',
  'GET /app/crm/visits/:id',
  'GET /app/finance/budgets',
  'GET /app/finance/expenses',
  'GET /app/finance/invoices',
  'GET /app/finance/payments',
  'GET /app/finance/periods',
  'GET /app/hr',
  'GET /app/hr/attendance',
  'GET /app/hr/contractor-attendance',
  'GET /app/hr/contractor-bills',
  'GET /app/hr/contractor-bills/:billId',
  'GET /app/hr/contractors',
  'GET /app/hr/contractors/:contractorId',
  'GET /app/hr/contractors/:contractorId/edit',
  'GET /app/hr/contractors/new',
  'GET /app/hr/employees',
  'GET /app/hr/employees/:employeeId',
  'GET /app/hr/employees/:employeeId/edit',
  'GET /app/hr/employees/new',
  'GET /app/hr/recruiting',
  'GET /app/hr/reports/muster',
  'GET /app/inventory/adjustments',
  'GET /app/inventory/adjustments/:adjustmentId',
  'GET /app/inventory/adjustments/new',
  'GET /app/inventory/adjustments/opening',
  'GET /app/inventory/equipment',
  'GET /app/inventory/equipment/:equipmentId',
  'GET /app/inventory/grn',
  'GET /app/inventory/grn/:grnId',
  'GET /app/inventory/grn/new',
  'GET /app/inventory/issues',
  'GET /app/inventory/issues/:issueId',
  'GET /app/inventory/issues/new',
  'GET /app/inventory/items',
  'GET /app/inventory/items/:itemId',
  'GET /app/inventory/items/:itemId/edit',
  'GET /app/inventory/items/:itemId/ledger',
  'GET /app/inventory/items/new',
  'GET /app/inventory/po',
  'GET /app/inventory/po/:poId',
  'GET /app/inventory/po/new',
  'GET /app/inventory/reports/consumption',
  'GET /app/inventory/requisitions',
  'GET /app/inventory/requisitions/:reqId',
  'GET /app/inventory/requisitions/new',
  'GET /app/inventory/transfers',
  'GET /app/inventory/transfers/:transferId',
  'GET /app/inventory/transfers/new',
  'GET /app/inventory/vendors/:vendorId/edit',
  'GET /app/inventory/vendors/new',
  'GET /app/marketing',
  'GET /app/marketing/campaigns',
  'GET /app/marketing/content',
  'GET /app/notifications',
  'GET /app/projects/:projectId',
  'GET /app/projects/:projectId/dpr/new',
  'GET /app/projects/dprs',
  'GET /app/projects/new',
  'GET /best-construction-company-in-bengaluru',
  'GET /best-construction-company-in-bengaluru-projects',
  'GET /construction-company-in-tumkur',
  'GET /construction-packages-in-bengaluru',
  'GET /construction-services-in-bengaluru',
  'GET /contact-us',
  'GET /privacy-policy',
  'GET /terms',
  'PATCH /api/crm/leads/:id/assign',
  'PATCH /api/crm/leads/:id/stage',
  'POST /2fa/enrol',
  'POST /2fa/verify',
  'POST /api/crm/leads/:id/activities',
  'POST /api/crm/leads/:id/assign',
  'POST /api/crm/leads/:id/convert',
  'POST /api/crm/leads/:id/lose',
  'POST /api/crm/leads/:id/probability',
  'POST /api/crm/leads/:id/site-visits',
  'POST /api/crm/leads/:id/stage',
  'POST /api/crm/leads/from-enquiry/:enquiryId',
  'POST /api/crm/quotes/:id/accept',
  'POST /api/crm/quotes/:id/approve',
  'POST /api/crm/quotes/:id/reject',
  'POST /api/crm/quotes/:id/revise',
  'POST /api/crm/quotes/:id/send',
  'POST /api/crm/quotes/:id/submit',
  'POST /api/po/:poId/short-close',
  'POST /api/po/:poId/submit',
  'POST /api/requisitions/:reqId/approve',
  'POST /api/requisitions/:reqId/reject',
  'POST /api/transfers/:transferId/receive',
  'POST /app/account/password',
  'POST /app/account/sessions/revoke',
  'POST /app/admin/enquiries/:id/status',
  'POST /app/admin/overrides/:id/remove',
  'POST /app/admin/roles/:id',
  'POST /app/admin/settings',
  'POST /app/admin/users',
  'POST /app/admin/users/:id/overrides',
  'POST /app/admin/users/:id/roles',
  'POST /app/admin/users/:id/status',
  'POST /app/crm/leads',
  'POST /app/crm/leads/:id/edit',
  'POST /app/crm/quotes',
  'POST /app/finance/advances',
  'POST /app/finance/expenses',
  'POST /app/finance/invoices',
  'POST /app/finance/payments',
  'POST /app/hr/contractors',
  'POST /app/hr/contractors/:contractorId',
  'POST /app/hr/employees',
  'POST /app/hr/employees/:employeeId',
  'POST /app/hr/leave',
  'POST /app/inventory/adjustments',
  'POST /app/inventory/adjustments/opening',
  'POST /app/inventory/brands/:brandId/approval',
  'POST /app/inventory/grn',
  'POST /app/inventory/issues',
  'POST /app/inventory/items',
  'POST /app/inventory/items/:itemId',
  'POST /app/inventory/items/:itemId/brands',
  'POST /app/inventory/po',
  'POST /app/inventory/requisitions',
  'POST /app/inventory/requisitions/:reqId/submit',
  'POST /app/inventory/transfers',
  'POST /app/inventory/vendors',
  'POST /app/inventory/vendors/:vendorId',
  'POST /app/inventory/vendors/:vendorId/rates',
  'POST /app/inventory/vendors/:vendorId/rating',
  'POST /app/inventory/vendors/:vendorId/status',
  'POST /app/notifications/read-all',
  'POST /app/projects',
  'POST /app/projects/:projectId/approvals',
  'POST /app/projects/:projectId/dpr',
  'POST /app/projects/:projectId/dprs/:dprId/review',
  'POST /app/projects/:projectId/milestones/:msId/certify',
  'POST /app/projects/:projectId/quality-checks',
  'POST /app/projects/:projectId/quality-checks/:checkId/signoff',
  'POST /app/projects/:projectId/snags',
  'POST /app/projects/:projectId/snags/:snagId/status',
  'POST /app/projects/:projectId/stages/:stageId/progress',
  'POST /app/projects/:projectId/status',
  'POST /app/projects/:projectId/team',
  'POST /best-construction-company-in-bengaluru',
  'POST /contact-us',
  'POST /internal/cron/budget-alerts',
  'POST /internal/cron/crm-followups',
  'POST /internal/cron/document-expiry',
  'POST /internal/cron/housekeeping',
  'POST /internal/cron/stock-alerts',
  'POST /api/crm/site-visits/:id/complete',
  'POST /api/crm/site-visits/:id/status',
  'POST /api/equipment/:equipmentId/deploy',
  'POST /api/equipment/:equipmentId/return',
  'POST /api/finance/expenses/:expenseId/approve',
  'POST /api/finance/expenses/:expenseId/submit',
  'POST /api/finance/payments/:paymentId/allocate',
  'POST /api/finance/periods/:periodId/close',
  'POST /api/grn/:grnId/post',
  'POST /api/hr/attendance/approve',
  'POST /api/hr/attendance/bulk',
  'POST /api/hr/attendance/grid',
  'POST /api/hr/contractor-attendance',
  'POST /api/hr/contractor-attendance/approve',
  'POST /api/hr/contractor-bills/:billId/approve',
  'POST /api/hr/contractor-bills/generate',
  'POST /api/hr/contractors/:contractorId/rates',
  'POST /api/hr/employees/:employeeId/compensation',
  'POST /api/hr/employees/:employeeId/documents',
  'POST /api/hr/employees/:employeeId/exit',
  'POST /api/hr/leave/:id/approve',
  'POST /api/hr/leave/:id/withdraw',
  'POST /api/issues/:issueId/return',
  'POST /api/notifications/:id/read',
  'POST /api/po/:poId/approve',
  'PUT /api/crm/site-visits/:id/complete',
]

/** Router routes that are not concrete endpoints: middleware entries and the empty root. */
const NOT_ROUTES = [/^ALL /, /^(GET|POST) \/?$/]

describe('the route-coverage tripwire (DECISIONS 29.35)', () => {
  it('enumerates a non-empty route set from the app router itself', () => {
    const mounted = mountedRoutes()
    expect(mounted.length, 'the router enumeration is empty — a Hono internals change broke the walk').toBeGreaterThan(0)
  })

  it('accounts for every concrete route as exercised or explicitly allowlisted', () => {
    const mounted = mountedRoutes()
      .filter((r) => !NOT_ROUTES.some((re) => re.test(r)))
    const covered = new Set([...EXERCISED, ...ALLOWLIST])

    const uncovered = mounted.filter((r) => !covered.has(r))
    expect(
      uncovered,
      'routes mounted with no test coverage — add a test or extend the allowlist consciously'
    ).toEqual([])

    // The mirror must not rot in the other direction either: an allowlist
    // entry for a route the router no longer has is a stale entry.
    const mountedSet = new Set(mounted)
    const stale = [...EXERCISED, ...ALLOWLIST].filter((r) => !mountedSet.has(r))
    expect(stale, 'allowlist/exercised entries for routes that no longer exist').toEqual([])
  })

  it('the allowlist only ever shrinks: it holds exactly the recorded debt', () => {
    // counted by the test file itself. When coverage improves, lower this
    // number in the same commit that removes the entries. It must never
    // rise.
    expect(ALLOWLIST.length).toBe(227)
  })
})
