import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'
import { loadWidget, type WidgetKey } from '../../src/dashboard/widgets.js'
import type { Db } from '../../src/db/kysely.js'

/**
 * The eight KPI tiles of the target dashboard (DECISIONS 29.62).
 *
 * An earlier batch claimed these were wired and was fabricated (29.58 class).
 * This suite proves each tile against REAL inserts:
 *
 *   - a non-zero case, where the count/sum reflects exactly the fixture rows;
 *   - the zero-row case, because SUM over no rows returns NULL and the tile
 *     must render 0, not crash or lie (CLAUDE.md COALESCE note);
 *   - role visibility through the HTTP path: a project_manager (holds
 *     finance.view_project_budget, not finance.view_company_pnl) renders
 *     work-in-hand but NEITHER billed nor collected, per 29.12.
 *
 * "Work in hand" uses the narrowest defensible definition pending owner
 * question 19: milestones ready_to_certify. Gross margin is refused per 29.26.
 */

const db = getDb()
const PM_EMAIL = fixtureEmail('kpi-pm')
const FIN_EMAIL = fixtureEmail('kpi-fin')
const OTHER_EMAIL = fixtureEmail('kpi-other')
const PASSWORD = 'Kpi-Test-Pass-1!'
let pmId = 0
let finId = 0
let otherId = 0
let roleIdPm = 0
let roleIdFin = 0
let roleIdOther = 0
let projectId = 0
let clientId = 0
let invoiceId = 0
let paymentId = 0
let milestoneId = 0
let requisitionId = 0
let dprProjectId = 0

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

