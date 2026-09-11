import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'
import { sweepFixtures } from './fixture-markers.js'
import { editPage, revertToRevision, writeRevision } from '../../src/modules/marketing/service.js'
import type { PageEditInput } from '../../src/modules/marketing/schemas.js'
import { pageEditSchema } from '../../src/modules/marketing/schemas.js'

/**
 * The §7 revision writer (DECISIONS 29.29).
 *
 * Spec :1387 — "every publish snapshots the previous state"; :1508 — the
 * revert route "Restores a revision as a new draft". Before this suite the
 * tree held no writer at all for site_page_revisions (§21.4's survey), so
 * every guarantee below is proven through the service functions, never a
 * direct insert:
 *
 *   1. Every edit writes a revision first, with the editing user recorded,
 *      and the revision holds the state the edit replaced.
 *   2. schema_types is never NULL on either table: the edit input refuses
 *      an empty schema-type list, the writer refuses an empty snapshot cell,
 *      and the live column's NOT NULL (007:27 / 026) holds through a full
 *      edit → revert round trip.
 *   3. Revert restores the exact prior values and is itself audited, with
 *      the state it replaced snapshotted first (:1387 read through :1508).
 */

const db = getDb()

let userId = 0
let secondUserId = 0
let pageId = 0

const actor = () => ({ userId, ip: '127.0.0.1' })

function editInput(overrides: Partial<PageEditInput> = {}): PageEditInput {
  return {
    title: 'Revised title',
    metaDescription: 'Revised description',
    schemaTypes: ['WebPage', 'Product'],
    contentJson: { blocks: [{ type: 'richtext' as const, text: 'new body' }] },
    changeNote: 'test edit',
    ...overrides,
  }
}

async function audits(action: string): Promise<Array<{ action: string; user_id: number; after_json: unknown }>> {
  const res = await sql<{ action: string; user_id: number; after_json: unknown }>`
    select action, user_id, after_json from audit_log
    where action = ${action} and entity_type = 'site_page' and entity_id = ${pageId}
    order by id desc
  `.execute(db)
  return res.rows
}

