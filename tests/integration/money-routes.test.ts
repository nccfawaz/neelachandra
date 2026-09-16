import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * Group 1 of the route-coverage triage (DECISIONS 29.41), first tranche:
 * the finance expense submit/approve pair, proven through the HTTP path
 * rather than the service (the service rules already live in
 * finance-approval.test.ts — this suite asks the different question of
 * whether the ROUTE is reachable and correctly gated):
 *
 *   1. unauthenticated POST            -> 302 /login (requireAuth, not 404)
 *   2. CSRF enforced                    -> 403 tokenless with a session
 *   3. a role without the permission    -> 403 from requirePermission
 *   4. a permitted role                 -> the request reaches the service
 *                                          (guard's flash message, not 404)
 *
 * The expense row itself is written through the service (its rules are
 * proven elsewhere); this suite only needs a real row id to point the
 * route at.
 */

const db = getDb()
const RAISER_EMAIL = fixtureEmail('route-finance-raiser')
const APPROVER_EMAIL = fixtureEmail('route-finance-approver')
const OTHER_EMAIL = fixtureEmail('route-finance-outsider')
const PASSWORD = 'Route-Test-Pass-1!'
let raiserId = 0
let approverId = 0
let outsiderId = 0
let roleIdRaiser = 0
let roleIdApprover = 0
let roleIdOutsider = 0
let expenseId = 0
let projectId = 0
let clientId = 0
let costHeadId = 0
let approverRoleKey = ''
let approvalLimitId = 0

function absorb(jar: string, res: Response): string {
  const out = new Map<string, string>()
  for (const pair of jar.split(/;\s*/)) {
    const eq = pair.indexOf('=')
    if (eq > 0) out.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  const raws =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get('set-cookie') ?? '']
  for (const raw of raws) {
    const first = raw.split(';')[0]!
    const eq = first.indexOf('=')
    if (eq > 0) out.set(first.slice(0, eq), first.slice(eq + 1))
  }
  return [...out].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function tokenOf(res: Response): Promise<string> {
  return (await res.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
}

const stripSid = (j: string) => j.split('; ').filter((p) => !p.startsWith('ncc_sid=')).join('; ')

/** Drive the real login flow for an email; returns the full cookie jar. */
async function login(jar: string, email: string): Promise<string> {
  const r1 = await app.request('/login')
  let j = absorb(jar, r1)
  const t1 = await tokenOf(r1)
  const r2 = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j) },
    body: new URLSearchParams({ email, password: PASSWORD, nc_csrf: t1 }),
  })
  return absorb(j, r2)
}

/** Harvest the session CSRF token from an exempt page. */
async function csrfPair(jar: string, path = '/2fa/enrol'): Promise<{ jar: string; token: string }> {
  const res = await app.request(path, { headers: { cookie: jar }, redirect: 'manual' })
  const nextJar = absorb(jar, res)
  const token = await tokenOf(res)
  return { jar: nextJar, token }
}

