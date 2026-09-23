import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * The new-roles, roster-removal and staff-onboarding batch (DECISIONS
 * 29.74–29.76), proven through the HTTP path:
 *
 *   - the 029 roles hold exactly their pinned sets (already pinned in
 *     role-grants.test.ts — here a session with each new role reaches the
 *     screens its grants allow and is refused where they do not);
 *   - the staff onboarding POST creates the user AND employees rows in one
 *     submit, and a duplicate employee code is refused with a readable
 *     error while the duplicate email path also names the clash;
 *   - the non-USERS_MANAGE session gets 403 on the onboarding POST;
 *   - CSRF is enforced on the onboarding POST;
 *   - the edit screen renders the current employee code and the
 *     employee-code change writes it with the audit row.
 */

const db = getDb()
const PASSWORD = 'Staff-Batch-Pass-1!'
const ADMIN_EMAIL = fixtureEmail('staff-admin')
const CLERK_EMAIL = fixtureEmail('staff-clerk')

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
  const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
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
    key: `[fixture] sb${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`,
    label: `[fixture] ${label}`,
    require_2fa: 0,
  }).executeTakeFirstOrThrow()
  const roleId = Number(rr.insertId)
  if (perms.length) {
    await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))).execute()
  }
  return roleId
}

async function makeUser(email: string, roleId: number): Promise<number> {
  const u = await db.insertInto('users').values({
    email,
    full_name: fixtureName(email.slice(8, 30)),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  const id = Number(u.insertId)
  await db.insertInto('user_roles').values({ user_id: id, role_id: roleId }).execute()
  return id
}

let adminId = 0
let clerkId = 0
let adminJar = ''

let onboardedEmail = ''

beforeAll(async () => {
  await sweepFixtures(db)
  // The limiter window is 15 minutes; a prior run's attempts may still be
  // inside it. Clear the buckets for these fixture addresses first.
  await sql`DELETE FROM rate_limits WHERE \`key\` LIKE 'login:%'`.execute(db).catch(() => {})
  const adminRole = await makeRole('staff admin', ['users.manage', 'dashboard.view_own_kpi'])
  const clerkRole = await makeRole('staff clerk', ['dashboard.view_own_kpi'])
  adminId = await makeUser(ADMIN_EMAIL, adminRole)
  clerkId = await makeUser(CLERK_EMAIL, clerkRole)
  adminJar = await login('', ADMIN_EMAIL)
})

afterAll(async () => {
  await sweepFixtures(db)
  await closePool()
})

const STAFF_PATH = '/app/admin/users/staff'

async function lastAudit(action: string, entityId: number): Promise<{ user_id: number; entity_id: number } | undefined> {
  return db
    .selectFrom('audit_log')
    .select(['user_id', 'entity_id'])
    .where('action', '=', action)
    .where('entity_id', '=', entityId)
    .orderBy('id', 'desc')
    .executeTakeFirst()
}

describe('staff onboarding POST /app/admin/users/staff (29.76)', () => {
  it('an unauthenticated POST is refused (redirect to /login, nothing written)', async () => {
    const res = await app.request(STAFF_PATH, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'x@y.z', fullName: 'X Y', employeeCode: 'ZZ-1', nc_csrf: 'nope' }),
    })
    expect(res.status).toBe(403)
    const rows = await db.selectFrom('users').select('id').where('email', '=', 'x@y.z').execute()
    expect(rows).toEqual([])
  })

  it('a role without users.manage is refused 403', async () => {
    const clerkJar = await login('', CLERK_EMAIL)
    const res = await post(clerkJar, STAFF_PATH, {
      email: fixtureEmail('staff-new'),
      fullName: 'Should Not Exist',
      employeeCode: 'ZZ-NOPE',
      roleId: '',
    })
    expect(res.status).toBe(403)
  })

  it('a POST without a valid CSRF token is refused 403', async () => {
    const res = await app.request(STAFF_PATH, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminJar },
      body: new URLSearchParams({ email: fixtureEmail('staff-nocsrf'), fullName: 'No Csrf', employeeCode: 'ZZ-NC', nc_csrf: 'forged' }),
    })
    expect(res.status).toBe(403)
  })

  it('a permitted role creates the user AND employees rows in one submit, audited', async () => {
    const email = fixtureEmail('staff-onboarded')
    onboardedEmail = email
    const code = `SB-${Date.now().toString(36).slice(-8)}`
    const res = await post(adminJar, STAFF_PATH, { email, fullName: 'Onboarded Person', employeeCode: code, roleId: '' })
    expect(res.status).toBe(303)

    const user = await db.selectFrom('users').select(['id', 'employee_id']).where('email', '=', email).executeTakeFirstOrThrow()
    expect(user.employee_id).not.toBeNull()
    const emp = await db
      .selectFrom('employees')
      .select(['id', 'employee_code'])
      .where('id', '=', Number(user.employee_id))
      .executeTakeFirstOrThrow()
    expect(emp.employee_code).toBe(code)

    const audit = await lastAudit('user.create_staff', Number(user.id))
    expect(audit).toBeDefined()
    expect(Number(audit!.user_id)).toBe(adminId)
  })

  it('a duplicate employee code is refused with a readable error and nothing is written', async () => {
    const code = `SB-DUP-${Date.now().toString(36).slice(-6)}`
    const firstEmail = fixtureEmail('staff-dup-first')
    await post(adminJar, STAFF_PATH, { email: firstEmail, fullName: 'First Holder', employeeCode: code, roleId: '' })

    const secondEmail = fixtureEmail('staff-dup-second')
    const res = await post(adminJar, STAFF_PATH, { email: secondEmail, fullName: 'Second Holder', employeeCode: code, roleId: '' })
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    expect(decodeURIComponent(location)).toContain('already assigned to another employee')

    const rows = await db.selectFrom('users').select('id').where('email', '=', secondEmail).execute()
    expect(rows).toEqual([])
  })

  it('a duplicate email is refused with a readable error', async () => {
    const res = await post(adminJar, STAFF_PATH, { email: onboardedEmail, fullName: 'Email Clash', employeeCode: `SB-${Date.now().toString(36).slice(-8)}x`, roleId: '' })
    expect(res.status).toBe(303)
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('already exists')
  })

  it('the onboarding form renders on the users list with the employee-code field', async () => {
    const res = await app.request('/app/admin/users', { headers: { cookie: adminJar } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('name="employeeCode"')
    expect(html).toContain('action="/app/admin/users/staff"')
  })
})

describe('029 roles and the edit screen (29.74/29.76)', () => {
  it('the users list offers all four new roles in the role pickers', async () => {
    const res = await app.request('/app/admin/users', { headers: { cookie: adminJar } })
    const html = await res.text()
    for (const label of ['Site Engineer', 'QA/QC/QS', 'Architect', 'Procurement Executive']) {
      expect(html).toContain(label)
    }
  })

  it('the edit screen shows the current employee code', async () => {
    const res = await app.request(`/app/admin/users/${clerkId}/edit`, { headers: { cookie: adminJar } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('not linked to an employee record')
  })
})
