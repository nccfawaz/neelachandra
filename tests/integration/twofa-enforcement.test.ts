import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { hashSync } from '@node-rs/argon2'
import { sql } from 'kysely'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * Is 2FA enforced, or advisory? (DECISIONS 29.39)
 *
 * A require_2fa user with totp_confirmed_at = NULL signs in and is
 * redirected to /2fa/enrol. requireAuth (src/middleware/requireAuth.ts)
 * redirects every /app/* and /api/* path to the enrolment screen — so the
 * question is whether any path ESCAPES that gate. This suite proves the
 * three cases the task names with the exact same session cookie:
 *
 *   1. GET a protected dashboard route (/app)          -> 302 to /2fa/enrol
 *   2. GET a money route (/app/finance/expenses)       -> 302 to /2fa/enrol
 *   3. POST an approval route with a valid CSRF pair
 *      (/api/finance/expenses/:id/approve)             -> 302 to /2fa/enrol
 *      (the redirect fires before the handler, so the approval cannot run)
 *
 * Plus: the POST case with a CSRF pair proves the constraint is not
 * merely the CSRF guard refusing — the session reaches the gate, is
 * redirected, and the business action never executes.
 */

const db = getDb()
const EMAIL = fixtureEmail('twofa-unenrolled')
const NAME = fixtureName('2FA Unenrolled User')
const PASSWORD = 'TwoFA-Test-Pass-1!'
let userId = 0
let roleId = 0
let expenseId = 0

async function login(): Promise<string> {
  const res = await app.request('/login')
  const cookie = (res.headers.get('set-cookie') ?? '').match(/ncc_csrf=([^;]+)/)?.[1] ?? ''
  const token = (await res.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
  const out = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ncc_csrf=${cookie}` },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, nc_csrf: token }),
  })
  const sid = (out.headers.get('set-cookie') ?? '').match(/ncc_sid=([^;]+)/)?.[1] ?? ''
  if (!sid) throw new Error(`login failed: ${out.status}`)
  return `ncc_sid=${sid}`
}

beforeAll(async () => {
  await sweepFixtures(db)
  await db.insertInto('users').values({
    email: EMAIL,
    full_name: NAME,
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirst()
  const user = await db.selectFrom('users').select('id').where('email', '=', EMAIL).executeTakeFirstOrThrow()
  userId = Number(user.id)
  // A require_2fa role with finance permissions, created and swept as a
  // fixture (label carries the marker) so no real role is touched.
  const [permIds] = await Promise.all([
    db.selectFrom('permissions').select(['id', 'key'])
      .where('key', 'in', ['dashboard.view', 'finance.expense_manage', 'finance.expense_approve'])
      .execute(),
  ])
  const roleResult = await db.insertInto('roles').values({
    key: `[fixture] twofa_test_${Date.now().toString(36)}`,
    label: '[fixture] 2FA test role',
    require_2fa: 1,
  }).executeTakeFirstOrThrow()
  roleId = Number(roleResult.insertId)
  await db.insertInto('role_permissions').values(
    permIds.filter((p) => p.key === 'dashboard.view' || p.key === 'finance.expense_manage' || p.key === 'finance.expense_approve')
      .map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))
  ).execute()
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()
  // Force the exact un-enrolled state the task asks about.
  await db.updateTable('users').set({ totp_confirmed_at: null, totp_secret: null }).where('id', '=', userId).execute()
})

afterAll(async () => {
  await sql`delete from audit_log where user_id = ${userId}`.execute(db).catch(() => {})
  await sql`delete s from user_sessions s join users u on s.user_id = u.id where u.id = ${userId}`.execute(db).catch(() => {})
  await sql`delete ur from user_roles ur join users u on ur.user_id = u.id where u.id = ${userId}`.execute(db).catch(() => {})
  await sql`delete rp from role_permissions rp join roles r on rp.role_id = r.id where r.label like '[fixture]%'`.execute(db).catch(() => {})
  await sql`delete from roles where label like '[fixture]%'`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool().catch(() => {})
})

describe('an un-enrolled require_2fa session (totp_confirmed_at NULL)', () => {
  it('is redirected to /2fa/enrol on GET of the dashboard', async () => {
    const cookie = await login()
    const res = await app.request('/app', { headers: { cookie }, redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/2fa/enrol')
  })

  it('is redirected on GET of a money route', async () => {
    const cookie = await login()
    const res = await app.request('/app/finance/expenses', { headers: { cookie }, redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/2fa/enrol')
  })

  it('cannot POST an approval — the gate fires before the handler even with a valid CSRF pair', async () => {
    const cookie = await login()
    // Fetch a CSRF token from an exempt page so the pair is valid; the
    // redirect must still fire, proving the 2FA gate (not CSRF) stops it.
    const page = await app.request('/2fa/enrol', { headers: { cookie }, redirect: 'manual' })
    const csrfCookie = (page.headers.get('set-cookie') ?? '').match(/ncc_csrf=([^;]+)/)?.[1] ?? ''
    const token = (await page.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
    const res = await app.request(`/api/finance/expenses/${expenseId || 1}/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${cookie}; ncc_csrf=${csrfCookie}` },
      body: new URLSearchParams({ nc_csrf: token }),
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/2fa/enrol')
  })

  it('still reaches the enrolment screen — the constraint does not lock the account out', async () => {
    const cookie = await login()
    const res = await app.request('/2fa/enrol', { headers: { cookie }, redirect: 'manual' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Set up two factor authentication')
  })
})
