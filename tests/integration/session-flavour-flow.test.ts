import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sweepFixtures, fixtureEmail } from './fixture-markers.js'
import { hashSync } from '@node-rs/argon2'
import { sha256Hex } from '../../src/lib/crypto.js'

/*
 * The two-flavour session through the real HTTP path (DECISIONS 34.1).
 *
 *   - A login whose roles include a field role (site_supervisor here, standing
 *     in for all of site_engineer / site_supervisor / qa_qc) creates a session
 *     with expires_at ~30 days out AND a cookie whose Max-Age is 30 days.
 *   - A login with only office roles (admin) creates the absolute 12-hour
 *     session and cookie.
 *   - When a staff session's expiry is pushed inside half-life, the very next
 *     authenticated request EXTENDS the row a full 30 days and REWRITES the
 *     cookie -- the sliding renewal the worker never notices.
 *
 * Fixtures: two users (staff, office), one role of each flavour. Swept by
 * high-water marks like the other integration suites.
 */

const db = getDb()

const TRACKED = ['users', 'roles', 'audit_log'] as const
const highWater = new Map<string, number>()

const STAFF_EMAIL = fixtureEmail('sess-staff')
const OFFICE_EMAIL = fixtureEmail('sess-office')
const PASSWORD = 'Session-Flavour-1!'
let staffUserId = 0
let officeUserId = 0
let staffRoleId = 0
let officeRoleId = 0
/** Role ids this suite itself created (system roles are left alone). */
const mintedRoleIds: number[] = []

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

function cookiesOf(res: Response): string[] {
  const get =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get('set-cookie') ?? '']
  return get.filter(Boolean)
}

async function tokenOf(res: Response): Promise<string> {
  return (await res.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
}

const stripSid = (j: string) => j.split('; ').filter((p) => !p.startsWith('ncc_sid=')).join('; ')

/* The session row a jar authenticates as, keyed by the SAME sha256(cookie
 * value) the server stores -- NOT "the newest row for this user". Two staff
 * logins land 30 days out in the same wall-clock second, so their expires_at
 * ties to the second; picking by `order by expires_at desc` can return the
 * OTHER session than the cookie carries, which ages a row the request never
 * uses and makes the renewal look broken when it is not (DECISIONS 34.2). */
const sessionIdOfJar = (jar: string): string =>
  sha256Hex(jar.match(/ncc_sid=([^;]+)/)?.[1] ?? '')

async function sessionById(id: string) {
  return db
    .selectFrom('user_sessions')
    .select(['id', 'expires_at'])
    .where('id', '=', id)
    .executeTakeFirst()
}

async function loginAs(email: string): Promise<{ jar: string; res: Response }> {
  const r1 = await app.request('/login')
  const j1 = absorb('', r1)
  const t1 = await tokenOf(r1)
  const r2 = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j1) },
    body: new URLSearchParams({ email, password: PASSWORD, nc_csrf: t1 }),
  })
  return { jar: absorb(j1, r2), res: r2 }
}

/* Expiry strings are Asia/Kolkata wall-clock (the app's one timezone).
 * Parsing them must use the +05:30 offset, not Z. */
const parseSql = (s: string): number => Date.parse(s.replace(' ', 'T') + '+05:30')

const daysFromNow = (d: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(Date.now() + d * 86_400_000)).replace(',', '').replace(/\b(\d{2})\b(?= \d)/, (h) => (h === '24' ? '00' : h))

async function sessionRow(userId: number) {
  return db
    .selectFrom('user_sessions')
    .select(['id', 'expires_at'])
    .where('user_id', '=', userId)
    .orderBy('expires_at', 'desc')
    .executeTakeFirst()
}

beforeAll(async () => {
  await sweepFixtures(db)

  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  // One staff role (site_supervisor) and one office role, both wired to the
  // dashboard-view permission so /app is reachable after login.
  const perm = await db
    .selectFrom('permissions')
    .select('id')
    .where('key', '=', 'dashboard.view_own_kpi')
    .executeTakeFirstOrThrow()

  for (const [key, label] of [
    ['site_supervisor', '[fixture] session staff'],
    ['admin', '[fixture] session office'],
  ] as const) {
    const existing = await db
      .selectFrom('roles')
      .select('id')
      .where('key', '=', key)
      .executeTakeFirst()
    if (existing) {
      if (key === 'site_supervisor') staffRoleId = Number(existing.id)
      else officeRoleId = Number(existing.id)
      continue
    }
    const created = await db
      .insertInto('roles')
      .values({ key, label, require_2fa: 0 })
      .executeTakeFirstOrThrow()
    const roleId = Number(created.insertId)
    mintedRoleIds.push(roleId)
    await db
      .insertInto('role_permissions')
      .values({ role_id: roleId, permission_id: Number(perm.id) })
      .execute()
    if (key === 'site_supervisor') staffRoleId = roleId
    else officeRoleId = roleId
  }

  for (const [email, roleId] of [
    [STAFF_EMAIL, staffRoleId],
    [OFFICE_EMAIL, officeRoleId],
  ] as const) {
    const user = await db
      .insertInto('users')
      .values({
        email,
        full_name: '[fixture] session flavour',
        password_hash: hashSync(PASSWORD),
        status: 'active',
        must_change_password: 0,
      })
      .executeTakeFirstOrThrow()
    const uid = Number(user.insertId)
    if (email === STAFF_EMAIL) staffUserId = uid
    else officeUserId = uid
    await db.insertInto('user_roles').values({ user_id: uid, role_id: roleId }).execute()
  }
})

