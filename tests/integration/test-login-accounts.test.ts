/**
 * Proves the TASK 0 seeded manual-test accounts through the real router
 * (DECISIONS 29.48): the non-2FA account posts /login and renders the
 * dashboard; the owner account (require_2fa = 1) is redirected to
 * /2fa/enrol. Credentials come from tests/integration/.test-login.env,
 * written by scripts/seed-test-login.mjs at seed time and gitignored.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sweepFixtures } from './fixture-markers.js'

const envText = readFileSync(new URL('./.test-login.env', import.meta.url), 'utf8')
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)

const LOGIN_EMAIL = 'test.login@neelachandra.dev'
const OWNER_EMAIL = 'test.owner@neelachandra.dev'

function cookieValues(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
  return raw.map((c) => c.split(';')[0]).join('; ')
}

async function login(email: string, password: string): Promise<Response> {
  // Same pair dance as login-flow.test.ts: GET the form for the pre-session
  // ncc_csrf cookie, echo the cookie and the nc_csrf field back on the POST.
  const page = await app.request('/login', { redirect: 'manual' })
  const setc = page.headers.get('set-cookie') ?? ''
  const csrfCookie = (setc.match(/ncc_csrf=([^;]+)/) ?? [])[1] ?? ''
  const token = (await page.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
  return app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ncc_csrf=${csrfCookie}` },
    body: new URLSearchParams({ nc_csrf: token, email, password }),
  })
}

const db = getDb()

beforeAll(async () => {
  // Reseed idempotently so the suite is self-sufficient. The sweep first so
  // the login lockout rows a previous run left cannot 429 this one.
  await sweepFixtures(db as never)
  const { execFileSync } = await import('node:child_process')
  execFileSync('node', ['scripts/seed-test-login.mjs', '--test-login'], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
  })
})

afterAll(async () => {
  await sweepFixtures(db as never)
  await closePool()
})

describe('the seeded manual-test accounts sign in through the real router (DECISIONS 29.48)', () => {
  it('the ops_manager account (require_2fa = 0) logs in and the dashboard renders', async () => {
    const res = await login(LOGIN_EMAIL, env.NCC_TEST_LOGIN_PASSWORD)
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toBe('/app')

    const dash = await app.request('/app', {
      redirect: 'manual',
      headers: { cookie: cookieValues(res) },
    })
    expect(dash.status).toBe(200)
    expect(await dash.text()).toContain('Dashboard')
  })

  it('the owner account (require_2fa = 1) is held at the 2FA enrolment path', async () => {
    const res = await login(OWNER_EMAIL, env.NCC_TEST_OWNER_PASSWORD)
    // POST /login itself redirects to /app (requireAuth owns the 2FA gate);
    // following the redirect is what lands on /2fa/enrol.
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/app')
    const dest = await app.request('/app', {
      redirect: 'manual',
      headers: { cookie: cookieValues(res) },
    })
    expect(dest.status).toBe(302)
    expect(dest.headers.get('location')).toBe('/2fa/enrol')
  })

  it('a wrong password for the seeded accounts is refused', async () => {
    const res = await login(LOGIN_EMAIL, 'definitely-not-the-password!1A')
    expect([401, 429]).toContain(res.status)
  })
})
