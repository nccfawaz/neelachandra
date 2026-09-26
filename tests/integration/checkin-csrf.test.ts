import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sweepFixtures, fixtureEmail } from './fixture-markers.js'
import { hashSync } from '@node-rs/argon2'
import * as svc from '../../src/modules/hr/service.js'

/*
 * The check-in forms carry a valid CSRF token, and the POSTs succeed with it
 * (the production 403 on POST /app/attendance/checkin).
 *
 * The defect this pins: the panel's form rendered WITHOUT the nc_csrf hidden
 * field, so the browser posted nothing the CSRF guard could verify and the
 * guard refused with 403 before the handler ever ran. Every other dashboard
 * form (admin role-save, notifications, logout) embeds the token; this one
 * was missed because the panel is assembled in a helper that receives the
 * context but nobody threaded the session's token into it.
 *
 * What is proven here, through the real HTTP path:
 *
 *   - GET /app renders BOTH the check-in form and (when checked in) the
 *     check-out form, and each carries a non-empty nc_csrf value;
 *   - the token on the page is the session's own token: a POST with it
 *     succeeds (302 to /app), and the same POST without it is refused 403 —
 *     the exact production failure, held in place so it cannot return.
 *
 * Fixtures: one user linked to one employee, one site location with
 * coordinates. Check-in state is per-day and the fixture is swept by id
 * above the high-water marks.
 */

const db = getDb()

const TRACKED = ['attendance', 'employees', 'locations', 'users', 'user_roles', 'role_permissions', 'roles', 'audit_log'] as const

/* user_roles and role_permissions are composite-keyed — no id column — so
   their fixture rows are swept by user_id / role_id, not by high-water. */
const highWater = new Map<string, number>()

const EMAIL = fixtureEmail('checkin-csrf')
const PASSWORD = 'Checkin-Csrf-1!'
let userId = 0
let employeeId = 0
let siteId = 0
let officeId = 0
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

/** One employee row per user (uq_emp_user), so the failure-path tests reset
 *  today's attendance row between attempts instead of minting employees. */
async function resetTodayRow(): Promise<void> {
  await sql`delete from attendance where employee_id = ${employeeId}`.execute(db)
}

async function login(jar: string, email: string): Promise<string> {
  const r1 = await app.request('/login')
  let j = absorb(jar, r1)
  const t1 = await tokenOf(r1)
  const r2 = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: stripSid(j) },
    body: new URLSearchParams({ email, password: PASSWORD, nc_csrf: t1 }),
  })
  return absorb(j, r2)
}

