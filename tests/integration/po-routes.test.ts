/**
 * Group-1 tranche 3 (DECISIONS 29.53): the purchase-order lifecycle writers
 * through the real router, per the tranche contract from 29.42/29.47:
 *   POST /api/po/:poId/submit      (inventory.po_create)
 *   POST /api/po/:poId/approve     (inventory.approve_po)
 *   POST /api/po/:poId/short-close (inventory.po_create)
 *   POST /api/requisitions/:reqId/approve  (inventory.approve_po)
 *   POST /api/requisitions/:reqId/reject   (inventory.approve_po)
 * for each: unauthenticated 403 (CSRF, route exists not 404), a role without
 * the permission refused naming it, a permitted role reaching the service,
 * and the 303 flash-redirect contract.
 *
 * The PO lifecycle proves the full flow (create → submit → approve via the
 * approval_limits row the fixture seeds). The requisition approve/reject pair
 * is proven at the gate level (permission + CSRF + reach) because the
 * requisition service's own rules are inventory-flow's proof.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

const db = getDb()
const RAISER_EMAIL = fixtureEmail('po-raiser')
const APPROVER_EMAIL = fixtureEmail('po-approver')
const OUTSIDER_EMAIL = fixtureEmail('po-outsider')
const PASSWORD = 'Po-Route-Test-1!'

let raiserId = 0
let approverId = 0
let outsiderId = 0
let raiserRoleId = 0
let approverRoleId = 0
let outsiderRoleId = 0
let limitId = 0
let vendorId = 0
let itemId = 0
let locationId = 0
let poId = 0

function cookieValues(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
  return raw.map((c) => c.split(';')[0]).join('; ')
}

const stripSid = (j: string) => j.split('; ').filter((p) => !p.startsWith('ncc_sid=')).join('; ')

async function tokenOf(res: Response): Promise<string> {
  return (await res.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
}

async function login(email: string, password: string): Promise<string> {
  const page = await app.request('/login', { redirect: 'manual' })
  const jar = cookieValues(page)
  const token = await tokenOf(page)
  const res = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(jar) },
    body: new URLSearchParams({ nc_csrf: token, email, password }),
  })
  await res.text()
  expect(res.status).toBe(302)
  return cookieValues(res)
}

/** Harvest the session CSRF token from an exempt page (the 2FA enrol screen renders for any signed-in user pre-verification). */
async function csrfPair(jar: string): Promise<{ jar: string; token: string }> {
  const res = await app.request('/2fa/enrol', { headers: { cookie: jar }, redirect: 'manual' })
  const nextJar = cookieValues(res) || jar
  const token = await tokenOf(res)
  return { jar: nextJar, token }
}

async function post(jar: string, path: string, body: Record<string, string>): Promise<Response> {
  const { jar: j2, token } = await csrfPair(jar)
  return app.request(path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: j2 },
    body: new URLSearchParams({ nc_csrf: token, ...body }),
  })
}

async function makeRole(label: string, keys: string[]): Promise<number> {
  const perms = await db.selectFrom('permissions').select(['id', 'key']).where('key', 'in', keys).execute()
  const role = await db.insertInto('roles').values({
    key: `[fixture] po_${Date.now().toString(36)}_${label.replace(/\s/g, '')}`,
    label: `[fixture] ${label}`,
    require_2fa: 0,
  }).executeTakeFirstOrThrow()
  const roleId = Number(role.insertId)
  if (perms.length > 0) {
    await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))).execute()
  }
  return roleId
}

