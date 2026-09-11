import { sql } from 'kysely'
import type { Db, Queryable, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { parseJsonColumn, toJsonText } from '../../lib/json.js'
import type { PageEditInput } from './schemas.js'

/**
 * Site page revisions and the draft/live split (§7 / spec :1359, :1387,
 * :1505-:1508).
 *
 * Spec :1505: the block editor "Saves to `draft`, never to live". Spec
 * :1506: preview "renders the draft through the real public layout ... so
 * what is previewed is what publishes". Spec :1359: "publishing is a
 * deliberate act with a preview". So editPage writes ONLY the draft
 * columns (migration 027) — the live columns a visitor sees are untouched
 * until publishPage copies draft -> live through the deliberate publish
 * route (:1507), which snapshots the live row first (:1387).
 *
 * revertToRevision (:1508) "restores a revision as a new draft": it writes
 * the draft columns and leaves the live site stable until the operator
 * publishes. Whether a reverted published page is visitor-visible in the
 * meantime is OWNER_QUESTIONS item 17, still open — the refusal stands.
 */

export interface Actor {
  userId: number
  ip: string | null
}

/** The page columns a revision snapshots (spec :1388-:1391). */
const SNAPSHOT_COLUMNS = [
  'id',
  'title',
  'draft_title',
  'meta_description',
  'draft_meta_description',
  'schema_types',
  'draft_schema_types',
  'content_json',
  'draft_content_json',
] as const

/**
 * The next revision number for a page, inside the caller's transaction.
 * `uq_page_rev (page_id, revision_no)` (007:55) is the race guard: two
 * concurrent publishes pick the same max and one insert fails with a
 * duplicate-key error rather than silently overwriting.
 */
async function nextRevisionNo(db: Queryable, pageId: number): Promise<number> {
  const row = await db
    .selectFrom('site_page_revisions')
    .select((eb) => eb.fn.max<number>('revision_no').as('max_no'))
    .where('page_id', '=', pageId)
    .executeTakeFirst()
  return Number(row?.max_no ?? 0) + 1
}

function assertJsonSafe(value: string, column: string): string {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new UnprocessableError(`${column} cannot be empty: the live column is NOT NULL and a revision must stay restorable (DECISIONS 21.4)`)
  }
  return value
}


/**
 * The one writer of site_page_revisions. Called before any change to the
 * page row — edit or publish — so the revision always holds the state being
 * replaced, exactly as :1387 defines the snapshot. Never NULL in any
 * snapshotted column: the NOT NULL narrowing of migration 026 exists so the
 * revert route (:1508) can restore any revision, and a snapshot with a NULL
 * cell is a revision that cannot be restored.
 *
 * Takes the caller's transaction (the projects module's pattern, see
 * recalcProjectProgress): editPage and revertToRevision own the single
 * transaction, so the snapshot and the change it describes commit or roll
 * back together and no edit path can skip the revision.
 */
