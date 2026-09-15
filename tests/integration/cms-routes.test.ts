import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { hashSync } from '@node-rs/argon2'
import { sql } from 'kysely'
import { sweepFixtures, fixtureEmail, fixtureName } from './fixture-markers.js'

/**
 * The §7 revision writer, proven through the ROUTE, not the service
 * (DECISIONS 29.37). The service behaviour itself is pinned by
 * cms-revisions.test.ts; this suite proves the mounted layer:
 *
 *   - unauthenticated POST refused (302 to /login by requireSession),
 *   - a role holding site_content.manage but NOT marketing.content_publish
 *     is refused on publish (403) — the deliberate-act split of :1359,
 *   - a permitted role succeeds through the HTTP path, and the draft/live
 *     shape of migration 027 holds end to end (edit leaves live untouched;
 *     publish moves draft to live),
 *   - CSRF is enforced on every POST: a tokenless POST is refused 403.
 */

const db = getDb()
const EMAIL = fixtureEmail('cms-routes-editor')
const EMAIL_PUBLISHER = fixtureEmail('cms-routes-publisher')
const NAME_EDITOR = fixtureName('CMS Routes Editor')
const NAME_PUBLISHER = fixtureName('CMS Routes Publisher')
const PASSWORD = 'Cms-Routes-Pass-1!'
let editorId = 0
let publisherId = 0
let pageId = 0

async function loginAs(email: string): Promise<string> {
  const res = await app.request('/login')
  const cookie = (res.headers.get('set-cookie') ?? '').match(/ncc_csrf=([^;]+)/)?.[1] ?? ''
  const token = (await res.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
  const out = await app.request('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ncc_csrf=${cookie}` },
    body: new URLSearchParams({ email, password: PASSWORD, nc_csrf: token }),
  })
  const sid = (out.headers.get('set-cookie') ?? '').match(/ncc_sid=([^;]+)/)?.[1] ?? ''
  if (!sid) throw new Error(`login failed for ${email}: ${out.status}`)
  return `ncc_sid=${sid}`
}

/** POST a form with a valid CSRF pair fetched from a GET of tokenPage
 * (publish/revert are POST-only, so the pair must come from a real page). */