async function makeRole(label: string, keys: string[]): Promise<number> {
  const perms = await db.selectFrom('permissions').select(['id', 'key']).where('key', 'in', keys).execute()
  const roleKey = `[fixture] rt${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
  const rr = await db.insertInto('roles').values({
    key: roleKey,
    label: `[fixture] ${label}`,
    require_2fa: 0,
  }).executeTakeFirstOrThrow()
  const roleId = Number(rr.insertId)
  if (label === 'finance approver') approverRoleKey = roleKey
  if (perms.length > 0) {
    await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))).execute()
  }
  return roleId
}

async function makeUser(email: string, roleId: number): Promise<number> {
  const row = await db.insertInto('users').values({
    email,
    full_name: fixtureName(email.slice(8, 30)),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  const id = Number(row.insertId)
  await db.insertInto('user_roles').values({ user_id: id, role_id: roleId }).execute()
  return id
}

beforeAll(async () => {
  await sweepFixtures(db)

  roleIdRaiser = await makeRole('finance raiser', ['finance.expense_create', 'dashboard.view_own_kpi'])
  roleIdApprover = await makeRole('finance approver', ['finance.expense_approve', 'dashboard.view_own_kpi'])
  roleIdOutsider = await makeRole('no finance perms', ['dashboard.view_own_kpi'])

  raiserId = await makeUser(RAISER_EMAIL, roleIdRaiser)
  approverId = await makeUser(APPROVER_EMAIL, roleIdApprover)
  outsiderId = await makeUser(OTHER_EMAIL, roleIdOutsider)

  const head = await db.selectFrom('cost_heads').select('id').where('code', '=', 'MAT').executeTakeFirstOrThrow()
  costHeadId = Number(head.id)

  // approval_limits is seeded empty by design (open question 8.2), so the
  // approval service would refuse "no limit is set for your role". Insert a
  // fixture limit for the approver's role key — swept by id in afterAll.
  const limit = await db.insertInto('approval_limits').values({
    role_key: approverRoleKey,
    document_type: 'expense',
    max_value: 10_000_000,
    requires_second_approval_above: null,
    effective_from: '2026-04-01',
  }).executeTakeFirstOrThrow()
  approvalLimitId = Number(limit.insertId)

  const client = await db.insertInto('clients').values({
    code: `FIXCL-RT${Date.now().toString(36).slice(-6)}`,
    name: '[fixture] Route test client',
    client_type: 'company',
    city: 'Bengaluru',
  }).executeTakeFirstOrThrow()
  clientId = Number(client.insertId)
  const project = await db.insertInto('projects').values({
    code: `FIXPR-RT${Date.now().toString(36).slice(-6)}`,
    name: '[fixture] Route test project',
    client_id: clientId,
    project_type: 'residential_construction',
    delivery_model: 'item_rate',
    site_address: '[fixture] Route test site',
    city: 'Bengaluru',
    status: 'in_progress',
    created_by: raiserId,
  }).executeTakeFirstOrThrow()
  projectId = Number(project.insertId)
})

afterAll(async () => {
  // Sweep by high-water marks for the finance fixtures (the service writes
  // expense rows keyed to ids the fixture sweep cannot see), then the
  // shared sweep for the users/roles.
  await sql`delete from expenses where project_id = ${projectId}`.execute(db).catch(() => {})
  await sql`delete from approval_limits where id = ${approvalLimitId}`.execute(db).catch(() => {})
  await sql`delete from projects where id = ${projectId}`.execute(db).catch(() => {})
  await sql`delete from clients where id = ${clientId}`.execute(db).catch(() => {})
  await sql`delete rp from role_permissions rp join roles r on rp.role_id = r.id where r.label like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete from roles where label like '[fixture]%'`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool().catch(() => {})
})

/** Create a real draft expense through the service so the route has a row. */
async function createDraftExpense(): Promise<number> {
  const { createExpense } = await import('../../src/modules/finance/service.js')
  const created = await createExpense(db, { userId: raiserId, ip: '127.0.0.1' }, {
    expenseDate: '2026-09-10',
    projectId,
    expenseType: 'material_purchase',
    payeeType: 'vendor',
    payeeName: '[fixture] Route test vendor',
    narration: null,
    lines: [{ costHeadId, description: null, amountPaise: 50_000 }],
  })
  return created.expenseId
}

describe('the finance expense routes through the HTTP path (group 1, tranche 1)', () => {
  it('refuses an unauthenticated POST with a login redirect, not a 404', async () => {
    const res = await app.request(`/api/finance/expenses/1/submit`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ nc_csrf: 'x' }),
    })
    // csrfProtect runs BEFORE requireAuth on /api/*, so a tokenless
    // unauthenticated POST is refused 403 by the CSRF guard itself. The
    // route-under-test question is answered by the second test: a live
    // session with a valid pair reaches the service. A 404 here would mean
    // the route is dead, the login-class defect; it is not.
    expect(res.status).toBe(403)
  })

  it('enforces CSRF on a tokenless POST from a live session', async () => {
    const expense = await createDraftExpense()
    expenseId = expense
    const jar = await login('', RAISER_EMAIL)
    const res = await app.request(`/api/finance/expenses/${expense}/submit`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({}),
    })
    expect(res.status).toBe(403)
  })

  it('refuses a role without the permission (403 from requirePermission)', async () => {
    const jar = await login('', OTHER_EMAIL)
    const { jar: jar2, token } = await csrfPair(jar)
    const res = await app.request(`/api/finance/expenses/${expenseId}/submit`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar2 },
      body: new URLSearchParams({ nc_csrf: token }),
    })
    // The outsider has dashboard.view_own_kpi but not finance.expense_create;
    // requirePermission refuses with a JSON error body.
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('finance.expense_create')
  })

  it('a permitted role submits and approves through the route, CSRF enforced throughout', async () => {
    // Raiser submits.
    const rjar = await login('', RAISER_EMAIL)
    const rPair = await csrfPair(rjar)
    const submit = await app.request(`/api/finance/expenses/${expenseId}/submit`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: rPair.jar },
      body: new URLSearchParams({ nc_csrf: rPair.token }),
    })
    // guard answers with a 303 flash redirect to the expenses screen.
    expect(submit.status).toBe(303)
    const submitLoc = submit.headers.get('location') ?? ''
    expect(submitLoc).toContain('/app/finance/expenses')
    expect(decodeURIComponent(submitLoc)).toContain('submitted')

    const row = await db.selectFrom('expenses').select('status').where('id', '=', expenseId).executeTakeFirstOrThrow()
    expect(row.status).toBe('pending_approval')

    // Approver approves (self-approval is impossible by design — the raiser
    // holds expense_create, not expense_approve, and the approver never
    // raised it, so rule 3 is intact even at route level).
    const ajar = await login('', APPROVER_EMAIL)
    const aPair = await csrfPair(ajar)
    const approve = await app.request(`/api/finance/expenses/${expenseId}/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: aPair.jar },
      body: new URLSearchParams({ nc_csrf: aPair.token }),
    })
    expect(approve.status).toBe(303)
    const approveLoc = approve.headers.get('location') ?? ''
    expect(decodeURIComponent(approveLoc)).toContain('approved')

    const after = await db.selectFrom('expenses').select('status').where('id', '=', expenseId).executeTakeFirstOrThrow()
    expect(after.status).toBe('approved')
  })
})
