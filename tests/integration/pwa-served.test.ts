import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'
import { hashSync } from '@node-rs/argon2'

/*
 * The /app PWA pieces through the real router (DECISIONS 34.2).
 *
 *   - /assets/app-manifest.webmanifest is served with the manifest content
 *     type and carries standalone display, the brand theme and both icon
 *     sizes Chrome's installability check looks for.
 *   - /app-sw.js is served at the ROOT with Service-Worker-Allowed: / --
 *     without that header a worker script under any path may only claim a
 *     scope inside it, and the install prompt never appears.
 *   - The worker script itself caches nothing: its fetch handler is a pure
 *     network passthrough, so an attendance page can never be served stale.
 *   - The /app shell links the manifest and registers /app-sw.js.
 */

const EMAIL = fixtureEmail('pwa')
const PASSWORD = 'Pwa-Served-1!'
let userId = 0

const jarOf = (res: Response): string => {
  const raw =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get('set-cookie') ?? '']
  return raw.filter(Boolean).map((c) => c.split(';')[0]!).join('; ')
}

async function login(): Promise<string> {
  const r1 = await app.request('/login')
  const t1 = (await r1.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
  const r2 = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jarOf(r1) },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, nc_csrf: t1 }),
  })
  return jarOf(r2)
}

beforeAll(async () => {
  const db = getDb()
  await sweepFixtures(db as never)
  // The /app route needs at least one permission: the site_supervisor role
  // (already seeded by the migrations) carries dashboard.view_own_kpi.
  const role = await db
    .selectFrom('roles')
    .select('id')
    .where('key', '=', 'site_supervisor')
    .executeTakeFirst()
  const user = await db
    .insertInto('users')
    .values({
      email: EMAIL,
      full_name: fixtureName('Pwa User'),
      password_hash: hashSync(PASSWORD),
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirstOrThrow()
  userId = Number(user.insertId)
  if (role) {
    await db.insertInto('user_roles').values({ user_id: userId, role_id: Number(role.id) }).execute()
  }
})

afterAll(async () => {
  const db = getDb()
  await db.deleteFrom('audit_log').where('user_id', '=', userId).execute()
  await db.deleteFrom('user_sessions').where('user_id', '=', userId).execute()
  await db.deleteFrom('user_roles').where('user_id', '=', userId).execute()
  await db.deleteFrom('users').where('id', '=', userId).execute()
  await sweepFixtures(db as never)
  await closePool()
})

describe('the /app PWA is actually served (34.2)', () => {
  it('serves the manifest with the right content type, display, theme and icon sizes', async () => {
    const res = await app.request('/assets/app-manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('manifest+json')
    const m = (await res.json()) as Record<string, unknown>
    expect(m.display).toBe('standalone')
    expect(m.theme_color).toBe('#f48120')
    expect(m.start_url).toBe('/app')
    const icons = m.icons as Array<{ src: string; sizes: string; purpose?: string }>
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true)
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true)
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  it('serves both icon files', async () => {
    for (const p of ['/assets/icons/icon-192.png', '/assets/icons/icon-512.png']) {
      const res = await app.request(p)
      expect(res.status, p).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
    }
  })

  it('serves the service worker at the root with Service-Worker-Allowed: /', async () => {
    const res = await app.request('/app-sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('service-worker-allowed'), 'without this header the worker cannot claim / and the install prompt never appears').toBe('/')
    const body = await res.text()
    // The worker must have a fetch handler (installability) and must not
    // keep anything: no caches.put, no cache-first branches.
    expect(body).toContain("addEventListener('fetch'")
    expect(body).not.toContain('caches.put')
    expect(body).not.toContain('caches.match')
  })

  it('the /app shell links the manifest and registers /app-sw.js', async () => {
    const jar = await login()
    const page = await app.request('/app', { headers: { cookie: jar }, redirect: 'manual' })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('rel="manifest" href="/assets/app-manifest.webmanifest"')
    expect(html).toContain("navigator.serviceWorker.register('/app-sw.js'")
    expect(html).toContain('theme-color')
    expect(html).toContain('/assets/icons/icon-180.png')
  })
})
