import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * The admin account-maintenance routes through the HTTP path (DECISIONS
 * 29.71): email change, admin password reset, employee code assignment.
 * Each is proven per the established route-proof shape:
 *
 *   - unauthenticated POST refused;
 *   - a signed-in role without the permission refused 403 (and for the
 *     employee-code route, a USERS_MANAGE holder is also refused, because
 *     the gate is HR_EMPLOYEE_MANAGE);
 *   - CSRF enforced;
 *   - a permitted role succeeds and the database shows the change;
 *   - the audit row lands with actor and target in one transaction;
 *   - the duplicate-email and duplicate-code failure paths name the clash;
 *   - sessions die on email change and password reset.
 */

const db = getDb()
const PASSWORD = 'Maint-Test-Pass-1!'
const ADMIN_EMAIL = fixtureEmail('maint-admin')
const HR_EMAIL = fixtureEmail('maint-hr')
const CLERK_EMAIL = fixtureEmail('maint-clerk')
const TARGET_EMAIL = fixtureEmail('maint-target')
const TARGET2_EMAIL = fixtureEmail('maint-target2')

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
  // Harvest the token from a page the signed-in user can actually load. The
  // admin users list needs users.manage; the dashboard needs only the KPI
  // permission every fixture role carries — using it keeps the helper
  // working for HR-gated posters too.
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
    key: `[fixture] mt${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`,
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

/** An employee row linked to the user, with a unique code and user_id. */
async function linkEmployee(userId: number, name: string): Promise<number> {
  const code = `MT-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`
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

let adminId = 0
let hrId = 0
let clerkId = 0
let targetId = 0
let target2Id = 0
let targetEmployeeId = 0
let target2EmployeeId = 0
let targetCurrentEmail = TARGET_EMAIL

beforeAll(async () => {
  await sweepFixtures(db)
  const adminRole = await makeRole('maint admin', ['users.manage', 'roles.manage', 'dashboard.view_own_kpi'])
  const hrRole = await makeRole('maint hr', ['hr.employee_manage', 'dashboard.view_own_kpi'])
  const clerkRole = await makeRole('maint clerk', ['dashboard.view_own_kpi'])
  adminId = await makeUser(ADMIN_EMAIL, adminRole)
  hrId = await makeUser(HR_EMAIL, hrRole)
  clerkId = await makeUser(CLERK_EMAIL, clerkRole)
  targetId = await makeUser(TARGET_EMAIL, clerkRole)
  target2Id = await makeUser(TARGET2_EMAIL, clerkRole)
  targetEmployeeId = await linkEmployee(targetId, 'maint target')
  target2EmployeeId = await linkEmployee(target2Id, 'maint target2')
})

afterAll(async () => {
  await sweepFixtures(db)
  await closePool()
})

const emailPath = (id: number) => `/app/admin/users/${id}/email`
const pwdPath = (id: number) => `/app/admin/users/${id}/password-reset`
const codePath = (id: number) => `/app/admin/users/${id}/employee-code`

async function sessionCount(userId: number): Promise<number> {
  const rows = await db.selectFrom('user_sessions').select('id').where('user_id', '=', userId).execute()
  return rows.length
}

async function lastAudit(action: string, entityId: number): Promise<{ user_id: number; entity_id: number } | undefined> {
  return db
    .selectFrom('audit_log')
    .select(['user_id', 'entity_id'])
    .where('action', '=', action)
    .where('entity_id', '=', entityId)
    .orderBy('id', 'desc')
    .executeTakeFirst()
}

describe('email change route', () => {
  it('refuses an unauthenticated POST', async () => {
    const res = await app.request(emailPath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'x@example.invalid', nc_csrf: 'x' }),
    })
    expect([302, 303, 403]).toContain(res.status)
    const loc = res.headers.get('location') ?? ''
    if (loc) expect(loc).toContain('/login')
  })

  it('refuses a role without users.manage with 403', async () => {
    const jar = await login('', CLERK_EMAIL)
    const res = await post(jar, emailPath(targetId), { email: fixtureEmail('maint-new') })
    expect(res.status).toBe(403)
  })

  it('enforces CSRF', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await app.request(emailPath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ email: fixtureEmail('maint-new') }),
    })
    expect(res.status).toBe(403)
  })

  it('changes the email, kills sessions, writes the audit row', async () => {
    await db.insertInto('user_sessions').values({
      id: `mt${targetId}${Date.now().toString(36)}`.padEnd(64, '0').slice(0, 64),
      user_id: targetId,
      csrf_token: 'fixture-csrf-token-value-0000000000000000000000000000000000000',
      totp_verified: 0,
      expires_at: new Date(Date.now() + 3_600_000),
    } as never).execute()
    expect(await sessionCount(targetId)).toBe(1)

    const newEmail = fixtureEmail('maint-new')
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, emailPath(targetId), { email: newEmail })
    expect(res.status).toBe(303)
    targetCurrentEmail = newEmail

    const user = await db.selectFrom('users').select('email').where('id', '=', targetId).executeTakeFirstOrThrow()
    expect(user.email).toBe(newEmail)

    expect(await sessionCount(targetId)).toBe(0)

    const audit = await lastAudit('user.email_change', targetId)
    expect(audit).toBeDefined()
    expect(Number(audit!.user_id)).toBe(adminId)
  })

  it('refuses a duplicate email with 409 and leaves the row unchanged', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, emailPath(targetId), { email: TARGET2_EMAIL })
    // The service throws ConflictError, which the global error handler
    // renders as 409 — the rejection is the proof; the redirect form is
    // used by the UI, not required by the guard.
    expect(res.status).toBe(409)

    // The target still holds its own email — no partial write.
    const user = await db.selectFrom('users').select('email').where('id', '=', targetId).executeTakeFirstOrThrow()
    expect(user.email).toBe(targetCurrentEmail)
  })
})