export async function writeRevision(
  db: Trx,
  actor: Actor,
  pageId: number,
  changeNote: string | null,
  preferDraft: boolean
): Promise<number> {
  const page = await db
    .selectFrom('site_pages')
    .select(SNAPSHOT_COLUMNS)
    .where('id', '=', pageId)
    .forUpdate()
    .executeTakeFirst()
  if (!page) throw new NotFoundError('Page not found')

  const row = page as unknown as {
    id: number
    title: string
    draft_title: string | null
    meta_description: string | null
    draft_meta_description: string | null
    schema_types: string | Record<string, unknown>
    draft_schema_types: string | Record<string, unknown> | null
    content_json: string | Record<string, unknown>
    draft_content_json: string | Record<string, unknown> | null
  }
  // When snapshotting a draft edit (:1505), the draft columns hold the
  // state being replaced; when snapshotting a publish (:1507), the live
  // columns do. Migration 026's NOT NULL narrowing applies either way.
  const title = preferDraft && row.draft_title != null ? row.draft_title : row.title
  const meta = preferDraft && row.draft_meta_description != null ? row.draft_meta_description : row.meta_description
  const schemaRaw =
    preferDraft && row.draft_schema_types != null ? row.draft_schema_types : row.schema_types
  const contentRaw =
    preferDraft && row.draft_content_json != null ? row.draft_content_json : row.content_json

  const contentJsonText = assertJsonSafe(toJsonText(contentRaw) ?? '', 'content_json')
  const schemaTypesText = assertJsonSafe(toJsonText(schemaRaw) ?? '', 'schema_types')

  const revisionNo = await nextRevisionNo(db, pageId)
  const inserted = await db
    .insertInto('site_page_revisions')
    .values({
      page_id: pageId,
      revision_no: revisionNo,
      content_json: contentJsonText,
      title,
      meta_description: meta,
      schema_types: schemaTypesText,
      changed_by: actor.userId,
      change_note: changeNote,
    })
    .executeTakeFirst()

  await writeAudit(db, {
    userId: actor.userId,
    action: 'marketing.page_revision_write',
    entityType: 'site_page',
    entityId: pageId,
    after: { revision_no: revisionNo, change_note: changeNote },
    ip: actor.ip,
  })
  return Number(inserted.insertId ?? 0)
}

/**
 * The edit path (spec :1505): "Saves to `draft`, never to live". The edit
 * writes ONLY the draft columns (migration 027); the live columns a
 * visitor sees are untouched, so editing a published page never changes
 * the public site. Snapshot the *draft state being replaced* (:1387) first,
 * in the same transaction.
 */
export async function editPage(
  db: Db,
  actor: Actor,
  pageId: number,
  input: PageEditInput
): Promise<{ revisionId: number }> {
  return await db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('site_pages')
      .select('id')
      .where('id', '=', pageId)
      .forUpdate()
      .executeTakeFirstOrThrow(() => new NotFoundError('Page not found'))

    // Snapshot the draft state about to be replaced (spec :1387), via the
    // one writer so no edit path can skip the revision. If no draft exists
    // yet, snapshot the live row — the state an edit of a never-edited
    // published page would replace.
    const hasDraft = await trx
      .selectFrom('site_pages')
      .select('draft_content_json')
      .where('id', '=', pageId)
      .executeTakeFirst()
    const revisionId = await writeRevision(
      trx,
      actor,
      pageId,
      input.changeNote ?? null,
      hasDraft?.draft_content_json != null
    )

    const schemaTypes = assertJsonSafe(JSON.stringify(input.schemaTypes), 'draft_schema_types')
    const contentJson = assertJsonSafe(JSON.stringify(input.contentJson), 'draft_content_json')
    await trx
      .updateTable('site_pages')
      .set({
        draft_title: input.title,
        draft_meta_description: input.metaDescription ?? null,
        draft_schema_types: schemaTypes,
        draft_content_json: contentJson,
      })
      .where('id', '=', pageId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'marketing.page_edit',
      entityType: 'site_page',
      entityId: pageId,
      after: { title: input.title, target: 'draft' },
      ip: actor.ip,
    })
    return { revisionId }
  })
}

/**
 * The publish path (spec :1507): snapshots the live row to
 * site_page_revisions (:1387 "every publish snapshots the previous state"),
 * then copies draft -> live and stamps published_at/published_by. Requires
 * a draft to exist; refuses otherwise. This is the deliberate act :1359
 * describes — the only writer of the live columns.
 */