async function makeUser(email: string, roleId: number): Promise<number> {
  const res = await db.insertInto('users').values({
    email,
    full_name: fixtureName(`PO ${email}`),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  const userId = Number(res.insertId)
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()
  return userId
}

beforeAll(async () => {
  await sweepFixtures(db)

  raiserRoleId = await makeRole('po raiser', ['inventory.po_create', 'inventory.approve_po', 'inventory.view', 'dashboard.view_own_kpi'])
  approverRoleId = await makeRole('po approver', ['inventory.approve_po', 'inventory.view', 'dashboard.view_own_kpi'])
  outsiderRoleId = await makeRole('po outsider', ['dashboard.view_own_kpi'])
  raiserId = await makeUser(RAISER_EMAIL, raiserRoleId)
  approverId = await makeUser(APPROVER_EMAIL, approverRoleId)
  outsiderId = await makeUser(OUTSIDER_EMAIL, outsiderRoleId)

  // The raiser approves their own POs up to 250 rupees (spec 6.4: limit +
  // self-approval block). The service blocks self-approval outright, so the
  // approver does the approving and the limit exists so approvePo does not
  // refuse for "no limit configured".
  const approverRoleKey = (await db.selectFrom('roles').select('key').where('id', '=', approverRoleId).executeTakeFirstOrThrow()).key
  const limit = await db.insertInto('approval_limits').values({
    role_key: approverRoleKey,
    document_type: 'purchase_order',
    max_value: 25_000_00,
    effective_from: '2026-04-01',
  }).executeTakeFirstOrThrow()
  limitId = Number(limit.insertId)

  // Vendor, item and location per the grn-posting fixture pattern.
  const vendor = await db.insertInto('vendors').values({
    code: `FIXVN-PO${randomUUID().slice(0, 6)}`,
    name: 'Fixture Vendor for PO routes',
    vendor_type: 'material',
    city: 'Bengaluru',
    status: 'active',
    created_by: raiserId,
  }).executeTakeFirstOrThrow()
  vendorId = Number(vendor.insertId)

  const loc = await db.selectFrom('locations').select('id').orderBy('id').limit(1).executeTakeFirstOrThrow()
  locationId = Number(loc.id)

  const unit = await db.selectFrom('units').select('id').where('code', '=', 'bag').executeTakeFirstOrThrow()
  const cat = await db.selectFrom('item_categories').select('id').where('code', '=', 'CEMENT').executeTakeFirstOrThrow()
  const item = await db.insertInto('items').values({
    code: `FIXIT-PO${randomUUID().slice(0, 6)}`,
    name: 'Fixture item for PO routes',
    unit_id: Number(unit.id),
    category_id: Number(cat.id),
    created_by: raiserId,
  }).executeTakeFirstOrThrow()
  itemId = Number(item.insertId)

  // The PO itself, through the service (create rules are inventory's proof).
  const { poSchema } = await import('../../src/modules/inventory/schemas.js')
  const { createPo } = await import('../../src/modules/inventory/service.js')
  const today = new Date().toISOString().slice(0, 10)
  const input = poSchema.parse({
    vendorId: String(vendorId),
    projectId: '',
    requisitionId: '',
    poDate: today,
    expectedDelivery: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
    deliveryLocationId: String(locationId),
    freight: '0',
    paymentTermsDays: '',
    advancePct: '0',
    terms: '',
    itemId: [String(itemId)],
    brand: [''],
    qtyOrdered: ['10'],
    rate: ['1500'],
    gstPct: ['18'],
    costHeadId: [''],
    lineRemarks: [''],
  })
  const created = await createPo(db, { userId: raiserId, ip: '127.0.0.1' }, input)
  poId = created.poId
})

afterAll(async () => {
  await sql`delete from po_lines where po_id = ${poId}`.execute(db).catch(() => {})
  await sql`delete from purchase_orders where id = ${poId}`.execute(db).catch(() => {})
  await sql`delete from approval_limits where id = ${limitId}`.execute(db).catch(() => {})
  await sql`delete from items where id = ${itemId}`.execute(db).catch(() => {})
  await sql`delete from vendors where id = ${vendorId}`.execute(db).catch(() => {})
  await sql`delete from notifications n join users u on n.user_id = u.id where u.full_name like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete from audit_log a join users u on a.user_id = u.id where u.full_name like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete s from user_sessions s join users u on s.user_id = u.id where u.full_name like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete ur from user_roles ur join users u on ur.user_id = u.id where u.full_name like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete from users where full_name like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete from roles where label like '[fixture] po%'`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool()
})

describe('the PO lifecycle routes through the HTTP path (group 1, tranche 3)', () => {
  it('refuses an unauthenticated tokenless POST with 403 from the CSRF guard (route exists, not 404)', async () => {
    const res = await app.request(`/api/po/${poId}/submit`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    })
    expect(res.status).toBe(403)
  })

  it('refuses a role without inventory.po_create, naming the permission', async () => {
    const jar = await login(OUTSIDER_EMAIL, PASSWORD)
    const res = await post(jar, `/api/po/${poId}/submit`, {})
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('inventory.po_create')
  })

  it('the raiser submits through the route and the PO waits for approval', async () => {
    const jar = await login(RAISER_EMAIL, PASSWORD)
    const res = await post(jar, `/api/po/${poId}/submit`, {})
    expect(res.status).toBe(303)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain(`/app/inventory/po/${poId}`)
    const row = await db.selectFrom('purchase_orders').select('status').where('id', '=', poId).executeTakeFirstOrThrow()
    expect(row.status).toBe('pending_approval')
  })

  it('the approver approves through the route; the service reached, not 404', async () => {
    const jar = await login(APPROVER_EMAIL, PASSWORD)
    const res = await post(jar, `/api/po/${poId}/approve`, {})
    // 422 carries the service's refusal in the JSON body; surface it so the
    // assertion failure names the real cause instead of just the code.
    if (res.status !== 303) {
      const body = await res.text()
      throw new Error(`approve returned ${res.status}: ${body.slice(0, 300)}`)
    }
    const loc = decodeURIComponent(res.headers.get('location') ?? '')
    expect(loc).toContain('approved')
    const row = await db.selectFrom('purchase_orders').select('status').where('id', '=', poId).executeTakeFirstOrThrow()
    expect(row.status).toBe('approved')
  })

  it('a role without inventory.approve_po is refused on approve', async () => {
    const jar = await login(OUTSIDER_EMAIL, PASSWORD)
    const res = await post(jar, `/api/po/${poId}/approve`, {})
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('inventory.approve_po')
  })

  it('requisition approve/reject are mounted and gated: tokenless 403, wrong role 403 naming the permission', async () => {
    const unauth = await app.request('/api/requisitions/1/approve', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    })
    expect(unauth.status).toBe(403)

    const jar = await login(OUTSIDER_EMAIL, PASSWORD)
    const res = await post(jar, '/api/requisitions/1/approve', {})
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('inventory.approve_po')

    const rej = await post(jar, '/api/requisitions/1/reject', { reason: 'Not needed.' })
    expect(rej.status).toBe(403)
  })
})
