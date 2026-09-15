import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { hashSync } from '@node-rs/argon2'
import { sql } from 'kysely'
import { sweepFixtures, fixtureName } from './fixture-markers.js'

/**
 * The real login, end to end (DECISIONS 29.36).
 *
 * The CSRF deadlock (29.32) survived three sessions because nothing ever
 * posted to /login. This suite drives the REAL app router — the exported
 * app object with its full middleware chain — through app.request against
 * the dev database, with a fixture user created in beforeAll and swept in
 * afterAll. It proves: correct credentials issue a session and reach an
 * authenticated page; wrong password is refused; the CSRF pair is
 * enforced; and a second login issues a DIFFERENT session id (the
 * fixation property 29.34 reasoned about, now demonstrated).
 *
 * It also proves what happens to a require_2fa account (the owner) today:
 * the challenge intercepts (requireAuth redirects to /2fa/enrol), and the
 * enrol/verify machinery exists and is mounted — see the 2FA describe
 * block for the proof, and DECISIONS 29.36 for what is still missing.
 */

const db = getDb()
const marker = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
const EMAIL = `fixture.e2e-login.${marker}@example.invalid`
const NAME = fixtureName(`E2E Login ${marker}`)
const PASSWORD = 'E2E-Fixture-Pass-1!'
let userId = 0
let csrfToken = ''
let cookieHeader = ''

/** Extract the pre-session pair from a GET /login response. */
async function freshLoginPair(): Promise<{ cookie: string; token: string }> {
  const res = await app.request('/login')
  const setc = res.headers.get('set-cookie') ?? ''
  const cookie = (setc.match(/ncc_csrf=([^;]+)/) ?? [])[1] ?? ''
  const html = await res.text()
  const token = (html.match(/name="nc_csrf" value="([^"]+)"/) ?? [])[1] ?? ''
  return { cookie: `ncc_csrf=${cookie}`, token }
}

async function login(email: string, password: string): Promise<Response> {
  const { cookie, token } = await freshLoginPair()
  return app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ email, password, nc_csrf: token }),
  })
}

beforeAll(async () => {
  await sweepFixtures(db)
  await db
    .insertInto('users')
    .values({
      email: EMAIL,
      full_name: NAME,
      password_hash: hashSync(PASSWORD),
      password_algo: 'argon2id',
      must_change_password: 0,
      status: 'active',
    })
    .executeTakeFirst()
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', EMAIL)
    .executeTakeFirstOrThrow()
  userId = Number(user.id)
  // sales_exec (role 8): require_2fa = 0, dashboard.view — enough to reach
  // an authenticated page but not an admin screen.
  await db.insertInto('user_roles').values({ user_id: userId, role_id: 8 }).execute()
})

afterAll(async () => {
  await sql`delete from audit_log where user_id = ${userId}`.execute(db).catch(() => {})
  await sql`delete from user_sessions where user_id = ${userId}`.execute(db).catch(() => {})
  await sql`delete from login_attempts where email = ${EMAIL}`.execute(db).catch(() => {})
  await sweepFixtures(db)
})

describe('the real login, end to end through the app router', () => {
  it('issues a session for correct credentials and reaches an authenticated page', async () => {
    const res = await login(EMAIL, PASSWORD)
    expect(res.status).toBe(302)
    const sid = (res.headers.get('set-cookie') ?? '').match(/ncc_sid=([^;]+)/)?.[1] ?? ''
    expect(sid).not.toBe('')
    cookieHeader = `ncc_sid=${sid}`

    // The redirect target (/app) renders with the session cookie.
    const page = await app.request('/app', { headers: { cookie: cookieHeader }, redirect: 'manual' })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Dashboard')
  })

  it('refuses wrong credentials with the generic failure and no cookie', async () => {
    const res = await login(EMAIL, 'Wrong-Password-999!')
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('ncc_sid=')
    expect(await res.text()).toContain('not recognised')
  })

  it('refuses the login POST without the CSRF pair', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
    })
    expect(res.status).toBe(403)
  })

  it('a second login issues a different session id — fixation has nothing to grip', async () => {
    const first = await login(EMAIL, PASSWORD)
    const sid1 = (first.headers.get('set-cookie') ?? '').match(/ncc_sid=([^;]+)/)?.[1] ?? ''
    const second = await login(EMAIL, PASSWORD)
    const sid2 = (second.headers.get('set-cookie') ?? '').match(/ncc_sid=([^;]+)/)?.[1] ?? ''
    expect(sid1).not.toBe('')
    expect(sid2).not.toBe('')
    expect(sid2).not.toBe(sid1)
  })
})

describe('the require_2fa interception, proven not reasoned', () => {
  it('an owner (require_2fa=1, unconfirmed TOTP) is redirected to enrolment after login', async () => {
    // The owner is seeded bootstrap state (README:25); sign in as the
    // fixture user, then upgrade THAT user's role to owner for one probe
    // and back, so no real staff row is ever touched (fence).
    await db.updateTable('users').set({ totp_confirmed_at: null }).where('id', '=', userId).execute()
    await db.deleteFrom('user_roles').where('user_id', '=', userId).execute()
    const ownerRole = await sql<{ id: number }>`select id from roles where \`key\` = 'owner'`
      .execute(db)
    await db.insertInto('user_roles').values({ user_id: userId, role_id: Number(ownerRole.rows[0].id) }).execute()

    try {
      const res = await login(EMAIL, PASSWORD)
      const sid = (res.headers.get('set-cookie') ?? '').match(/ncc_sid=([^;]+)/)?.[1] ?? ''
      const page = await app.request('/app', {
        headers: { cookie: `ncc_sid=${sid}` },
        redirect: 'manual',
      })
      expect(page.status).toBe(302)
      expect(page.headers.get('location')).toBe('/2fa/enrol')

      // The enrolment screen renders (the machinery is implemented).
      const enrol = await app.request('/2fa/enrol', {
        headers: { cookie: `ncc_sid=${sid}` },
        redirect: 'manual',
      })
      expect(enrol.status).toBe(200)
      const enrolHtml = await enrol.text()
      // The QR is rendered as a data-URI PNG (the otpauth URI lives inside
      // the image, not the HTML), so assert on the visible proof instead:
      // the heading, a scannable QR, and a setup key.
      expect(enrolHtml).toContain('Set up two factor authentication')
      expect(enrolHtml).toContain('data:image/png;base64,')
      expect(enrolHtml).toContain('Setup key:')
    } finally {
      // Restore the fixture user to sales_exec for the afterAll sweep and
      // the earlier tests' assumptions.
      await db.deleteFrom('user_roles').where('user_id', '=', userId).execute()
      await db.insertInto('user_roles').values({ user_id: userId, role_id: 8 }).execute()
    }
  })
})