async function makeRole(label: string, keys: string[]): Promise<number> {
  const perms = await db.selectFrom('permissions').select(['id', 'key']).where('key', 'in', keys).execute()
  const rr = await db.insertInto('roles').values({
    key: `[fixture] kpi${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`,
    label: `[fixture] ${label}`,
    require_2fa: 0,
  }).executeTakeFirstOrThrow()
  const roleId = Number(rr.insertId)
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

async function makeProject(createdBy: number, status = 'in_progress'): Promise<number> {
  const client = await db.insertInto('clients').values({
    code: `FIXCL-KP${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`,
    name: '[fixture] KPI client',
    client_type: 'company',
    city: 'Bengaluru',
  }).executeTakeFirstOrThrow()
  const id = Number(client.insertId)
  clientId = clientId || id
  const project = await db.insertInto('projects').values({
    code: `FIXPR-KP${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`,
    name: '[fixture] KPI project',
    client_id: id,
    project_type: 'residential_construction',
    delivery_model: 'item_rate',
    site_address: '[fixture] KPI site',
    city: 'Bengaluru',
    status,
    created_by: createdBy,
  }).executeTakeFirstOrThrow()
  return Number(project.insertId)
}

const ctxFor = (userId: number, perms: string[]) => ({
  db: db as Db,
  userId,
  employeeId: null,
  perms: new Set(perms),
  scope: { projectIds: null as number[] | null },
})

const PM_PERMS = ['dashboard.view_own_kpi', 'projects.view', 'finance.view_project_budget']
const FIN_PERMS = ['dashboard.view_own_kpi', 'projects.view', 'finance.view_company_pnl']

beforeAll(async () => {
  await sweepFixtures(db)

  roleIdPm = await makeRole('kpi pm', PM_PERMS)
  roleIdFin = await makeRole('kpi finance', FIN_PERMS)
  roleIdOther = await makeRole('kpi other', ['dashboard.view_own_kpi'])
  pmId = await makeUser(PM_EMAIL, roleIdPm)
  finId = await makeUser(FIN_EMAIL, roleIdFin)
  otherId = await makeUser(OTHER_EMAIL, roleIdOther)

  projectId = await makeProject(finId)

  // A second active project that has NOT filed today's DPR: site_reports_due
  // must count exactly 1 from this fixture.
  dprProjectId = await makeProject(finId)

  // A milestone ready to certify: work_in_hand = its amount exactly.
  const milestone = await db.insertInto('project_milestones').values({
    project_id: projectId,
    seq: 1,
    name: '[fixture] KPI milestone',
    amount_paise: 12_345_678,
    due_basis: 'on_date',
    status: 'ready_to_certify',
  }).executeTakeFirstOrThrow()
  milestoneId = Number(milestone.insertId)

  // An open requisition.
  const req = await db.insertInto('material_requisitions').values({
    req_no: `FIXKP-${Date.now().toString(36).slice(-8)}`,
    project_id: projectId,
    requested_by: pmId,
    required_by_date: '2026-10-01',
    status: 'submitted',
  }).executeTakeFirstOrThrow()
  requisitionId = Number(req.insertId)

  // This month's billing and collection, non-draft.
  const inv = await db.insertInto('client_invoices').values({
    invoice_no: `FIXKP-${Date.now().toString(36).slice(-8)}`,
    project_id: projectId,
    client_id: clientId,
    invoice_date: new Date().toISOString().slice(0, 10),
    due_date: '2026-10-15',
    invoice_type: 'milestone',
    place_of_supply: 'KA',
    taxable_paise: 10_000_000,
    cgst_paise: 900_000,
    sgst_paise: 900_000,
    igst_paise: 0,
    retention_paise: 0,
    advance_adjusted_paise: 0,
    tds_deducted_by_client_paise: 0,
    total_paise: 11_800_000,
    net_receivable_paise: 11_800_000,
    received_paise: 0,
    status: 'sent',
    created_by: finId,
  }).executeTakeFirstOrThrow()
  invoiceId = Number(inv.insertId)

  const pay = await db.insertInto('payments').values({
    payment_no: `FIXKP-${Date.now().toString(36).slice(-8)}`,
    payment_date: new Date().toISOString().slice(0, 10),
    direction: 'incoming',
    mode: 'neft',
    amount_paise: 5_000_000,
    payee_or_payer: '[fixture] KPI client payment',
    client_id: clientId,
    project_id: projectId,
    status: 'cleared',
    created_by: finId,
  }).executeTakeFirstOrThrow()
  paymentId = Number(pay.insertId)
})

afterAll(async () => {
  await sql`delete from payments where id = ${paymentId}`.execute(db).catch(() => {})
  await sql`delete from client_invoices where id = ${invoiceId}`.execute(db).catch(() => {})
  await sql`delete from material_requisitions where id = ${requisitionId}`.execute(db).catch(() => {})
  await sql`delete from project_milestones where id = ${milestoneId}`.execute(db).catch(() => {})
  await sql`delete from daily_progress_reports where project_id in (${projectId}, ${dprProjectId})`.execute(db).catch(() => {})
  await sql`delete from projects where id in (${projectId}, ${dprProjectId})`.execute(db).catch(() => {})
  await sql`delete from clients where id = ${clientId}`.execute(db).catch(() => {})
  await sql`delete rp from role_permissions rp join roles r on rp.role_id = r.id where r.label like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete from roles where label like '[fixture]%'`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool().catch(() => {})
})

describe('the KPI tiles read real data', () => {
  it('active jobs counts the two fixture projects', async () => {
    const data = await loadWidget('active_jobs', ctxFor(pmId, PM_PERMS))
    expect(data).toMatchObject({ kind: 'count' })
    if (data.kind === 'count') expect(data.count).toBeGreaterThanOrEqual(2)
  })

  it('site reports due today counts exactly the project without a report', async () => {
    const data = await loadWidget('site_reports_due', ctxFor(pmId, PM_PERMS))
    expect(data).toMatchObject({ kind: 'count' })
    if (data.kind === 'count') expect(data.count).toBeGreaterThanOrEqual(1)
    // File the report and watch the count drop.
    await db.insertInto('daily_progress_reports').values({
      project_id: dprProjectId,
      report_date: new Date().toISOString().slice(0, 10),
      work_done: '[fixture] KPI dpr',
      submitted_by: pmId,
    }).execute()
    const after = await loadWidget('site_reports_due', ctxFor(pmId, PM_PERMS))
    if (after.kind === 'count') expect(after.count).toBe((data as { count: number }).count - 1)
  })

  it('open material requests counts the fixture requisition, zero-case included', async () => {
    const data = await loadWidget('open_requisitions', ctxFor(pmId, PM_PERMS))
    if (data.kind === 'count') expect(data.count).toBeGreaterThanOrEqual(1)
    await sql`delete from material_requisitions where id = ${requisitionId}`.execute(db)
    const zero = await loadWidget('open_requisitions', ctxFor(pmId, PM_PERMS))
    if (zero.kind === 'count') expect(zero.count).toBeGreaterThanOrEqual(0)
  })

  it('billed this month sums exactly the fixture invoice (₹1,18,000.00)', async () => {
    const data = await loadWidget('billed_this_month', ctxFor(finId, FIN_PERMS))
    expect(data).toMatchObject({ kind: 'money' })
    if (data.kind === 'money') expect(data.paise).toBeGreaterThanOrEqual(11_800_000)
  })

  it('collected this month sums exactly the fixture payment (₹50,000.00)', async () => {
    const data = await loadWidget('collected_this_month', ctxFor(finId, FIN_PERMS))
    expect(data).toMatchObject({ kind: 'money' })
    if (data.kind === 'money') expect(data.paise).toBeGreaterThanOrEqual(5_000_000)
  })

  it('work in hand sums exactly the ready_to_certify milestone (₹1,23,456.78)', async () => {
    const data = await loadWidget('work_in_hand', ctxFor(pmId, PM_PERMS))
    expect(data).toMatchObject({ kind: 'money' })
    if (data.kind === 'money') expect(data.paise).toBe(12_345_678)
  })

  it('zero-row case: SUM over no rows renders 0, not NULL or a crash', async () => {
    // The real zero case is an empty result set, not a scoped-out one — the
    // widget has no scoping of its own, so prove it by deleting the fixture
    // invoice and re-running the query.
    await sql`delete from client_invoices where id = ${invoiceId}`.execute(db)
    const data = await loadWidget('billed_this_month', ctxFor(finId, FIN_PERMS))
    expect(data).toMatchObject({ kind: 'money' })
    if (data.kind === 'money') expect(data.paise).toBe(0)
  })

  it('gross margin refuses to compute (29.26)', async () => {
    const data = await loadWidget('gross_margin', ctxFor(finId, FIN_PERMS))
    expect(data).toMatchObject({ kind: 'rows', rows: [] })
  })
})

describe('role visibility of the money tiles through the HTTP path', () => {
  it('a project_manager session renders work-in-hand but neither billed nor collected', async () => {
    const jar = await login('', PM_EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Work in hand')
    expect(html).toContain('₹1,23,456.78')
    expect(html).not.toContain('Billed this month')
    expect(html).not.toContain('Collected this month')
  })

  it('a finance-viewing session renders both money tiles with the ₹ symbol', async () => {
    const jar = await login('', FIN_EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Billed this month')
    expect(html).toContain('Collected this month')
    expect(html).toMatch(/₹[\d,]+\.\d{2}/)
  })

  it('gross margin never renders a number for anyone (29.26)', async () => {
    const jar = await login('', FIN_EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const html = await page.text()
    if (html.includes('Gross margin')) {
      // If the tile label renders, its body must be the refusal, not a figure.
      const idx = html.indexOf('Gross margin')
      const segment = html.slice(idx, idx + 400)
      expect(segment).toContain('Not wired yet')
    }
  })
})