beforeAll(async () => {
  await sweepFixtures(db)

  for (const table of TRACKED) {
    if (table === 'user_roles' || table === 'role_permissions') continue
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const role = await db
    .insertInto('roles')
    .values({
      key: `[fixture] ckcsrf${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`,
      label: '[fixture] check-in csrf',
      require_2fa: 0,
    })
    .executeTakeFirstOrThrow()
  roleId = Number(role.insertId)
  if (!Number.isInteger(roleId) || roleId < 1) {
    throw new Error(`fixture role insertId resolved to ${roleId}`)
  }

  const dashboardPerm = await db
    .selectFrom('permissions')
    .select('id')
    .where('key', '=', 'dashboard.view_own_kpi')
    .executeTakeFirstOrThrow()
  const permId = Number(dashboardPerm.id)
  if (!Number.isInteger(permId) || permId < 1) {
    throw new Error(`dashboard.view_own_kpi permission resolved to ${permId}`)
  }
  await db
    .insertInto('role_permissions')
    .values({ role_id: roleId, permission_id: permId })
    .execute()

  const user = await db
    .insertInto('users')
    .values({
      email: EMAIL,
      full_name: '[fixture] Check-in CSRF Worker',
      password_hash: hashSync(PASSWORD),
      password_algo: 'argon2id',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirstOrThrow()
  userId = Number(user.insertId)
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error(`fixture user insertId resolved to ${userId}`)
  }
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()

  const site = await db
    .insertInto('locations')
    .values({
      code: `FIXCK${Date.now().toString(36).slice(-4).toUpperCase()}`,
      name: '[fixture] check-in csrf site',
      location_type: 'site_store',
      latitude: '12.900000',
      longitude: '77.600000',
    })
    .executeTakeFirstOrThrow()
  siteId = Number(site.insertId)

  // The check-in site the tests resolve against: an OFFICE location (the
  // option source is office + projects, not the inventory list).
  await sql`delete from locations where code = 'FIXOFF-CS'`.execute(db)
  const office = await db
    .insertInto('locations')
    .values({
      code: 'FIXOFF-CS',
      name: '[fixture] check-in csrf office',
      location_type: 'office',
      latitude: '12.900000',
      longitude: '77.600000',
    })
    .executeTakeFirstOrThrow()
  officeId = Number(office.insertId)

  const emp = await db
    .insertInto('employees')
    .values({
      employee_code: `FIXCK-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      user_id: userId,
      full_name: '[fixture] Check-in CSRF Worker',
      employment_type: 'permanent',
      date_of_joining: '2026-01-01',
      status: 'active',
    })
    .executeTakeFirstOrThrow()
  employeeId = Number(emp.insertId)
  await db.updateTable('users').set({ employee_id: employeeId }).where('id', '=', userId).execute()
})

afterAll(async () => {
  // Detach children first: audit_log.user_id, user_sessions.user_id and
  // users.employee_id all reference rows that must go before their parents.
  await sql`delete from audit_log where user_id = ${userId}`.execute(db)
  await sql`delete from user_sessions where user_id = ${userId}`.execute(db)
  await sql`delete from user_roles where user_id = ${userId}`.execute(db)
  await sql`update users set employee_id = NULL where id = ${userId}`.execute(db)
  await sql`delete from attendance where employee_id = ${employeeId}`.execute(db)
  await sql`delete from employees where id = ${employeeId}`.execute(db)
  await sql`delete from locations where id = ${siteId}`.execute(db)
  for (const table of TRACKED) {
    if (table === 'employees' || table === 'locations' || table === 'attendance') continue
    if (table === 'user_roles') {
      if (userId > 0) await sql`delete from user_roles where user_id = ${userId}`.execute(db)
      continue
    }
    if (table === 'role_permissions') {
      if (roleId > 0) await sql`delete from role_permissions where role_id = ${roleId}`.execute(db)
      continue
    }
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
})

describe('the check-in forms carry a valid CSRF token', () => {
  it('GET /app renders the check-in form with a non-empty nc_csrf', async () => {
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    expect(page.status).toBe(200)
    const html = await page.text()

    expect(html).toContain('action="/app/attendance/checkin"')
    const form = html.slice(html.indexOf('action="/app/attendance/checkin"') - 400)
    const token = form.match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(token, 'the check-in form must embed the session CSRF token').not.toBe('')
  })

  it('POST check-in with the token succeeds; without it is refused 403 — the production defect', async () => {
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const html = await page.text()
    const token = html.match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(token).not.toBe('')

    const body = new URLSearchParams({ siteKey: 'office:' + officeId, lat: '12.9', lng: '77.6' })

    // WITHOUT the token: exactly the production failure.
    const refused = await app.request('/app/attendance/checkin', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: body.toString(),
    })
    expect(refused.status).toBe(403)

    // WITH the token: the guard passes and the check-in lands.
    const ok = await app.request('/app/attendance/checkin', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: body.toString() + `&nc_csrf=${encodeURIComponent(token)}`,
    })
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location') ?? '').toMatch(/^\/app\?loc=stored(&|$)/)

    const row = await db
      .selectFrom('attendance')
      .select(['checkin_at', 'checkin_far'])
      .where('employee_id', '=', employeeId)
      .executeTakeFirstOrThrow()
    expect(row.checkin_at).not.toBeNull()
    expect(Number(row.checkin_far)).toBe(0)
  })

  it('a post with EMPTY lat/lng (failed geolocation) stores NULL and the attendance stands — never 0,0', async () => {
    // The production defect: the panel shipped static hidden inputs with no
    // geolocation script, so every real post carried empty strings -- which
    // the first server stored as 0,0, a valid-looking on-site position in the
    // ocean. Empty now means unavailable: NULLs, attendance standing.
    await resetTodayRow()
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const html = await page.text()
    const token = html.match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(token).not.toBe('')

    const ok = await app.request('/app/attendance/checkin', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ siteKey: 'office:' + officeId, lat: '', lng: '', nc_csrf: token }).toString(),
    })
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location') ?? '').toContain('loc=unavailable')

    // The panel the redirect lands on states which of the two things
    // happened (31.13): no coordinate stored, attendance standing.
    const after = await app.request('/app?loc=unavailable', { headers: { cookie: jar } })
    expect(await after.text()).toContain('location unavailable')

    const row = await db
      .selectFrom('attendance')
      .select(['checkin_at', 'checkin_lat', 'checkin_lng', 'checkin_far'])
      .where('employee_id', '=', employeeId)
      .executeTakeFirstOrThrow()
    expect(row.checkin_at).not.toBeNull()
    expect(row.checkin_lat).toBeNull()
    expect(row.checkin_lng).toBeNull()
    expect(Number(row.checkin_far)).toBe(0)
  })

  it('a post with 0,0 also stores NULL — the Atlantic is not a site', async () => {
    await resetTodayRow()
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const html = await page.text()
    const token = html.match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''

    // 0,0 comes through the same route as a real reading would; the service
    // must refuse to store it as a coordinate.
    const ok = await app.request('/app/attendance/checkin', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ siteKey: 'office:' + officeId, lat: '0', lng: '0', nc_csrf: token }).toString(),
    })
    expect(ok.status).toBe(303)
    const row = await db
      .selectFrom('attendance')
      .select(['checkin_lat', 'checkin_lng', 'checkin_far'])
      .where('employee_id', '=', employeeId)
      .executeTakeFirstOrThrow()
    expect(row.checkin_lat).toBeNull()
    expect(row.checkin_lng).toBeNull()
    expect(Number(row.checkin_far)).toBe(0)
  })

  it('after check-in, the check-out form renders and POSTs with the token', async () => {
    await resetTodayRow()
    await svc.selfCheckIn(db, { userId, ip: '127.0.0.1' }, {
      employeeId,
      siteKey: `office:${officeId}`,
      reading: { lat: 12.9, lng: 77.6 },
    })
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const html = await page.text()

    expect(html).toContain('action="/app/attendance/checkin"')
    const token = html.match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
    expect(token).not.toBe('')

    // The rendered check-out form posts NO siteKey field: the site chosen at
    // check-in is stored on the attendance row and read back by the service.
    // This body is exactly what the real form submits.
    const ok = await app.request('/app/attendance/checkout', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({
        lat: '12.9054',
        lng: '77.6',
        nc_csrf: token,
      }).toString(),
    })
    expect(ok.status).toBe(303)

    const row = await db
      .selectFrom('attendance')
      .select(['checkout_at', 'checkout_far', 'checkin_far'])
      .where('employee_id', '=', employeeId)
      .executeTakeFirstOrThrow()
    expect(row.checkout_at).not.toBeNull()
    expect(Number(row.checkout_far)).toBe(1) // left the site by end of day
    expect(Number(row.checkin_far)).toBe(0) // the morning is untouched
  })
})

/*
 * The dashboard is the one screen every staff role lands on, and check-in/out
 * results 303 back to it with ?ok=/?error=. Three regressions guarded here:
 *
 *   1. The dropdown has NO preselected option: the first entry is an empty
 *      placeholder ("Choose a site…"), so a worker picks Office or Site
 *      deliberately. A plain press with nothing chosen submits siteKey='',
 *      which MUST be rejected (checkPostOf) -> the "Choose the site…" error.
 *   2. A deliberately chosen 'site' (the generic option, DECISIONS 36.1) MUST
 *      be ACCEPTED. checkPostOf once validated with /^(office|project):\d+$/,
 *      which rejected 'site' -> null -> the same error on a real choice.
 *   3. That error -- and every ?error= -- must RENDER on /app. /app once never
 *      called banner(), so the message travelled in the URL and appeared
 *      nowhere in the DOM: a silent failure on the only screen staff see. The
 *      assertion pins the message inside a visible ncc-alert--error (no
 *      display:none, and no max-width:768px rule hides it, so it shows at
 *      390x844 too). The real-browser proof that a defaults-only press lands
 *      on this visible error is tests/integration/checkin-real-press.test.ts.
 */
describe('the dashboard requires a deliberate site and shows its errors', () => {
  it('renders an empty placeholder first — nothing is preselected', async () => {
    // The dropdown only renders when there is no attendance row for today; a
    // checked-in/out worker sees the status line instead. Clear the day first.
    await resetTodayRow()
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const html = await page.text()
    // First option is the empty placeholder, marked selected; the real site
    // options carry non-empty values and none of THEM is selected. Hono
    // serialises the boolean attribute as selected="".
    expect(html).toMatch(/<select name="siteKey">\s*<option value="" selected(?:="")?>/)
    const select = html.match(/<select name="siteKey">([\s\S]*?)<\/select>/)?.[1] ?? ''
    expect(select, 'no non-empty option may be preselected').not.toMatch(/<option value="[^"]+"[^>]*selected/)
  })

  it("a plain post with no site chosen (siteKey='') is rejected — the placeholder path", async () => {
    await resetTodayRow()
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const token = (await page.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
    const res = await app.request('/app/attendance/checkin', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ siteKey: '', lat: '', lng: '', nc_csrf: token }).toString(),
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location') ?? '').toContain('error=Choose')
    // ...and nothing was checked in.
    const row = await db
      .selectFrom('attendance')
      .select(['checkin_at'])
      .where('employee_id', '=', employeeId)
      .executeTakeFirst()
    expect(row?.checkin_at ?? null).toBeNull()
  })

  it("a deliberately chosen siteKey='site' is accepted — the generic option (36.1)", async () => {
    await resetTodayRow()
    const jar = await login('', EMAIL)
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    const html = await page.text()
    // The generic 'site' option is offered for a deliberate pick.
    expect(html).toMatch(/<option value="site"/)
    const token = html.match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''

    const ok = await app.request('/app/attendance/checkin', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
      body: new URLSearchParams({ siteKey: 'site', lat: '', lng: '', nc_csrf: token }).toString(),
    })
    // Accepted: a success redirect, NOT /app?error=Choose the site...
    expect(ok.status).toBe(303)
    const loc = ok.headers.get('location') ?? ''
    expect(loc).not.toContain('error=')
    expect(loc).toMatch(/^\/app\?loc=/)

    const row = await db
      .selectFrom('attendance')
      .select(['checkin_at', 'checkin_site_key'])
      .where('employee_id', '=', employeeId)
      .executeTakeFirstOrThrow()
    expect(row.checkin_at).not.toBeNull()
    expect(row.checkin_site_key).toBe('site')
  })

  it('a ?error= on /app renders visibly in an error alert — no silent failure at 390x844', async () => {
    const jar = await login('', EMAIL)
    const message = 'Choose the site you are checking in at.'
    const res = await app.request(`/app?error=${encodeURIComponent(message)}`, {
      headers: { cookie: jar },
      redirect: 'manual',
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    // The message text is in the DOM (it was absent entirely before banner()).
    expect(html).toContain(message)
    // ...and inside the visible error alert component, role=alert for AT. The
    // served CSS gives .ncc-alert--error a background/colour and no
    // display:none, and there is no max-width:768px rule that hides it, so it
    // is visible at the 390-wide phone width, not merely present.
    const alert = html.match(/<div class="ncc-alert ncc-alert--error" role="alert">([\s\S]*?)<\/div>/)
    expect(alert, 'the error must render in an ncc-alert--error, not just sit in the URL').not.toBeNull()
    expect(alert![1]).toContain(message)
  })
})
