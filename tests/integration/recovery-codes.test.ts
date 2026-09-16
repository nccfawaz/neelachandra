import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'
import { hashSync } from '@node-rs/argon2'
import { authenticator } from 'otplib'
import { decryptSecret, generateRecoveryCodes } from '../../src/lib/totp.js'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * The recovery-code lifecycle (DECISIONS 29.46).
 *
 * Issuance, display-once, consumption, decrement — proven through the real
 * router for the flow, and through the service for the last-code case the
 * router cannot easily reach (consuming the final code would need a
 * committed enrolment whose codes we know; instead the service-level
 * consumption of the last code is driven directly and the count + the
 * account screen's "0 of 10" read are asserted).
 *
 * What the UI says (proven by rendering): the RecoveryCodesPage warns
 * "shown once and cannot be shown again. Each one works a single time.
 * Print them or put them in a password manager now." — and there is no
 * regeneration route anywhere in src/modules/auth (grep-verified; recorded
 * in 29.46 as the practical recovery gap).
 */

const db = getDb()
const EMAIL = fixtureEmail('recovery-flow')
const PASSWORD = 'Recovery-Test-Pass-1!'
let userId = 0
let roleId = 0

function absorb(jar: string | Response, res?: Response): string {
  // Accepts either (jar, response) or just a Response for the first call.
  const response = res ?? (jar as Response)
  const existing = typeof jar === 'string' ? jar : ''
  const out = new Map<string, string>()
  for (const pair of jar.split(/;\s*/)) {
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
  let j = absorb('', r1)
  const t1 = await tokenOf(r1)
  const r2 = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j) },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, nc_csrf: t1 }),
  })
  return absorb(j, r2)
}

beforeAll(async () => {
  await sweepFixtures(db)
  await sql`delete from rate_limit_hits where bucket like ${'totp:user:%'}`.execute(db).catch(() => {})
  const row = await db.insertInto('users').values({
    email: EMAIL,
    full_name: fixtureName('Recovery Flow User'),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
  }).executeTakeFirstOrThrow()
  userId = Number(row.insertId)
  await db.updateTable('users').set({ totp_confirmed_at: null, totp_secret: null }).where('id', '=', userId).execute()
  const perms = await db.selectFrom('permissions').select(['id', 'key']).where('key', '=', 'dashboard.view_own_kpi').execute()
  const rr = await db.insertInto('roles').values({
    key: `[fixture] rc${Date.now().toString(36).slice(-5)}`,
    label: '[fixture] recovery flow role',
    require_2fa: 1,
  }).executeTakeFirstOrThrow()
  roleId = Number(rr.insertId)
  await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))).execute()
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()
})

afterAll(async () => {
  await sql`delete rp from role_permissions rp join roles r on rp.role_id = r.id where r.label like '[fixture] recovery%'`.execute(db).catch(() => {})
  await sql`delete from roles where label like '[fixture] recovery%'`.execute(db).catch(() => {})
  await sql`delete from rate_limit_hits where bucket like ${'totp:user:%'}`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool().catch(() => {})
})

