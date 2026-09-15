import { Hono } from 'hono'
import type { AppEnv } from '../../types.js'
import { page, banner, okRedirect, errRedirect } from '../../dashboard/render.js'
import { Alert, KpiCard, Panel } from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { readBody } from '../../middleware/csrf.js'
import type { Context } from 'hono'
import { PERMISSIONS } from '../../lib/permissions.js'
import { currentUser } from '../../types.js'
import { NotFoundError, isAppError } from '../../lib/errors.js'
import * as svc from './service.js'
import { parseJsonStrict } from '../../lib/json.js'
import { pageEditSchema } from './schemas.js'

type Ctx = Context<AppEnv>

/** The §7 revision writer, mounted (DECISIONS 29.37). Edit writes draft
 * only; publish and revert are deliberate acts behind the publish permission.
 * Edit needs site_content.manage; publish/revert need marketing.content_publish
 * — a role holding edit but not publish cannot take the site live (:1359). */

/**
 * Marketing module routes.
 *
 * The schema, the permission keys and the navigation for this module are
 * complete and live. The transactional screens are the next build phase, so
 * every route below is mounted, guarded by the same permission its sidebar
 * item names, and reports the real row count from its primary table. That
 * preserves the invariant the navigation depends on: a link the user can see
 * is a link that neither 404s nor 403s.
 */

const marketing = new Hono<AppEnv>()

marketing.get('/app/marketing', requirePermission(PERMISSIONS.MARKETING_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('enquiries')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Marketing overview', path: '/app/marketing' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from enquiries" />
      </div>
      <Panel title="Marketing overview">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

marketing.get('/app/marketing/campaigns', requirePermission(PERMISSIONS.MARKETING_CAMPAIGN_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('campaigns')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Campaigns', path: '/app/marketing/campaigns' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from campaigns" />
      </div>
      <Panel title="Campaigns">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

marketing.get('/app/marketing/content', requirePermission(PERMISSIONS.SITE_CONTENT_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('site_pages')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Site content', path: '/app/marketing/content' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from site_pages" />
      </div>
      <Panel title="Site content">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

function actorOf(c: Ctx): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}

function idParam(c: Ctx, name = 'id'): number {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('Not found')
  return n
}

/** Same contract as crm's guard: AppError becomes a flash, anything else rethrown. */
async function guard(
  c: Ctx,
  back: string,
  run: () => Promise<string | { to: string; message: string }>
) {
  try {
    const out = await run()
    if (typeof out === 'string') return okRedirect(c, back, out)
    return okRedirect(c, out.to, out.message)
  } catch (err) {
    if (!isAppError(err)) throw err
    return errRedirect(c, back, err.message)
  }
}

async function requirePage(c: Ctx, id: number): Promise<void> {
  const db = c.get('db')
  const row = await db.selectFrom('site_pages').select('id').where('id', '=', id).executeTakeFirst()
  if (!row) throw new NotFoundError('That page does not exist.')
}

marketing.get('/app/marketing/content/:id/edit', requirePermission(PERMISSIONS.SITE_CONTENT_MANAGE), async (c) => {
  const id = idParam(c)
  await requirePage(c, id)
  const db = c.get('db')
  const row = await db
    .selectFrom('site_pages')
    .select(['id', 'title', 'draft_title', 'slug'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return page(
    c,
    { title: `Edit page: ${row.title}`, path: '/app/marketing/content' },
    <>
      {banner(c)}
      <Panel title={`Edit page: ${row.title}`}>
        <p class="ncc-muted">Edits save to the draft, never to the live site (spec §7).</p>
        <form method="post" action={`/app/marketing/content/${id}/edit`} class="ncc-stack">
          <label class="ncc-field"><span>Title *</span>
            <input name="title" type="text" required maxLength={200} value={row.draft_title ?? row.title} />
          </label>
          <label class="ncc-field"><span>Meta description</span>
            <input name="metaDescription" type="text" maxLength={320} />
          </label>
          <label class="ncc-field"><span>Schema types (comma separated) *</span>
            <input name="schemaTypes" type="text" required placeholder="WebPage" />
          </label>
          <label class="ncc-field"><span>Content JSON *</span>
            <textarea name="contentJson" required rows={8}>{'{"blocks":[]}'}</textarea>
          </label>
          <label class="ncc-field"><span>Change note</span>
            <input name="changeNote" type="text" maxLength={255} />
          </label>
          <button class="ncc-btn ncc-btn-primary" type="submit">Save draft</button>
        </form>
      </Panel>
    </>
  )
})

marketing.post('/app/marketing/content/:id/edit', requirePermission(PERMISSIONS.SITE_CONTENT_MANAGE), async (c) => {
  const id = idParam(c)
  const body = await readBody(c)
  const raw = body as Record<string, unknown>
  let schemaTypes: unknown = []
  try {
    schemaTypes = String(raw.schemaTypes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const parsedContent = parseJsonStrict(String(raw.contentJson ?? '{}'))
    const parsed = pageEditSchema.safeParse({
      title: raw.title,
      metaDescription: raw.metaDescription || undefined,
      schemaTypes,
      contentJson: parsedContent,
      changeNote: raw.changeNote || undefined,
    })
    if (!parsed.success) {
      return errRedirect(c, `/app/marketing/content/${id}/edit`, 'Check the form: a title, at least one schema type and {"blocks":[]} content are required.')
    }
    return guard(c, `/app/marketing/content/${id}/edit`, async () => {
      await svc.editPage(c.get('db'), actorOf(c), id, parsed.data)
      return { to: '/app/marketing/content', message: 'Draft saved. The live site is unchanged until you publish.' }
    })
  } catch (err) {
    if (err instanceof SyntaxError) {
      return errRedirect(c, `/app/marketing/content/${id}/edit`, 'Content is not valid JSON.')
    }
    throw err
  }
})

marketing.post('/app/marketing/content/:id/publish', requirePermission(PERMISSIONS.MARKETING_CONTENT_PUBLISH), async (c) => {
  const id = idParam(c)
  return guard(c, '/app/marketing/content', async () => {
    await svc.publishPage(c.get('db'), actorOf(c), id)
    return { to: '/app/marketing/content', message: 'Published. The draft is now the live page.' }
  })
})

marketing.post('/app/marketing/content/:id/revert/:revisionNo', requirePermission(PERMISSIONS.MARKETING_CONTENT_PUBLISH), async (c) => {
  const id = idParam(c)
  const revisionNo = idParam(c, 'revisionNo')
  return guard(c, '/app/marketing/content', async () => {
    await svc.revertToRevision(c.get('db'), actorOf(c), id, revisionNo)
    return { to: '/app/marketing/content', message: `Revision ${revisionNo} restored as the draft. Publish to take it live.` }
  })
})

export default marketing