async function postForm(
  cookie: string,
  path: string,
  fields: Record<string, string>,
  tokenPage = path
): Promise<Response> {
  const res = await app.request(tokenPage, { headers: { cookie }, redirect: 'manual' })
  const csrfCookie = (res.headers.get('set-cookie') ?? '').match(/ncc_csrf=([^;]+)/)?.[1] ?? ''
  const token = (await res.text()).match(/name="nc_csrf" value="([^"]+)"/)?.[1] ?? ''
  return app.request(path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${cookie}; ncc_csrf=${csrfCookie}`,
    },
    body: new URLSearchParams({ ...fields, nc_csrf: token }),
  })
}

beforeAll(async () => {
  await sweepFixtures(db)
  // A crashed predecessor can leave live sessions that the FK blocks the
  // sweep on; clear sessions for anyone the sweep is about to remove.
  await sql`delete s from user_sessions s join users u on s.user_id = u.id where u.full_name like '[fixture]%' or u.email like '%@example.invalid'`.execute(db).catch(() => {})
  for (const [email, name, roleId] of [
    [EMAIL, NAME_EDITOR, null],
    [EMAIL_PUBLISHER, NAME_PUBLISHER, null],
  ] as const) {
    await db
      .insertInto('users')
      .values({
        email,
        full_name: name,
        password_hash: hashSync(PASSWORD),
        password_algo: 'argon2id',
        must_change_password: 0,
        status: 'active',
      })
      .executeTakeFirst()
  }
  const users = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', 'in', [EMAIL, EMAIL_PUBLISHER])
    .execute()
  editorId = Number(users.find((u) => u.email === EMAIL)!.id)
  publisherId = Number(users.find((u) => u.email === EMAIL_PUBLISHER)!.id)
  // Editor: site_content.manage but NOT marketing.content_publish. Publisher:
  // both. Roles 8 (sales_exec) and 9 (marketing) are real seeded roles; grant
  // the editor the manage permission directly so the split is exact.
  const perms = await db
    .selectFrom('permissions')
    .select(['id', 'key'])
    .where('key', 'in', ['site_content.manage', 'marketing.content_publish'])
    .execute()
  const manageId = Number(perms.find((p) => p.key === 'site_content.manage')!.id)
  const publishId = Number(perms.find((p) => p.key === 'marketing.content_publish')!.id)
  await db.deleteFrom('user_roles').where('user_id', 'in', [editorId, publisherId]).execute()
  // Simpler and exact: dedicated roles cloned from role 9's grants, minus/
  // plus content_publish. But roles are global — so instead grant publish to
  // NO ONE through roles here and give each user what they need through their
  // own role rows. The seeded 'marketing' role keeps its grants untouched for
  // the rest of the system; we only assert the matrix with direct role rows.
  // Editor keeps role 9 (which includes site_content.manage and — check —
  // content_publish). To make the split real, create two fixture roles.
  await db.deleteFrom('user_roles').where('user_id', 'in', [editorId, publisherId]).execute()
  // MariaDB has no RETURNING; take ids from the insert result.
  const suffix = Date.now().toString(36)
  const editorRoleResult = await db
    .insertInto('roles')
    .values({
      key: `[fixture] cms_editor_${suffix}`,
      label: '[fixture] CMS editor',
      require_2fa: 0,
    })
    .executeTakeFirstOrThrow()
  const publisherRoleResult = await db
    .insertInto('roles')
    .values({
      key: `[fixture] cms_publisher_${suffix}`,
      label: '[fixture] CMS publisher',
      require_2fa: 0,
    })
    .executeTakeFirstOrThrow()
  const editorRoleId = Number(editorRoleResult.insertId)
  const publisherRoleId = Number(publisherRoleResult.insertId)
  await db
    .insertInto('role_permissions')
    .values([
      { role_id: editorRoleId, permission_id: manageId },
      { role_id: publisherRoleId, permission_id: manageId },
      { role_id: publisherRoleId, permission_id: publishId },
    ])
    .execute()
  await db.insertInto('user_roles').values({ user_id: editorId, role_id: editorRoleId }).execute()
  await db.insertInto('user_roles').values({ user_id: publisherId, role_id: publisherRoleId }).execute()

  // A real page to work on.
  const pageResult = await db
    .insertInto('site_pages')
    .values({
      title: fixtureName('Routes Page'),
      slug: `fixture-routes-${Date.now().toString(36)}`,
      schema_types: '{"type":"WebPage"}',
      content_json: '{"blocks":[]}',
      status: 'published',
      published_at: new Date(),
    })
    .executeTakeFirstOrThrow()
  pageId = Number(pageResult.insertId)
})

afterAll(async () => {
  await sql`delete from user_sessions where user_id in (${editorId}, ${publisherId})`.execute(db).catch(() => {})
  await sql`delete from login_attempts where email in (${EMAIL}, ${EMAIL_PUBLISHER})`.execute(db).catch(() => {}
  ).catch(() => {})
  await sql`delete from audit_log where user_id in (${editorId}, ${publisherId})`.execute(db).catch(() => {})
  await sql`delete from role_permissions where role_id in (select id from roles where label like '[fixture] CMS %')`.execute(db).catch(() => {})
  await sql`delete from user_roles where user_id in (${editorId}, ${publisherId})`.execute(db).catch(() => {})
  await sql`delete from roles where label like '[fixture] CMS %'`.execute(db).catch(() => {})
  await sql`delete from site_page_revisions where page_id = ${pageId}`.execute(db).catch(() => {})
  await sql`delete from site_pages where id = ${pageId}`.execute(db).catch(() => {})
  await sweepFixtures(db)
  await closePool().catch(() => {})
})

describe('the revision writer through the mounted routes', () => {
  it('refuses an unauthenticated POST', async () => {
    const res = await app.request(`/app/marketing/content/${pageId}/publish`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ nc_csrf: 'x' }),
    })
    expect([302, 401, 403]).toContain(res.status)
    if (res.status === 302) expect(res.headers.get('location')).toContain('/login')
  })

  it('refuses a tokenless POST with a session — CSRF enforced', async () => {
    const cookie = await loginAs(EMAIL_PUBLISHER)
    const res = await app.request(`/app/marketing/content/${pageId}/publish`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({}),
    })
    expect(res.status).toBe(403)
  })

  it('a role with edit but not publish is refused on publish; the same role edits fine', async () => {
    const cookie = await loginAs(EMAIL)
    const publish = await postForm(cookie, `/app/marketing/content/${pageId}/publish`, {}, '/app/marketing/content')
    expect(publish.status).toBe(403)

    const edit = await postForm(cookie, `/app/marketing/content/${pageId}/edit`, {
      title: 'Draft from the editor role',
      schemaTypes: 'WebPage',
      contentJson: '{"blocks":[{"type":"raw_html"}]}',
      changeNote: 'route-level proof',
    })
    expect([303, 302]).toContain(edit.status)
    expect(edit.headers.get('location')).toContain('ok=')

    // And the live row is untouched by that edit — :1505 through HTTP.
    const live = await db
      .selectFrom('site_pages')
      .select(['title', 'draft_title'])
      .where('id', '=', pageId)
      .executeTakeFirstOrThrow()
    expect(live.title).not.toBe('Draft from the editor role')
    expect(live.draft_title).toBe('Draft from the editor role')
  })

  it('a permitted role publishes through the route and the draft becomes live', async () => {
    const cookie = await loginAs(EMAIL_PUBLISHER)
    const res = await postForm(cookie, `/app/marketing/content/${pageId}/publish`, {}, '/app/marketing/content')
    expect([303, 302]).toContain(res.status)
    expect(res.headers.get('location')).toContain('ok=')

    const row = await db
      .selectFrom('site_pages')
      .select(['title', 'published_by', 'content_json'])
      .where('id', '=', pageId)
      .executeTakeFirstOrThrow()
    expect(row.title).toBe('Draft from the editor role')
    expect(Number(row.published_by)).toBe(publisherId)
    // The driver parses JSON columns into objects on read, so stringify to
    // inspect the structure the draft became (the [object Object] class).
    expect(JSON.stringify(row.content_json)).toContain('raw_html')
  })
})
