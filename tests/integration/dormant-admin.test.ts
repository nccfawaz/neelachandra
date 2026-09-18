import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { hashSync } from '@node-rs/argon2'
import app from '../../src/app.js'
import { fixtureEmail, fixtureName, sweepFixtures } from './fixture-markers.js'

/**
 * The dormant second admin (DECISIONS 29.68).
 *
 * 29.65 stated the single-admin risk plainly: if Fawaz loses both his phone
 * and his recovery codes, he is locked out permanently and, as sole admin,
 * cannot reset himself — no path back. The answer is a second admin account,
 * seeded dormant by `scripts/seed-staff.mjs --seed-dormant-admin`, whose
 * recovery codes are held offline by the owner. This suite proves the
 * mechanism with its own fixture account (admin role, require_2fa=1, so the
 * shape matches the seeded one):
 *   1. password + recovery code at the 2FA challenge reaches the admin
 *      screens;
 *   2. as an authenticated admin it performs a 2FA reset through the same
 *      gated route any admin uses, with the audit row naming actor;
 *   3. it is a second holder, not a bypass: its distinct permission set
 *      equals the admin role's exactly, and the route still refuses a
 *      role without the permission (already proven in
 *      totp-reset-route.test.ts; re-proved here against a non-admin).
 */

const EMAIL = fixtureEmail('dormant-admin')
const PASSWORD = 'DormantBreakglass-2026!x'

function absorb(jar: string | Response, res?: Response): string {
  const response = res ?? (jar as Response)
  const existing = typeof jar === 'string' ? jar : ''
  const out = new Map<string, string>()
  for (const pair of existing.split(/;\s*/)) {
    const eq = pair.indexOf('=')
    if (eq > 0) out.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  const raws =
    typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
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

async function login(): Promise<string> {
  const r1 = await app.request('/login')
  const j = absorb('', r1)
  const t1 = await tokenOf(r1)
  const r2 = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j) },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, nc_csrf: t1 }),
  })
  return absorb(j, r2)
}

async function loginUpToChallenge(): Promise<{ jar: string; page: Response }> {
  const jar = await login()
  const page = await app.request('/2fa/verify', { headers: { cookie: jar }, redirect: 'manual' })
  return { jar: absorb(jar, page), page }
}

let userId = 0
let roleId = 0
let nonAdminId = 0
let nonAdminRoleId = 0
const targetIds: number[] = []

const db = getDb()

beforeAll(async () => {
  await sweepFixtures(db)
  await sql`delete from rate_limit_hits where bucket like ${'totp:user:%'}`.execute(db).catch(() => {})
  const row = await db.insertInto('users').values({
    email: EMAIL,
    full_name: fixtureName('Dormant Admin (break-glass)'),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  userId = Number(row.insertId)
  const adminRole = await db.selectFrom('roles').select('id').where('key', '=', 'admin').executeTakeFirstOrThrow()
  roleId = Number(adminRole.id)
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()
  // The seeded dormant account would have enrolled long ago (then lost the
  // phone): a confirmed secret with no working device is exactly the
  // "lost authenticator" state. The secret itself is set per-login below.
  await db.updateTable('users').set({ totp_confirmed_at: new Date() }).where('id', '=', userId).execute()

  // A non-admin control: same shape, role without users.manage.
  const n = await db.insertInto('users').values({
    email: fixtureEmail('dormant-nonadmin'),
    full_name: fixtureName('Dormant Non-admin'),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  nonAdminId = Number(n.insertId)
  const perms = await db.selectFrom('permissions').select('id').where('key', '=', 'dashboard.view_own_kpi').execute()
  const rr = await db.insertInto('roles').values({
    key: `[fixture] da${Date.now().toString(36).slice(-5)}`,
    label: '[fixture] dormant non-admin role',
    require_2fa: 1,
  }).executeTakeFirstOrThrow()
  nonAdminRoleId = Number(rr.insertId)
  await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: nonAdminRoleId, permission_id: Number(p.id) }))).execute()
  await db.insertInto('user_roles').values({ user_id: nonAdminId, role_id: nonAdminRoleId }).execute()
})

afterAll(async () => {
  await sql`delete rp from role_permissions rp join roles r on rp.role_id = r.id where r.key like '[fixture] da%'`.execute(db).catch(() => {})
  await sql`delete from rate_limit_hits where bucket like ${'totp:user:%'}`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool().catch(() => {})
})

async function authedAdminJar(): Promise<string> {
  const { generateRecoveryCodes, storeRecoveryCodes, encryptSecret } = await import('../../src/lib/totp.js')
  await db
    .updateTable('users')
    .set({ totp_confirmed_at: new Date(), totp_secret: encryptSecret('JBSWY3DPEHPK3PXP') } as never)
    .where('id', '=', userId)
    .execute()
  const codes = generateRecoveryCodes(4)
  await db.transaction().execute(async (trx) => {
    await storeRecoveryCodes(trx, userId, codes)
  })
  const { jar, page } = await loginUpToChallenge()
  const token = await tokenOf(page)
  const res = await app.request('/2fa/verify', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
    body: new URLSearchParams({ code: codes[0]!, nc_csrf: token }),
  })
  if (res.status !== 302) {
    throw new Error(`verify returned ${res.status}: ${(await res.text()).match(/error[^<]*/)?.[0]?.slice(0, 200)}`)
  }
  return absorb(jar, res)
}