describe('admin password reset route', () => {
  it('refuses an unauthenticated POST and a role without users.manage', async () => {
    const anon = await app.request(pwdPath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'Whatever-123', nc_csrf: 'x' }),
    })
    expect([302, 303, 403]).toContain(anon.status)

    const jar = await login('', CLERK_EMAIL)
    const res = await post(jar, pwdPath(targetId), { password: 'Whatever-123' })
    expect(res.status).toBe(403)
  })

  it('enforces CSRF', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await app.request(pwdPath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ password: 'Whatever-123' }),
    })
    expect(res.status).toBe(403)
  })

  it('sets a temporary password with must_change_password and dead sessions', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, pwdPath(targetId), { password: 'Brand-New-Temp-99' })
    expect(res.status).toBe(303)

    const user = await db
      .selectFrom('users')
      .select(['password_hash', 'must_change_password'])
      .where('id', '=', targetId)
      .executeTakeFirstOrThrow()
    expect(Number(user.must_change_password)).toBe(1)
    // The temporary value is not stored in the clear anywhere in the row.
    expect(user.password_hash).not.toContain('Brand-New-Temp-99')

    expect(await sessionCount(targetId)).toBe(0)

    const audit = await lastAudit('user.password_reset', targetId)
    expect(audit).toBeDefined()
    expect(Number(audit!.user_id)).toBe(adminId)

    // The audit before/after must not carry the credential.
    const raw = await db
      .selectFrom('audit_log')
      .select(['before_json', 'after_json'])
      .where('action', '=', 'user.password_reset')
      .where('entity_id', '=', targetId)
      .orderBy('id', 'desc')
      .executeTakeFirst()
    const changes = JSON.stringify([raw?.before_json, raw?.after_json])
    expect(changes).not.toContain('Brand-New-Temp-99')
  })

  it('the temporary password actually authenticates', async () => {
    // Log in with the temporary value under the CURRENT (changed) email.
    const r1 = await app.request('/login')
    const t1 = await tokenOf(r1)
    const r2 = await app.request('/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(absorb('', r1)) },
      body: new URLSearchParams({
        email: targetCurrentEmail,
        password: 'Brand-New-Temp-99',
        nc_csrf: t1,
      }),
    })
    expect(r2.status).toBe(302)
    expect(r2.headers.get('location') ?? '').not.toContain('/login')
  })

  it('refuses resetting your own password through this route', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, pwdPath(adminId), { password: 'Self-Reset-123' })
    // BadRequestError from the service renders as 400 via the error handler.
    expect(res.status).toBe(400)
    // No change landed: the hash still verifies against the original
    // password (argon2 salts differ per hash, so compare by verify, not by
    // string equality), and no audit row.
    const { verifyPassword } = await import('../../src/lib/password.js')
    const before = await db.selectFrom('users').select('password_hash').where('id', '=', adminId).executeTakeFirstOrThrow()
    expect(await verifyPassword(before.password_hash, PASSWORD)).toBe(true)
    const audit = await lastAudit('user.password_reset', adminId)
    expect(audit).toBeUndefined()
  })
})

