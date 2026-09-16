import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * Is the TOTP limiter a lockout weapon? (DECISIONS 29.45)
 *
 * The question: can an attacker who knows only the owner's email consume
 * the owner's totp:user:* budget and lock the owner out of signing in?
 *
 * The architecture answers no, and this suite proves each link:
 *
 *   1. The limiter lives at the START of verifyTotp (service.ts:458), and
 *      verifyTotp is reachable ONLY through POST /2fa/verify, which
 *      requires a live session — which requires the correct password.
 *   2. A wrong-password login attempt (correct email, wrong password)
 *      consumes ZERO totp budget: proven by planting three failed logins
 *      and observing the bucket still absent.
 *   3. GET /2fa/verify does not hit the limiter (only the POST handler
 *      calls verifyTotp).
 *   4. A wrong code WITH a session consumes exactly one hit — brute force
 *      through the real endpoint is still limited at 10 per 15 minutes.
 *
 * Rejected alternative (recorded in 29.45): keying the limiter per session
 * instead of per user would let a victim's OTHER sessions be locked
 * independently but does nothing extra here, because an attacker without
 * the password has no session to spend budget from. The password gate IS
 * the fix.
 */

const db = getDb()
const EMAIL = fixtureEmail('limiter-weapon')
const PASSWORD = 'Limiter-Test-Pass-1!'
let userId = 0
let roleId = 0

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

async function login(jar: string, password: string): Promise<Response> {
  const r1 = await app.request('/login')
  const j = absorb(jar, r1)
  const t1 = await tokenOf(r1)
  return app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j) },
    body: new URLSearchParams({ email: EMAIL, password, nc_csrf: t1 }),
  })
}

async function bucketCount(): Promise<number | null> {
  const rows = await db
    .selectFrom('rate_limit_hits')
    .select('hit_count')
    .where('bucket', '=', `totp:user:${userId}`)
    .execute()
  return rows.length ? Number(rows[0]!.hit_count) : null
}

beforeAll(async () => {
  await sweepFixtures(db)
  await sql`delete from rate_limit_hits where bucket like ${'totp:user:%'}`.execute(db).catch(() => {})
  const row = await db.insertInto('users').values({
    email: EMAIL,
    full_name: fixtureName('Limiter Weapon User'),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  userId = Number(row.insertId)
  await db.updateTable('users').set({ totp_confirmed_at: new Date(), totp_secret: null }).where('id', '=', userId).execute()
  const perms = await db.selectFrom('permissions').select(['id', 'key']).where('key', '=', 'dashboard.view_own_kpi').execute()
  const rr = await db.insertInto('roles').values({
    key: `[fixture] lw${Date.now().toString(36).slice(-5)}`,
    label: '[fixture] limiter weapon role',
    require_2fa: 1,
  }).executeTakeFirstOrThrow()
  roleId = Number(rr.insertId)
  await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))).execute()
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()
})

afterAll(async () => {
  await sql`delete rp from role_permissions rp join roles r on rp.role_id = r.id where r.label like '[fixture] limiter%'`.execute(db).catch(() => {})
  await sql`delete from roles where label like '[fixture] limiter%'`.execute(db).catch(() => {})
  await sql`delete from rate_limit_hits where bucket like ${'totp:user:%'}`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool().catch(() => {})
})

describe('the TOTP limiter is not a lockout weapon (29.45)', () => {
  it('a wrong-password login consumes zero totp budget', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await login('', 'Wrong-Password-1!')
      expect([401, 429]).toContain(res.status)
      await res.text()
    }
    expect(await bucketCount()).toBeNull()
  })

  it('GET /2fa/verify does not hit the limiter either', async () => {
    const ok = await login('', PASSWORD)
    expect(ok.status).toBe(302)
    const jar = absorb('', ok)
    const page = await app.request('/2fa/verify', { headers: { cookie: jar }, redirect: 'manual' })
    expect(page.status).toBe(200)
    await page.text()
    expect(await bucketCount()).toBeNull()
  })

  it('a wrong code WITH a session consumes exactly one hit — brute force stays limited', async () => {
    const ok = await login('', PASSWORD)
    let jar = absorb('', ok)
    const page = await app.request('/2fa/verify', { headers: { cookie: jar }, redirect: 'manual' })
    jar = absorb(jar, page)
    const token = await tokenOf(page)
    const res = await app.request('/2fa/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ code: '000000', nc_csrf: token }),
    })
    expect([200, 422]).toContain(res.status)
    await res.text()
    // 10 per 15 minutes per user (RULES.totpByUser); one wrong code = one hit.
    expect(await bucketCount()).toBe(1)
  })

  it('a correct code clears the bucket — one later typo cannot lock a user who just authenticated (29.52)', async () => {
    // Enrol a real secret so a correct code exists, then wrong ×2, correct.
    const { generateSecret, encryptSecret, verifyCode } = await import('../../src/lib/totp.js')
    const otplib = await import('otplib')
    const secret = generateSecret()
    await db.updateTable('users').set({ totp_secret: encryptSecret(secret) }).where('id', '=', userId).execute()

    const ok = await login('', PASSWORD)
    let jar = absorb('', ok)
    const page = await app.request('/2fa/verify', { headers: { cookie: jar }, redirect: 'manual' })
    jar = absorb(jar, page)
    const token = await tokenOf(page)

    // Two wrong codes: bucket = 2 (the enrolment test's earlier hit was in a
    // prior window/suite run; only this run's hits matter here).
    for (let i = 0; i < 2; i += 1) {
      const wrong = await app.request('/2fa/verify', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
        body: new URLSearchParams({ code: '000000', nc_csrf: token }),
      })
      await wrong.text()
    }
    const before = await bucketCount()
    expect(before ?? 0).toBeGreaterThanOrEqual(2)

    // The correct code for the CURRENT step.
    const code = otplib.authenticator.generate(secret)
    expect(verifyCode(secret, code)).toBe(true)
    const good = await app.request('/2fa/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ code, nc_csrf: token }),
    })
    expect(good.status).toBe(302)
    await good.text()
    expect(await bucketCount()).toBeNull()

    // And brute force is still limited afterwards: a new session's wrong
    // codes still cost hits against a fresh window.
    const ok2 = await login('', PASSWORD)
    let jar2 = absorb('', ok2)
    const page2 = await app.request('/2fa/verify', { headers: { cookie: jar2 }, redirect: 'manual' })
    jar2 = absorb(jar2, page2)
    const token2 = await tokenOf(page2)
    const wrongAgain = await app.request('/2fa/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar2 },
      body: new URLSearchParams({ code: '000000', nc_csrf: token2 }),
    })
    expect([200, 422]).toContain(wrongAgain.status)
    await wrongAgain.text()
    expect(await bucketCount()).toBe(1)
  })
})