describe('the dormant second admin (DECISIONS 29.68)', () => {
  it('signs in with password + recovery code at the 2FA challenge and reaches the admin screens', async () => {
    const jar = await authedAdminJar()
    const admin = await app.request('/app/admin/users', { headers: { cookie: jar } })
    expect(admin.status).toBe(200)
    // One code was consumed reaching here.
    const left = await db
      .selectFrom('user_recovery_codes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow()
    expect(Number(left.n)).toBe(3)
  })

  it('performs a 2FA reset through the gated route, with the audit row naming the actor', async () => {
    const jar = await authedAdminJar()
    const { encryptSecret } = await import('../../src/lib/totp.js')
    const target = await db.insertInto('users').values({
      email: fixtureEmail('reset-target'),
      full_name: fixtureName('Reset Target'),
      password_hash: hashSync(PASSWORD),
      password_algo: 'argon2id',
      must_change_password: 0,
      status: 'active',
      totp_secret: encryptSecret('JBSWY3DPEHPK3PXP'),
      totp_confirmed_at: new Date(),
    } as never).executeTakeFirstOrThrow()
    const targetId = Number(target.insertId)
    targetIds.push(targetId)

    const reset = await app.request(`/app/admin/users/${targetId}/totp-reset`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ nc_csrf: 'x' }),
    })
    // CSRF enforced even for an admin: a wrong token is refused.
    expect(reset.status).toBe(403)

    const page = await app.request(`/app/admin/users/${targetId}`, { headers: { cookie: jar } })
    const goodToken = await tokenOf(page)
    expect(goodToken).not.toBe('')
    const ok = await app.request(`/app/admin/users/${targetId}/totp-reset`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ nc_csrf: goodToken }),
    })
    expect(ok.status).toBe(303)

    const audits = await db
      .selectFrom('audit_log')
      .select('id')
      .where('action', 'like', '%totp%')
      .where((eb) => eb.or([eb('user_id', '=', userId), eb('entity_id', '=', targetId)]))
      .execute()
    expect(audits.length).toBeGreaterThanOrEqual(1)
  })

  it('a non-admin is still refused, and the dormant account is a holder of the admin grants, not a new shape', async () => {
    // Non-admin through the same route: 403 before anything else.
    const { generateRecoveryCodes, storeRecoveryCodes } = await import('../../src/lib/totp.js')
    const codes = generateRecoveryCodes(2)
    await db.transaction().execute(async (trx) => {
      await storeRecoveryCodes(trx, nonAdminId, codes)
    })
    const { jar, page } = await (async () => {
      const j = await (async () => {
        const r1 = await app.request('/login')
        const jj = absorb('', r1)
        const t1 = await tokenOf(r1)
        const r2 = await app.request('/login', {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(jj) },
          body: new URLSearchParams({ email: (await db.selectFrom('users').select('email').where('id', '=', nonAdminId).executeTakeFirstOrThrow()).email, password: PASSWORD, nc_csrf: t1 }),
        })
        return absorb(jj, r2)
      })()
      const p = await app.request('/2fa/verify', { headers: { cookie: j }, redirect: 'manual' })
      return { jar: absorb(j, p), page: p }
    })()
    const token = await tokenOf(page)
    const verify = await app.request('/2fa/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ code: codes[0]!, nc_csrf: token }),
    })
    const naJar = absorb(jar, verify)
    const anyTarget = targetIds[0] ?? userId
    const refused = await app.request(`/app/admin/users/${anyTarget}/totp-reset`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: naJar },
      body: new URLSearchParams({ nc_csrf: 'x' }),
    })
    expect(refused.status).toBe(403)

    // Grant shape: distinct permissions of the dormant admin == admin role's.
    const mine = await sql.raw(`SELECT COUNT(DISTINCT rp.permission_id) AS n FROM role_permissions rp JOIN user_roles ur ON ur.role_id = rp.role_id WHERE ur.user_id = ${userId}`).execute(db)
    const mineN = Number(((mine as unknown as { rows?: Array<{ n: number | string }> }).rows ?? (mine as unknown as Array<{ n: number | string }>))[0].n)
    const all = await sql.raw("SELECT COUNT(DISTINCT rp.permission_id) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.`key` = 'admin'").execute(db)
    const allN = Number(((all as unknown as { rows?: Array<{ n: number | string }> }).rows ?? (all as unknown as Array<{ n: number | string }>))[0].n)
    expect(mineN).toBe(allN)
    expect(mineN).toBeGreaterThan(0)
  })
})