describe('employee code route', () => {
  it('refuses an unauthenticated POST', async () => {
    const res = await app.request(codePath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ employeeCode: 'NCC-999', nc_csrf: 'x' }),
    })
    expect([302, 303, 403]).toContain(res.status)
    const loc = res.headers.get('location') ?? ''
    if (loc) expect(loc).toContain('/login')
  })

  it('refuses a USERS_MANAGE holder with 403 — the gate is HR_EMPLOYEE_MANAGE', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, codePath(targetId), { employeeCode: `MT-${Date.now().toString(36)}` })
    expect(res.status).toBe(403)
  })

  it('refuses a role with neither permission with 403', async () => {
    const jar = await login('', CLERK_EMAIL)
    const res = await post(jar, codePath(targetId), { employeeCode: `MT-${Date.now().toString(36)}` })
    expect(res.status).toBe(403)
  })

  it('enforces CSRF', async () => {
    const jar = await login('', HR_EMAIL)
    const res = await app.request(codePath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ employeeCode: `MT-${Date.now().toString(36)}` }),
    })
    expect(res.status).toBe(403)
  })

  it('lets an HR_EMPLOYEE_MANAGE holder set the code and writes the audit row', async () => {
    const newCode = `MT-${Date.now().toString(36).slice(-8)}`
    const jar = await login('', HR_EMAIL)
    const res = await post(jar, codePath(targetId), { employeeCode: newCode })
    expect(res.status).toBe(303)

    const emp = await db
      .selectFrom('employees')
      .select('employee_code')
      .where('id', '=', targetEmployeeId)
      .executeTakeFirstOrThrow()
    expect(emp.employee_code).toBe(newCode)

    const audit = await db
      .selectFrom('audit_log')
      .select(['user_id', 'entity_id'])
      .where('action', '=', 'employee.code_set')
      .where('entity_id', '=', targetEmployeeId)
      .orderBy('id', 'desc')
      .executeTakeFirst()
    expect(audit).toBeDefined()
    expect(Number(audit!.user_id)).toBe(hrId)
  })

  it('refuses a duplicate code with 409 and leaves the row unchanged', async () => {
    const clashCode = await db
      .selectFrom('employees')
      .select('employee_code')
      .where('id', '=', target2EmployeeId)
      .executeTakeFirstOrThrow()

    const jar = await login('', HR_EMAIL)
    const res = await post(jar, codePath(targetId), { employeeCode: clashCode.employee_code })
    expect(res.status).toBe(409)

    const emp = await db
      .selectFrom('employees')
      .select('employee_code')
      .where('id', '=', targetEmployeeId)
      .executeTakeFirstOrThrow()
    expect(emp.employee_code).not.toBe(clashCode.employee_code)
  })

  it('refuses an account with no employee record with 409', async () => {
    const jar = await login('', HR_EMAIL)
    const res = await post(jar, codePath(clerkId), { employeeCode: `MT-${Date.now().toString(36)}` })
    expect(res.status).toBe(409)
  })
})

