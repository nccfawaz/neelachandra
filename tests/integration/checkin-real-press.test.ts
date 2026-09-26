import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sweepFixtures, fixtureEmail } from './fixture-markers.js'
import { hashSync } from '@node-rs/argon2'

/*
 * The check-in as a phone actually performs it: the REAL /app page, served by
 * the REAL app over HTTP, driven by REAL Chromium, pressing the REAL button
 * with the form's OWN default values. Nothing here hand-builds a POST body.
 *
 * Why this gate exists (the standing instruction it answers): a run of check-in
 * defects survived tests that posted `new URLSearchParams({ siteKey: 'office:'
 * + id, ... })` -- a payload the author wrote to match what the handler wanted,
 * not what the form sends. The dropdown default, the field names, the
 * serialization, the redirect and whether the error is even visible were all
 * assumed. Here the browser serializes the real <form> and follows the real
 * 303, so the assertion is about the product a worker touches:
 *
 *   1. DEFAULTS ONLY. Log in, land on /app, press "Check in" WITHOUT opening
 *      the dropdown. The placeholder is selected, so the browser submits
 *      siteKey='' -- and the page that comes back shows the VISIBLE error
 *      "Choose the site you are checking in at." No attendance row is created.
 *      This is the silent-failure regression, held shut end to end.
 *   2. DELIBERATE CHOICE. Pick "Site" in the real dropdown, press the button,
 *      and the check-in lands (303 to /app?loc=..., a row with
 *      checkin_site_key='site'). Proves the route accepts the generic option
 *      the UI offers.
 *
 * Geolocation is never granted to the context, so the real checkin-geo.js takes
 * its denial branch and submits with empty lat/lng -- attendance is never
 * refused on location (DECISIONS 31.1), and the site choice is what this gate
 * is about. A no-JS fallback would submit the same empty siteKey by the plain
 * form post, so the gate holds even if the asset never loads.
 *
 * Lives in the integration suite because it needs the real database and the
 * real app; per-test timeouts are raised for a cold Chromium launch the way
 * vitest.e2e.config.ts does.
 */

const db = getDb()

const TRACKED = ['attendance', 'employees', 'locations', 'users', 'user_roles', 'role_permissions', 'roles', 'audit_log'] as const
const highWater = new Map<string, number>()

const EMAIL = fixtureEmail('checkin-press')
const PASSWORD = 'Checkin-Press-1!'
let userId = 0
let employeeId = 0
let officeId = 0
let roleId = 0
let mintedRole = false

let browser: Browser
let server: Server
let origin = ''

const LAUNCH = 30_000

async function resetTodayRow(): Promise<void> {
  await sql`delete from attendance where employee_id = ${employeeId}`.execute(db)
}