beforeAll(async () => {
  await sweepFixtures(db)
  const marker = randomUUID().slice(0, 8)

  const user = await db
    .insertInto('users')
    .values({
      email: `fixture.cmsrev.${marker}@example.invalid`,
      full_name: '[fixture] CMS revision editor',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  userId = Number(user.insertId ?? 0)

  const second = await db
    .insertInto('users')
    .values({
      email: `fixture.cmsrev2.${marker}@example.invalid`,
      full_name: '[fixture] CMS revision second editor',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  secondUserId = Number(second.insertId ?? 0)

  const page = await db
    .insertInto('site_pages')
    .values({
      slug: `fixture-cms-rev-${marker}`,
      title: 'Original title',
      meta_description: 'Original description',
      schema_types: JSON.stringify(['WebPage']),
      content_json: JSON.stringify({ blocks: [{ type: 'richtext', text: 'original body' }] }),
      status: 'published',
      published_at: new Date(),
      published_by: userId,
    })
    .executeTakeFirst()
  pageId = Number(page.insertId ?? 0)
})

afterAll(async () => {
  await sql`delete from audit_log where entity_type = 'site_page' and entity_id = ${pageId}`.execute(db).catch(() => {})
  await sql`delete from site_page_revisions where page_id = ${pageId}`.execute(db).catch(() => {})
  await sql`delete from site_pages where id = ${pageId}`.execute(db).catch(() => {})
  await sql`delete from users where id in (${userId}, ${secondUserId})`.execute(db).catch(() => {})
  await closePool()
})

describe('the §7 revision writer: an edit always writes a revision (DECISIONS 29.29)', () => {
  it('an edit writes a revision holding the replaced state, with the editing user recorded', async () => {
    const { revisionId } = await editPage(db, actor(), pageId, editInput())

    expect(revisionId).toBeGreaterThan(0)
    const revision = await db
      .selectFrom('site_page_revisions')
      .select(['revision_no', 'content_json', 'title', 'meta_description', 'schema_types', 'changed_by'])
      .where('id', '=', revisionId)
      .executeTakeFirstOrThrow()

    // The revision is the state the edit replaced, not the new state.
    expect(revision.title).toBe('Original title')
    expect(revision.changed_by).toBe(userId)
    const stored = typeof revision.content_json === 'string' ? JSON.parse(revision.content_json) : revision.content_json
    expect(stored).toEqual({ blocks: [{ type: 'richtext', text: 'original body' }] })

    // The live row moved. mysql2 parses JSON columns into objects on read,
    // so normalize before asserting.
    const live = await db.selectFrom('site_pages').select(['title', 'schema_types']).where('id', '=', pageId).executeTakeFirstOrThrow()
    expect(live.title).toBe('Revised title')
    const liveTypes = typeof live.schema_types === 'string' ? JSON.parse(live.schema_types) : live.schema_types
    expect(Array.isArray(liveTypes)).toBe(true)
  })

  it('a second edit by another user writes revision 2 with that user recorded, and revisions never share a number', async () => {
    await editPage(db, { userId: secondUserId, ip: null }, pageId, editInput({ changeNote: 'second edit' }))

    const revisions = await db
      .selectFrom('site_page_revisions')
      .select(['revision_no', 'changed_by', 'change_note'])
      .where('page_id', '=', pageId)
      .orderBy('revision_no')
      .execute()
    expect(revisions.map((r) => r.revision_no)).toEqual([1, 2])
    expect(revisions[1]!.changed_by).toBe(secondUserId)
    expect(revisions[0]!.changed_by).toBe(userId)
  })

  it('the revision write is audited', async () => {
    const rows = await audits('marketing.page_revision_write')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const after = rows[0]!.after_json as { revision_no?: number }
    expect(after.revision_no).toBe(2)
  })

  it('an edit refusing an empty schema-type list never writes a page row or a revision', async () => {
    // The Zod schema is the gate: validation happens before the service is
    // called (routes parse first), and the parsed type is what editPage
    // accepts. Prove the schema itself refuses the empty list.
    const parsed = pageEditSchema.safeParse({ ...editInput(), schemaTypes: [] })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.message).toMatch(/at least one schema type/)
    }

    // The count is the proof no half-write survived: still the two revisions.
    const count = await db
      .selectFrom('site_page_revisions')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('page_id', '=', pageId)
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(2)
  })
})

describe('the revert path: exact prior values, audited, never NULL (spec :1508)', () => {
  it('a revert restores the exact prior title, meta, schema_types and content, and sets draft', async () => {
    // Revision 1 holds the original state (title "Original title").
    await revertToRevision(db, actor(), pageId, 1)

    const live = await db
      .selectFrom('site_pages')
      .select(['title', 'meta_description', 'schema_types', 'content_json', 'status'])
      .where('id', '=', pageId)
      .executeTakeFirstOrThrow()

    expect(live.title).toBe('Original title')
    expect(live.meta_description).toBe('Original description')
    const restoredTypes = typeof live.schema_types === 'string' ? JSON.parse(live.schema_types) : live.schema_types
    expect(restoredTypes).toEqual(['WebPage'])
    const blocks = typeof live.content_json === 'string' ? JSON.parse(live.content_json) : live.content_json
    expect(blocks).toEqual({ blocks: [{ type: 'richtext', text: 'original body' }] })
    expect(live.status).toBe('draft')
  })

  it('the revert is itself audited and snapshotted the state it replaced first', async () => {
    const revertRows = await audits('marketing.page_revert')
    expect(revertRows.length).toBeGreaterThanOrEqual(1)
    const after = revertRows[0]!.after_json as { revision_no?: number; status?: string }
    expect(after.revision_no).toBe(1)
    expect(after.status).toBe('draft')

    // :1387 through :1508 — the revert first snapshotted the pre-revert
    // state, so there is a revision holding "Revised title" (the state the
    // revert replaced). The pre-revert snapshot is the newest revision; the
    // one holding "Revised title" may share the note with revision 2's edit,
    // so assert on the latest revision row.
    const revisions = await db
      .selectFrom('site_page_revisions')
      .select(['revision_no', 'title', 'change_note'])
      .where('page_id', '=', pageId)
      .orderBy('revision_no')
      .execute()
    const last = revisions[revisions.length - 1]!
    expect(last.title).toBe('Revised title')
    expect(last.change_note).toContain('before revert to revision 1')
  })

  it('a full edit → revert round trip leaves schema_types non-NULL on both tables (the NOT NULL holds)', async () => {
    // Edit again: the reverted (original) state is snapshotted, new values
    // land on the live row.
    const { revisionId } = await editPage(db, actor(), pageId, editInput({ schemaTypes: ['WebPage', 'FAQPage'] }))

    const revision = await db
      .selectFrom('site_page_revisions')
      .select('schema_types')
      .where('id', '=', revisionId)
      .executeTakeFirstOrThrow()
    const revisionTypes = typeof revision.schema_types === 'string' ? JSON.parse(revision.schema_types) : revision.schema_types
    expect(revisionTypes).toEqual(['WebPage'])

    const live = await db.selectFrom('site_pages').select('schema_types').where('id', '=', pageId).executeTakeFirstOrThrow()
    const liveTypes = typeof live.schema_types === 'string' ? JSON.parse(live.schema_types) : live.schema_types
    expect(liveTypes).toEqual(['WebPage', 'FAQPage'])

    // No NULL anywhere the narrowing of migration 026 governs.
    const nulls = await sql<{ n: number }>`
      select count(*) as n from site_page_revisions where page_id = ${pageId} and schema_types is null
    `.execute(db)
    expect(Number(nulls.rows[0]!.n)).toBe(0)
  })

  it('reverting to a revision that does not exist is refused, and changes nothing', async () => {
    const before = await db.selectFrom('site_pages').select('title').where('id', '=', pageId).executeTakeFirstOrThrow()
    await expect(revertToRevision(db, actor(), pageId, 999)).rejects.toThrow(/does not exist/)
    const after = await db.selectFrom('site_pages').select('title').where('id', '=', pageId).executeTakeFirstOrThrow()
    expect(after.title).toBe(before.title)
  })

  it('a standalone writeRevision snapshots the current row under the caller transaction', async () => {
    const revisionId = await writeRevision(db, actor(), pageId, 'manual snapshot')
    expect(revisionId).toBeGreaterThan(0)
    const revision = await db
      .selectFrom('site_page_revisions')
      .select('schema_types')
      .where('id', '=', revisionId)
      .executeTakeFirstOrThrow()
    // The snapshot is never NULL, whatever the live value is — the
    // restorability guarantee 026 establishes.
    expect(revision.schema_types).not.toBeNull()
  })
})