afterAll(async () => {
  await sql`delete from user_sessions where user_id in (${staffUserId}, ${officeUserId})`.execute(db)
  await sql`delete from user_roles where user_id in (${staffUserId}, ${officeUserId})`.execute(db)
  await sql`delete from audit_log where user_id in (${staffUserId}, ${officeUserId})`.execute(db)
  await sql`delete from users where id in (${staffUserId}, ${officeUserId})`.execute(db)
  // roles/role_permissions are keyed on id; user_roles was handled above.
  // Roles created here are only deleted when they were NOT pre-existing
  // system rows -- track which ids we minted.
  for (const id of mintedRoleIds) {
    await sql`delete from role_permissions where role_id = ${id}`.execute(db)
    await sql`delete from roles where id = ${id}`.execute(db)
  }
  for (const table of ['users', 'audit_log'] as const) {
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
})

describe('the two session flavours (34.1)', () => {
  it('a site-role login gets a 30-day session AND a 30-day cookie', async () => {
    const { jar, res } = await loginAs(STAFF_EMAIL)
    expect(res.status).toBe(302)

    const cookie = cookiesOf(res).find((c) => c.startsWith('ncc_sid=')) ?? ''
    expect(cookie).toContain('Max-Age=' + 30 * 24 * 60 * 60)

    const row = await sessionRow(staffUserId)
    expect(row).toBeDefined()
    // expires_at is between 29 and 31 days out.
    const left = (parseSql(String(row!.expires_at)) - Date.now()) / 86_400_000
    expect(left).toBeGreaterThan(29)
    expect(left).toBeLessThan(31)
    expect(jar).toContain('ncc_sid=')
  })

  it('an office-role login gets the absolute 12-hour session and cookie', async () => {
    const { res } = await loginAs(OFFICE_EMAIL)
    expect(res.status).toBe(302)

    const cookie = cookiesOf(res).find((c) => c.startsWith('ncc_sid=')) ?? ''
    expect(cookie).toContain('Max-Age=' + 12 * 60 * 60)
    expect(cookie).not.toContain('Max-Age=' + 30 * 24 * 60 * 60)

    const row = await sessionRow(officeUserId)
    expect(row).toBeDefined()
    const leftMs = parseSql(String(row!.expires_at)) - Date.now()
    expect(leftMs).toBeGreaterThan(11 * 60 * 60 * 1000)
    expect(leftMs).toBeLessThanOrEqual(12 * 60 * 60 * 1000)
  })

  it('a staff session inside half-life is extended a full 30 days and the cookie is rewritten', async () => {
    // Log in, then age the row artificially to 2 days from expiry (well
    // inside half-life of 15 days) -- the same state 28 active days later.
    // Age the EXACT session this jar carries, found by its cookie hash: an
    // earlier staff login this suite made has an identical expires_at (same
    // second, 30 days out), so "newest row" is a coin-flip that can age the
    // wrong session and mask a working renewal (DECISIONS 34.2).
    const { jar } = await loginAs(STAFF_EMAIL)
    const sid = sessionIdOfJar(jar)
    const row = await sessionById(sid)
    expect(row, 'the jar must resolve to a live session row').toBeDefined()
    await db
      .updateTable('user_sessions')
      .set({ expires_at: daysFromNow(2) })
      .where('id', '=', row!.id)
      .execute()

    // Any authenticated request crosses the middleware.
    const r = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    expect([200, 302]).toContain(r.status)

    const after = await sessionById(sid)
    const left = (parseSql(String(after!.expires_at)) - Date.now()) / 86_400_000
    expect(left, 'the row must be pushed back out toward the full 30 days').toBeGreaterThan(29)

    // The renewal response rewrites the cookie with the new max-age.
    const rewritten = cookiesOf(r).find((c) => c.startsWith('ncc_sid='))
    expect(rewritten, 'the renewed session must rewrite the cookie').toBeDefined()
    expect(rewritten!).toContain('Max-Age=' + 30 * 24 * 60 * 60)
  })

  it('an office session is never extended, however stale it is', async () => {
    const { jar } = await loginAs(OFFICE_EMAIL)
    const row = await sessionRow(officeUserId)
    expect(row).toBeDefined()
    // 2 hours from expiry: past half of 12h. The office flavour is absolute,
    // so the middleware must NOT touch it.
    await db
      .updateTable('user_sessions')
      .set({ expires_at: daysFromNow(2 / 24) })
      .where('id', '=', row!.id)
      .execute()

    const before = await sessionRow(officeUserId)
    const r = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    expect([200, 302]).toContain(r.status)
    const after = await sessionRow(officeUserId)
    expect(String(after!.expires_at)).toBe(String(before!.expires_at))
  })
})