beforeAll(async () => {
  await sweepFixtures(db)
  for (const table of TRACKED) {
    if (table === 'user_roles' || table === 'role_permissions') continue
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const perm = await db
    .selectFrom('permissions')
    .select('id')
    .where('key', '=', 'dashboard.view_own_kpi')
    .executeTakeFirstOrThrow()

  // A staff role so the login gets a session that can reach /app. Reuse the
  // system site_supervisor row if it exists; only delete a role this suite
  // itself minted.
  const existing = await db.selectFrom('roles').select('id').where('key', '=', 'site_supervisor').executeTakeFirst()
  if (existing) {
    roleId = Number(existing.id)
  } else {
    const r = await db
      .insertInto('roles')
      .values({ key: 'site_supervisor', label: '[fixture] press staff', require_2fa: 0 })
      .executeTakeFirstOrThrow()
    roleId = Number(r.insertId)
    mintedRole = true
    await db.insertInto('role_permissions').values({ role_id: roleId, permission_id: Number(perm.id) }).execute()
  }

  const user = await db
    .insertInto('users')
    .values({
      email: EMAIL,
      full_name: '[fixture] Check-in Press Worker',
      password_hash: hashSync(PASSWORD),
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirstOrThrow()
  userId = Number(user.insertId)
  await db.insertInto('user_roles').values({ user_id: userId, role_id: roleId }).execute()

  const emp = await db
    .insertInto('employees')
    .values({
      employee_code: `FIXPR-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      user_id: userId,
      full_name: '[fixture] Check-in Press Worker',
      employment_type: 'permanent',
      date_of_joining: '2026-01-01',
      status: 'active',
    })
    .executeTakeFirstOrThrow()
  employeeId = Number(emp.insertId)
  await db.updateTable('users').set({ employee_id: employeeId }).where('id', '=', userId).execute()

  await sql`delete from locations where code = 'FIXOFF-PR'`.execute(db)
  const office = await db
    .insertInto('locations')
    .values({
      code: 'FIXOFF-PR',
      name: '[fixture] press office',
      location_type: 'office',
      latitude: '12.900000',
      longitude: '77.600000',
    })
    .executeTakeFirstOrThrow()
  officeId = Number(office.insertId)

  // The REAL app over a real port, and a real browser.
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as unknown as Server
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  origin = `http://127.0.0.1:${port}`
  browser = await chromium.launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))

  await sql`delete from audit_log where user_id = ${userId}`.execute(db)
  await sql`delete from user_sessions where user_id = ${userId}`.execute(db)
  await sql`delete from user_roles where user_id = ${userId}`.execute(db)
  await sql`update users set employee_id = NULL where id = ${userId}`.execute(db)
  await sql`delete from attendance where employee_id = ${employeeId}`.execute(db)
  await sql`delete from audit_log where entity_type = 'employee' and entity_id = ${employeeId}`.execute(db)
  await sql`delete from employees where id = ${employeeId}`.execute(db)
  await sql`delete from users where id = ${userId}`.execute(db)
  await sql`delete from locations where id = ${officeId}`.execute(db)
  if (mintedRole && roleId) {
    await sql`delete from role_permissions where role_id = ${roleId}`.execute(db)
    await sql`delete from roles where id = ${roleId}`.execute(db)
  }
  for (const table of ['users', 'audit_log'] as const) {
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
}, 60_000)

/**
 * Log in through the REAL browser form and land on /app. Playwright carries
 * the pre-session CSRF cookie and the session cookie itself, so this is the
 * exact handshake a phone performs -- no cookie or token is hand-set.
 */
async function loginToApp(): Promise<import('playwright').Page> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    // Geolocation is never granted: the real checkin-geo.js takes its denial
    // branch and submits with empty lat/lng (DECISIONS 31.1). The site choice,
    // not the position, is what this gate is about.
  })
  const page = await context.newPage()
  await page.goto(`${origin}/login`)
  await page.fill('input[name="email"]', EMAIL)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([page.waitForURL('**/app'), page.click('button[type="submit"]')])
  return page
}

describe('the real check-in button, pressed on the real page', () => {
  it('with the placeholder default (no site chosen) comes back with the VISIBLE error and creates no row', async () => {
    await resetTodayRow()
    const page = await loginToApp()
    try {
      // The dropdown is untouched, so its placeholder (siteKey='') is what the
      // browser serializes. Press the real button and follow the real 303.
      await page.waitForSelector('button.ncc-checkin-btn')
      await Promise.all([page.waitForNavigation(), page.click('button.ncc-checkin-btn')])

      // The flash banner on /app must SHOW the error -- this is the silent
      // failure regression, held shut through the rendered page. vitest's
      // expect has no Playwright matchers, so visibility is proven by
      // waitForSelector({ state: 'visible' }) and read back explicitly.
      await page.waitForSelector('.ncc-alert--error[role="alert"]', { state: 'visible' })
      const alert = page.locator('.ncc-alert--error[role="alert"]')
      expect(await alert.isVisible()).toBe(true)
      expect(await alert.textContent()).toContain('Choose the site you are checking in at.')

      const row = await db
        .selectFrom('attendance')
        .select('id')
        .where('employee_id', '=', employeeId)
        .executeTakeFirst()
      expect(row).toBeUndefined()
    } finally {
      await page.context().close()
    }
  }, LAUNCH)

  it("with a deliberate 'site' choice lands the check-in (303 to /app?loc=, row with checkin_site_key='site')", async () => {
    await resetTodayRow()
    const page = await loginToApp()
    try {
      await page.waitForSelector('select[name="siteKey"]')
      await page.selectOption('select[name="siteKey"]', 'site')
      await Promise.all([page.waitForNavigation(), page.click('button.ncc-checkin-btn')])

      // Landed, not rejected: the URL carries ?loc= and no ?error=.
      const url = new URL(page.url())
      expect(url.pathname).toBe('/app')
      expect(url.searchParams.has('loc')).toBe(true)
      expect(url.searchParams.has('error')).toBe(false)

      const row = await db
        .selectFrom('attendance')
        .select(['id', 'checkin_site_key'])
        .where('employee_id', '=', employeeId)
        .executeTakeFirstOrThrow()
      expect(String(row.checkin_site_key)).toBe('site')
    } finally {
      await page.context().close()
    }
  }, LAUNCH)
})
