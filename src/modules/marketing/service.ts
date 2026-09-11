import { sql } from 'kysely'
import type { Db, Queryable, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { parseJsonColumn, toJsonText } from '../../lib/json.js'
import type { PageEditInput } from './schemas.js'

/**
 * Site page revisions (§7 / spec :1387, :1507, :1508).
 *
 * Spec :1387: "every publish snapshots the previous state". Spec :1507: the
 * publish route "Snapshots to `site_page_revisions`, sets `published_at`".
 * Spec :1508: the revert route "Restores a revision as a new draft".
 *
 * The slice stops where the spec routes stop. What it does not decide, and
 * refuses to decide, is the published-versus-draft question §7's prose never
 * answers: whether editing a published page happens on the live row or on a
 * draft copy, and whether rolling a published page back to an earlier
 * revision needs re-publication before visitors see it. :1508 says the
 * restore lands "as a new draft", which sets status = 'draft' — but whether
 * a draft of a previously published page is then invisible to the public
 * site, and what publishes it again, is nowhere stated. Building either
 * answer would be a guess; see DECISIONS 29.29.
 */

export interface Actor {
  userId: number
  ip: string | null
}

/** The page columns a revision snapshots (spec :1388-:1391). */
const SNAPSHOT_COLUMNS = ['id', 'title', 'meta_description', 'schema_types', 'content_json'] as const

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
export async function writeRevision(db: Trx, actor: Actor, pageId: number, changeNote: string | null): Promise<number> {
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
      meta_description: string | null
      schema_types: string | Record<string, unknown>
      content_json: string | Record<string, unknown>
    }
    const contentJsonText = assertJsonSafe(toJsonText(row.content_json) ?? '', 'content_json')
    const schemaTypesText = assertJsonSafe(toJsonText(row.schema_types) ?? '', 'schema_types')

    const revisionNo = await nextRevisionNo(db, pageId)
    const inserted = await db
      .insertInto('site_page_revisions')
      .values({
        page_id: pageId,
        revision_no: revisionNo,
        content_json: contentJsonText,
        title: row.title,
        meta_description: row.meta_description,
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
 * The edit path: snapshot the current row, then write the new values. One
 * transaction — the revision and the edit commit or roll back together, so
 * there is no window where the page changed with no revision holding its
 * previous state.
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

    // Snapshot the state about to be replaced (spec :1387), via the one
    // writer so no edit path can skip the revision.
    const revisionId = await writeRevision(trx, actor, pageId, input.changeNote ?? null)

    const schemaTypes = assertJsonSafe(JSON.stringify(input.schemaTypes), 'schema_types')
    const contentJson = assertJsonSafe(JSON.stringify(input.contentJson), 'content_json')
    await trx
      .updateTable('site_pages')
      .set({
        title: input.title,
        meta_description: input.metaDescription ?? null,
        schema_types: schemaTypes,
        content_json: contentJson,
      })
      .where('id', '=', pageId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'marketing.page_edit',
      entityType: 'site_page',
      entityId: pageId,
      after: { title: input.title },
      ip: actor.ip,
    })
    return { revisionId }
  })
}

/**
 * The revert path (spec :1508): restore a revision onto the live row, as a
 * new draft. The restore itself is audited; the snapshot of the state being
 * replaced happens first, so a revert is itself revisable.
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

    // The state being replaced is snapshotted first, per :1387 — "every
    // publish snapshots the previous state" read through :1508's revert.
    await writeRevision(trx, actor, pageId, `before revert to revision ${revisionNo}`)

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
        title: revision.title,
        meta_description: revision.meta_description,
        schema_types: JSON.stringify(schemaTypes),
        content_json: JSON.stringify(contentJson),
        status: 'draft',
        published_at: null,
        published_by: null,
      })
      .where('id', '=', pageId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'marketing.page_revert',
      entityType: 'site_page',
      entityId: pageId,
      after: { revision_no: revisionNo, status: 'draft' },
      ip: actor.ip,
    })
    return { revisionId: revisionNo }
  })
}
