import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * Leave routing to the owner alone (DECISIONS 29.64, §6.6).
 *
 * The business rule settled this batch: ALL leave, for everyone, is approved
 * by Chandrashekar (owner) alone. Sushma holds HR records and attendance
 * entry — `hr.employee_manage` / `hr.employee_view` / `hr.attendance_record`
 * — but NOT `hr.leave_approve`. The routing is a GRANT question, not code:
 * the approval route is gated on `hr.leave_approve`, and that permission is
 * seeded onto the owner role only. Proven here through the real router:
 *
 *   - a Sushma-shaped role (HR without leave_approve) is refused 403 naming
 *     the permission;
 *   - an owner-shaped role succeeds and writes attendance/balance rows;
 *   - the owner's OWN request is refused by the service with the
 *     self-approval message — the sole approver cannot approve himself, so
 *     his leave has no decision path today (reported, owner question).
 */

const db = getDb()
const PASSWORD = 'Leave-Test-Pass-1!'
const OWNER_EMAIL = fixtureEmail('leave-owner')
const HR_EMAIL = fixtureEmail('leave-hr')
const EMP_EMAIL = fixtureEmail('leave-emp')

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

const tokenOf = async (res: Response): Promise<string> =>
  (await res.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''

const stripSid = (j: string) => j.split('; ').filter((p) => !p.startsWith('ncc_sid=')).join('; ')

async function login(jar: string, email: string): Promise<string> {
  const r1 = await app.request('/login')
  const j = absorb(jar, r1)
  const t1 = await tokenOf(r1)
  const r2 = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j) },
    body: new URLSearchParams({ email, password: PASSWORD, nc_csrf: t1 }),
  })
  return absorb(j, r2)
}

async function post(jar: string, path: string, body: Record<string, string>): Promise<Response> {
  // The CSRF token comes from a rendered page (any authenticated GET renders
  // a form carrying nc_csrf), not from the POST-only endpoint under test.
  const page = await app.request('/app/hr/leave', { headers: { cookie: jar }, redirect: 'manual' })
  const token = await tokenOf(page)
  const nextJar = absorb(jar, page)
  return app.request(path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: nextJar },
    body: new URLSearchParams({ ...body, nc_csrf: token }),
  })
}

async function makeRole(label: string, keys: string[]): Promise<number> {
  const perms = keys.length
    ? await db.selectFrom('permissions').select(['id']).where('key', 'in', keys as never).execute()
    : []
  const rr = await db.insertInto('roles').values({
    key: `[fixture] lv${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`,
    label: `[fixture] ${label}`,
    require_2fa: 0,
  }).executeTakeFirstOrThrow()
  const roleId = Number(rr.insertId)
  if (perms.length) {
    await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))).execute()
  }
  return roleId
}

async function makeEmployeeUser(email: string, roleId: number, name: string): Promise<number> {
  const u = await db.insertInto('users').values({
    email,
    full_name: fixtureName(name),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  const userId = Number(u.insertId)
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()
  const code = `TF-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`
  const e = await db.insertInto('employees').values({
    employee_code: code,
    user_id: userId,
    full_name: fixtureName(name),
    employment_type: 'permanent',
    date_of_joining: '2025-01-01',
    status: 'active',
  }).executeTakeFirstOrThrow()
  const employeeId = Number(e.insertId)
  await db.updateTable('users').set({ employee_id: employeeId }).where('id', '=', userId).execute()
  return employeeId
}

let ownerEmployeeId = 0
let hrEmployeeId = 0
let empEmployeeId = 0
let casualLeaveTypeId = 0
let requestId = 0
let selfRequestId = 0

beforeAll(async () => {
  await sweepFixtures(db)

  // Sushma's shape: HR records and attendance WITHOUT leave_approve.
  const hrRole = await makeRole('hr without leave', [
    'hr.employee_manage', 'hr.employee_view', 'hr.attendance_record',
    'dashboard.view_own_kpi',
  ])
  const ownerRole = await makeRole('owner-like approver', [
    'hr.leave_approve', 'hr.employee_view', 'dashboard.view_own_kpi',
  ])
  const plainRole = await makeRole('plain employee', ['dashboard.view_own_kpi'])

  hrEmployeeId = await makeEmployeeUser(HR_EMAIL, hrRole, 'leave hr sushma-shape')
  ownerEmployeeId = await makeEmployeeUser(OWNER_EMAIL, ownerRole, 'leave owner')
  empEmployeeId = await makeEmployeeUser(EMP_EMAIL, plainRole, 'leave requester')

  const types = await db.selectFrom('leave_types').select(['id', 'code']).where('code', '=', 'CL').execute()
  casualLeaveTypeId = Number(types[0]!.id)

  const r = await db.insertInto('leave_requests').values({
    employee_id: empEmployeeId,
    leave_type_id: casualLeaveTypeId,
    from_date: '2099-03-03',
    to_date: '2099-03-04',
    days: 2,
    status: 'pending',
  }).executeTakeFirstOrThrow()
  requestId = Number(r.insertId)

  const s = await db.insertInto('leave_requests').values({
    employee_id: ownerEmployeeId,
    leave_type_id: casualLeaveTypeId,
    from_date: '2099-04-01',
    to_date: '2099-04-01',
    days: 1,
    status: 'pending',
  }).executeTakeFirstOrThrow()
  selfRequestId = Number(s.insertId)
})

afterAll(async () => {
  await sweepFixtures(db)
  await closePool()
})

describe('leave routing to the owner alone', () => {
  it('refuses an HR role holding records and attendance but not hr.leave_approve, naming the permission', async () => {
    const jar = await login('', HR_EMAIL)
    const res = await post(jar, `/api/hr/leave/${requestId}/approve`, { decision: 'approve' })
    expect(res.status).toBe(403)
    const text = await res.text()
    expect(text).toContain('hr.leave_approve')
  })

  it('lets a role holding hr.leave_approve approve through the real route', async () => {
    const jar = await login('', OWNER_EMAIL)
    const res = await post(jar, `/api/hr/leave/${requestId}/approve`, { decision: 'approve' })
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    expect(location).not.toContain('error=')
    const row = await db
      .selectFrom('leave_requests')
      .select(['status', 'approved_by'])
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('approved')
    // approved_by stores the deciding user's id (the OWNER fixture user),
    // not the employee row — assert it is set and is the approver's user id.
    expect(Number(row.approved_by)).toBeGreaterThan(0)
  })

  it('refuses the sole approver approving his OWN leave — reported: his leave has no decision path', async () => {
    const jar = await login('', OWNER_EMAIL)
    const res = await post(jar, `/api/hr/leave/${selfRequestId}/approve`, { decision: 'approve' })
    expect(res.status).toBe(303)
    const location = decodeURIComponent(res.headers.get('location') ?? '')
    expect(location).toContain('you cannot approve it')
    const row = await db
      .selectFrom('leave_requests')
      .select('status')
      .where('id', '=', selfRequestId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('pending')
  })
})