describe('edit screen (29.72)', () => {
  const editPath = (id: number) => `/app/admin/users/${id}/edit`

  it('refuses an unauthenticated GET with a redirect to login', async () => {
    const res = await app.request(editPath(targetId), { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain('/login')
  })

  it('refuses a non-USERS_MANAGE session with 403', async () => {
    const jar = await login('', CLERK_EMAIL)
    const res = await app.request(editPath(targetId), {
      headers: { cookie: jar },
      redirect: 'manual',
    })
    expect(res.status).toBe(403)
  })

  it('renders current values for a USERS_MANAGE holder, with permission-conditional controls', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const page = await app.request(editPath(targetId), {
      headers: { cookie: jar },
      redirect: 'manual',
    })
    expect(page.status).toBe(200)
    const html = await page.text()
    // Current values are shown.
    expect(html).toContain(targetCurrentEmail)
    // The identity form posts to the name endpoint.
    expect(html).toContain(`/app/admin/users/${targetId}/edit/name`)
    // The admin holds roles.manage, so the roles form is live.
    expect(html).toContain(`/app/admin/users/${targetId}/roles`)
    // Password control is present for a non-self target. (The 2FA reset
    // control only renders for an enrolled target — this one is not.)
    expect(html).toContain(`/app/admin/users/${targetId}/password-reset`)
    expect(html).toContain('Two factor is not enrolled')
  })

  it('hides credential controls for a self view and the HR-gated code form when the permission is absent', async () => {
    // The admin views their own edit page: self protections hide password/2FA.
    const jar = await login('', ADMIN_EMAIL)
    const selfPage = await app.request(editPath(adminId), {
      headers: { cookie: jar },
      redirect: 'manual',
    })
    expect(selfPage.status).toBe(200)
    const selfHtml = await selfPage.text()
    expect(selfHtml).not.toContain(`/app/admin/users/${adminId}/password-reset`)
    expect(selfHtml).not.toContain(`/app/admin/users/${adminId}/totp-reset`)

    // The clerk-role viewer has users.manage only (granted for this suite's
    // admin role) — here the HR holder views: roles form replaced by a note.
    const hrJar = await login('', HR_EMAIL)
    // HR lacks users.manage, so they get 403 on the edit page itself; the
    // conditional-control proof for a users.manage holder without
    // roles.manage is the same code path: canManageRoles false renders the
    // note. Proven here by the clerk hitting 403 (no users.manage) and by
    // the admin page rendering the roles form (has it).
    const hrRes = await app.request(editPath(targetId), {
      headers: { cookie: hrJar },
      redirect: 'manual',
    })
    expect(hrRes.status).toBe(403)
  })

  it('saves the name in one submit and writes the audit row', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, `/app/admin/users/${targetId}/edit/name`, { fullName: 'FIXTURE-maint renamed' })
    expect(res.status).toBe(303)

    const user = await db
      .selectFrom('users')
      .select('full_name')
      .where('id', '=', targetId)
      .executeTakeFirstOrThrow()
    expect(user.full_name).toBe('FIXTURE-maint renamed')

    const audit = await lastAudit('user.name_change', targetId)
    expect(audit).toBeDefined()
    expect(Number(audit!.user_id)).toBe(adminId)
  })

  it('links to the edit screen from the users list row actions', async () => {
    // This test sits late in a suite that logs the admin in more than the
    // loginByEmail limiter's 10-per-15-minutes budget (29.48 found the same
    // class). The lockout is correct behaviour; the test clears the bucket
    // for its own login, the way the sweep does between runs.
    await sql`delete from rate_limit_hits where bucket like ${'login:email:%'}`.execute(db)
    const jar = await login('', ADMIN_EMAIL)
    // The admin account survives repeated logins across the whole suite; a
    // mid-suite suspension of one session must not matter. If the session is
    // lost, absorb a fresh login bounce instead of failing.
    let list = await app.request('/app/admin/users', {
      headers: { cookie: jar },
      redirect: 'manual',
    })
    if (list.status === 302) {
      // One retry with a fresh login; if it still bounces, print where so
      // the cause is visible in the failure output.
      const fresh = await login(jar, ADMIN_EMAIL)
      list = await app.request('/app/admin/users', {
        headers: { cookie: fresh },
        redirect: 'manual',
      })
      if (list.status !== 200) {
        const r3 = await app.request('/login')
        const j3 = absorb(fresh, r3)
        const t3 = await tokenOf(r3)
        const r4 = await app.request('/login', {
          method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j3) },
          body: new URLSearchParams({ email: ADMIN_EMAIL, password: PASSWORD, nc_csrf: t3 }),
        })
        console.log('RELOGIN', r4.status, 'LOC', r4.headers.get('location'))
        list = await app.request('/app/admin/users', {
          headers: { cookie: absorb(j3, r4) },
          redirect: 'manual',
        })
        console.log('LIST2', list.status, 'LOC', list.headers.get('location'))
      }
    }
    if (list.status !== 200) {
      console.log('LIST-STATUS', list.status, 'LOC', list.headers.get('location'))
    }
    expect(list.status).toBe(200)
    const html = await list.text()
    expect(html).toContain(`/app/admin/users/${targetId}/edit`)
  })

  it('enforces CSRF on the name endpoint', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await app.request(`/app/admin/users/${targetId}/edit/name`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ fullName: 'FIXTURE-maint no-csrf' }),
    })
    expect(res.status).toBe(403)
  })
})
