import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sql } from 'kysely'
import { hashSync } from '@node-rs/argon2'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'
import { encryptSecret } from '../../src/lib/totp.js'

/**
 * The admin two-factor reset through the HTTP path (DECISIONS 29.65).
 *
 * A lost authenticator is a recoverable incident, not a permanent lockout:
 * Fawaz (admin, users.manage) posts /app/admin/users/:id/totp-reset and the
 * target is un-enrolled. Proven here, per route:
 *
 *   - unauthenticated POST refused (the /app CSRF guard fires first);
 *   - a signed-in role WITHOUT users.manage refused 403;
 *   - a role WITH users.manage succeeds: totp_secret null, confirmed_at null;
 *   - CSRF enforced (a stale/absent token is 403);
 *   - the audit row lands with actor and target in one transaction;
 *   - every live session of the target dies with the reset;
 *   - self-reset refused even for a permitted admin.
 */

const db = getDb()
const PASSWORD = 'Reset-Test-Pass-1!'
const ADMIN_EMAIL = fixtureEmail('reset-admin')
const CLERK_EMAIL = fixtureEmail('reset-clerk')
const TARGET_EMAIL = fixtureEmail('reset-target')

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
  const page = await app.request('/app/admin/users', { headers: { cookie: jar }, redirect: 'manual' })
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
    key: `[fixture] tr${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`,
    label: `[fixture] ${label}`,
    require_2fa: 0,
  }).executeTakeFirstOrThrow()
  const roleId = Number(rr.insertId)
  if (perms.length) {
    await db.insertInto('role_permissions').values(perms.map((p) => ({ role_id: roleId, permission_id: Number(p.id) }))).execute()
  }
  return roleId
}

async function makeUser(email: string, roleId: number, enrolled: boolean): Promise<number> {
  const u = await db.insertInto('users').values({
    email,
    full_name: fixtureName(email.slice(8, 30)),
    password_hash: hashSync(PASSWORD),
    password_algo: 'argon2id',
    must_change_password: 0,
    status: 'active',
    totp_secret: enrolled ? encryptSecret('JBSWY3DPEHPK3PXP') : null,
    totp_confirmed_at: enrolled ? new Date() : null,
  }).executeTakeFirstOrThrow()
  const id = Number(u.insertId)
  await db.insertInto('user_roles').values({ user_id: id, role_id: roleId }).execute()
  return id
}

async function openSession(userId: number): Promise<void> {
  await db.insertInto('user_sessions').values({
    id: `fixture${userId}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.padEnd(64, '0').slice(0, 64),
    user_id: userId,
    csrf_token: 'fixture-csrf-token-value-0000000000000000000000000000000000000',
    totp_verified: 0,
    expires_at: new Date(Date.now() + 3_600_000),
  } as never).execute()
}

let adminId = 0
let clerkId = 0
let targetId = 0
let target2Id = 0

beforeAll(async () => {
  await sweepFixtures(db)
  const adminRole = await makeRole('reset admin', ['users.manage', 'dashboard.view_own_kpi'])
  const clerkRole = await makeRole('reset clerk', ['dashboard.view_own_kpi'])
  adminId = await makeUser(ADMIN_EMAIL, adminRole, true)
  clerkId = await makeUser(CLERK_EMAIL, clerkRole, false)
  targetId = await makeUser(TARGET_EMAIL, clerkRole, true)
  target2Id = await makeUser(fixtureEmail('reset-target2'), clerkRole, true)
  await openSession(targetId)
  await openSession(targetId)
})

afterAll(async () => {
  await sweepFixtures(db)
  await closePool()
})

const resetPath = (id: number) => `/app/admin/users/${id}/totp-reset`

describe('admin 2FA reset route', () => {
  it('refuses an unauthenticated POST before anything else', async () => {
    const res = await app.request(resetPath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ nc_csrf: 'x' }),
    })
    expect([302, 303, 403]).toContain(res.status)
    // The /app CSRF guard may answer 403 before requireAuth can redirect;
    // either way nothing was reset.
    const loc = res.headers.get('location') ?? ''
    if (loc) expect(loc).toContain('/login')
  })

  it('refuses a signed-in role without users.manage with 403', async () => {
    const jar = await login('', CLERK_EMAIL)
    const res = await post(jar, resetPath(targetId), {})
    expect(res.status).toBe(403)
  })

  it('enforces CSRF: a tokenless POST from a signed-in admin is 403', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await app.request(resetPath(targetId), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({}),
    })
    expect(res.status).toBe(403)
  })

  it('lets a users.manage holder reset: secret cleared, audit row written, sessions dead', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, resetPath(targetId), {})
    expect(res.status).toBe(303)

    const user = await db.selectFrom('users').select(['totp_secret', 'totp_confirmed_at']).where('id', '=', targetId).executeTakeFirstOrThrow()
    expect(user.totp_secret).toBeNull()
    expect(user.totp_confirmed_at).toBeNull()

    const audit = await db
      .selectFrom('audit_log')
      .select(['user_id', 'entity_id', 'action'])
      .where('action', '=', 'user.totp_reset')
      .where('entity_id', '=', targetId)
      .orderBy('id', 'desc')
      .executeTakeFirst()
    expect(audit).toBeDefined()
    expect(Number(audit!.user_id)).toBe(adminId)

    const sessions = await db
      .selectFrom('user_sessions')
      .select('id')
      .where('user_id', '=', targetId)
      .execute()
    expect(sessions.length).toBe(0)
  })

  it('refuses a permitted admin resetting their OWN two factor', async () => {
    const jar = await login('', ADMIN_EMAIL)
    const res = await post(jar, resetPath(adminId), {})
    // The service throws BadRequestError: resetting your own 2FA skips the
    // challenge it exists to enforce. The error handler renders the generic
    // 400 page (the named reason goes to the log, not the page), so assert
    // the status and that nothing changed.
    expect(res.status).toBe(400)
    const user = await db.selectFrom('users').select(['totp_secret', 'totp_confirmed_at']).where('id', '=', adminId).executeTakeFirstOrThrow()
    expect(user.totp_secret).not.toBeNull()
    expect(user.totp_confirmed_at).not.toBeNull()
    const audit = await db.selectFrom('audit_log').select('id').where('action', '=', 'user.totp_reset').where('entity_id', '=', adminId).execute()
    expect(audit.length).toBe(0)
  })
})