describe('the recovery-code lifecycle (29.46)', () => {
  it('issues ten codes, displayed exactly once, with the custody warning on the page', async () => {
    const jar = await login()
    const e = await app.request('/2fa/enrol', { headers: { cookie: jar }, redirect: 'manual' })
    const jar2 = absorb(jar, e)
    const et = await tokenOf(e)
    const secret = decryptSecret(
      (await db.selectFrom('users').select('totp_secret').where('id', '=', userId).executeTakeFirstOrThrow()).totp_secret as Buffer
    )
    const res = await app.request('/2fa/enrol', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar2 },
      body: new URLSearchParams({ code: authenticator.generate(secret), nc_csrf: et }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // Displayed once, with the instruction the user needs.
    expect(html).toContain('Save your recovery codes')
    expect(html).toContain('shown once and cannot be shown again')
    expect(html).toContain('Print them or put them in a password manager')
    expect((html.match(/<code>/g) ?? []).length).toBe(10)
    // The server cannot redisplay them: hashes only.
    const hashes = await db.selectFrom('user_recovery_codes').select('code_hash').where('user_id', '=', userId).execute()
    expect(hashes).toHaveLength(10)
    for (const h of hashes) expect(String(h.code_hash).startsWith('$argon2')).toBe(true)
  })

  it('no regeneration route exists anywhere in the app', async () => {
    // The practical recovery path for a lost authenticator would be
    // regeneration; its absence is the 29.46 finding. This tripwire fails
    // if someone adds a route touching recovery codes without updating
    // this record. The mount walk is the tripwire's own (29.35), not a
    // hand-written mirror.
    const routes = app.routes.flatMap((r) =>
      r.method !== 'ALL' ? [`${r.method.toUpperCase()} ${r.path.replace(/\/\//g, '/')}`] : []
    )
    const recoveryRoutes = routes.filter((r) => /recovery/i.test(r))
    expect(recoveryRoutes).toEqual([])
  })

  it('a code authenticates once, fails the second time, and the count decrements', async () => {
    // A fresh login is held at /2fa/verify; the recovery code is the way in.
    const jar = await login()
    const page = await app.request('/2fa/verify', { headers: { cookie: jar }, redirect: 'manual' })
    const jar2 = absorb(jar, page)
    const token = await tokenOf(page)

    // Pull one plaintext: codes are argon2-hashed, so the enrolment page is
    // the only source. Re-issue known codes at service level for this test
    // (the flow already proved the real issuance); store their hashes the
    // same way the service does and consume through verifyTotp's code path.
    const { storeRecoveryCodes } = await import('../../src/lib/totp.js')
    const { encryptSecret } = await import('../../src/lib/crypto.js')
    const codes = generateRecoveryCodes(10)
    await db.transaction().execute(async (trx) => {
      await storeRecoveryCodes(trx, userId, codes)
      // Mark the user's real secret confirmed so verifyTotp reaches the code
      // check: the enrolment test already proved the true path, this test
      // needs a known plaintext to spend.
      const row = await db.selectFrom('users').select('totp_secret').where('id', '=', userId).executeTakeFirstOrThrow()
      if (row.totp_secret === null) {
        await trx.updateTable('users').set({ totp_secret: encryptSecret('AAAAAAAAAAAAAAAA') }).where('id', '=', userId).execute()
      }
    })
    const before = await db
      .selectFrom('user_recovery_codes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow()
    expect(Number(before.n)).toBe(10)

    // First use: accepted, session upgraded, count drops to 9.
    const res = await app.request('/2fa/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar2 },
      body: new URLSearchParams({ code: codes[0]!, nc_csrf: token }),
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/app')
    const after = await db
      .selectFrom('user_recovery_codes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow()
    expect(Number(after.n)).toBe(9)

    // Second use of the SAME code: refused — consumed is consumed.
    const ok = await login()
    const page2 = await app.request('/2fa/verify', { headers: { cookie: ok }, redirect: 'manual' })
    const jar3 = absorb(ok, page2)
    const token2 = await tokenOf(page2)
    const replay = await app.request('/2fa/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar3 },
      body: new URLSearchParams({ code: codes[0]!, nc_csrf: token2 }),
    })
    expect(replay.status).toBe(422)
    expect(await replay.text()).toContain('That code is not correct')
    const stillNine = await db
      .selectFrom('user_recovery_codes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow()
    expect(Number(stillNine.n)).toBe(9)
  })

  it('the account screen shows the remaining count, so running out is visible before it happens', async () => {
    const { storeRecoveryCodes } = await import('../../src/lib/totp.js')
    const codes = generateRecoveryCodes(10)
    await db.transaction().execute(async (trx) => {
      await storeRecoveryCodes(trx, userId, codes)
    })
    // Consume all but one through the service directly (the consumption
    // transaction is what the route runs), then read the count off the
    // account screen the way the user would.
    const { consumeRecoveryCode } = await import('../../src/lib/totp.js')
    for (const code of codes.slice(0, 9)) {
      await db.transaction().execute(async (trx) => {
        await consumeRecoveryCode(trx, userId, code)
      })
    }
    const left = await db
      .selectFrom('user_recovery_codes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow()
    expect(Number(left.n)).toBe(1)

    // The account screen renders "Unused recovery codes: 1 of 10" — the
    // warning that precedes any last-code consumption.
    let jar = await login()
    const page = await app.request('/2fa/verify', { headers: { cookie: jar }, redirect: 'manual' })
    jar = absorb(jar, page)
    const token = await tokenOf(page)
    const last = await app.request('/2fa/verify', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ code: codes[9]!, nc_csrf: token }),
    })
    expect(last.status).toBe(302)
    jar = absorb(jar, last)
    const account = await app.request('/app/account/sessions', { headers: { cookie: jar }, redirect: 'manual' })
    expect(account.status).toBe(200)
    const html = await account.text()
    expect(html).toContain('Unused recovery codes: 0 of 10')
  })
})