export async function publishPage(
  db: Db,
  actor: Actor,
  pageId: number
): Promise<{ revisionId: number }> {
  return await db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('site_pages')
      .select('id')
      .where('id', '=', pageId)
      .forUpdate()
      .executeTakeFirstOrThrow(() => new NotFoundError('Page not found'))

    // :1387 — the LIVE state being replaced is what publish snapshots.
    const revisionId = await writeRevision(trx, actor, pageId, 'before publish', false)

    const draft = await trx
      .selectFrom('site_pages')
      .select(['draft_title', 'draft_meta_description', 'draft_schema_types', 'draft_content_json'])
      .where('id', '=', pageId)
      .executeTakeFirst()
    if (
      !draft ||
      draft.draft_title == null ||
      draft.draft_schema_types == null ||
      draft.draft_content_json == null
    ) {
      throw new UnprocessableError('Nothing to publish: no draft has been saved for this page')
    }

    await trx
      .updateTable('site_pages')
      .set({
        title: draft.draft_title,
        meta_description: draft.draft_meta_description,
        // The driver parses JSON columns into objects on read; the live
        // columns are written through the sanctioned encoder (DECISIONS
        // 29.28's [object Object] class).
        schema_types: assertJsonSafe(toJsonText(draft.draft_schema_types) ?? '', 'schema_types'),
        content_json: assertJsonSafe(toJsonText(draft.draft_content_json) ?? '', 'content_json'),
        status: 'published',
        published_at: new Date(),
        published_by: actor.userId,
      })
      .where('id', '=', pageId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'marketing.page_publish',
      entityType: 'site_page',
      entityId: pageId,
      after: { title: draft.draft_title, status: 'published' },
      ip: actor.ip,
    })
    return { revisionId }
  })
}

/**
 * The revert path (spec :1508): "Restores a revision as a new draft". The
 * revision's columns land in the DRAFT columns — the live site stays
 * exactly as it is until the operator publishes. (Whether a visitor should
 * see the revert immediately is OWNER_QUESTIONS item 17; the refusal
 * stands, and under this shape it cannot leak: live is untouched.)
 */
export async function revertToRevision(
  db: Db,
  actor: Actor,
  pageId: number,
  revisionNo: number
): Promise<{ revisionId: number }> {
  return await db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('site_pages')
      .select('id')
      .where('id', '=', pageId)
      .forUpdate()
      .executeTakeFirstOrThrow(() => new NotFoundError('Page not found'))

    // The state being replaced is the DRAFT (if any) — snapshotted first,
    // per :1387, so a revert is itself revisable.
    const hasDraft = await trx
      .selectFrom('site_pages')
      .select('draft_content_json')
      .where('id', '=', pageId)
      .executeTakeFirst()
    await writeRevision(
      trx,
      actor,
      pageId,
      `before revert to revision ${revisionNo}`,
      hasDraft?.draft_content_json != null
    )

    const revision = await trx
      .selectFrom('site_page_revisions')
      .select(['title', 'meta_description', 'schema_types', 'content_json'])
      .where('page_id', '=', pageId)
      .where('revision_no', '=', revisionNo)
      .executeTakeFirst()
    if (!revision) throw new NotFoundError(`Revision ${revisionNo} does not exist for this page`)

    // The NOT NULL guarantee of migration 026, at the point of use: every
    // snapshotted value must survive the driver's JSON parsing to reach the
    // NOT NULL live columns.
    const schemaTypes = parseJsonColumn(revision.schema_types as unknown)
    const contentJson = parseJsonColumn(revision.content_json as unknown)
    if (schemaTypes === null || contentJson === null) {
      throw new UnprocessableError(
        `Revision ${revisionNo} holds a NULL snapshot cell and cannot be restored — this shape is refused by migration 026 (DECISIONS 21.4)`
      )
    }

    await trx
      .updateTable('site_pages')
      .set({
        draft_title: revision.title,
        draft_meta_description: revision.meta_description,
        draft_schema_types: JSON.stringify(schemaTypes),
        draft_content_json: JSON.stringify(contentJson),
      })
      .where('id', '=', pageId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'marketing.page_revert',
      entityType: 'site_page',
      entityId: pageId,
      after: { revision_no: revisionNo, target: 'draft' },
      ip: actor.ip,
    })
    return { revisionId: revisionNo }
  })
}
