import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getDb } from '../../src/db/kysely.js'
import { sweepFixtures } from './fixture-markers.js'
import { parseJsonColumn } from '../../src/lib/json.js'
import { closePool, getPool } from '../../src/db/pool.js'

/**
 * The §7 CMS precondition closed (DECISIONS 21.4 → 29.25).
 *
 * 21.4 predicted that a NULL revision would make the revert path fail, and
 * the pre-migration probe demonstrated exactly that: the NULL revision was
 * admitted, and the revert's UPDATE of site_pages from it was refused with
 * ER_BAD_NULL_ERROR ("Column 'schema_types' cannot be null"). Migration 026
 * removes the shape at the source. This suite pins the post-migration
 * contract:
 *   1. a revision row can no longer hold NULL schema_types — the snapshot
 *      is usable by construction;
 *   2. the snapshot/restore round trip preserves schema_types exactly.
 * The revert service does not exist yet (§7 is unbuilt), so the restore in
 * test 2 writes through the same UPDATE shape spec :1508's revert route
 * will perform — against the real tables, on the real column, which is the
 * part the migration guarantees.
 */

const db = getDb()

let pageId = 0
let userId = 0

beforeAll(async () => {
  await sweepFixtures(db)
  const marker = randomUUID().slice(0, 8)
  const [u] = await (await getPool()).query(
    "INSERT INTO users (email, full_name, status, must_change_password) VALUES (?, '[fixture] revision probe', 'active', 0)",
    [`fixture.revschema.${marker}@example.invalid`]
  ) as [{ insertId: number }, unknown]
  userId = Number((u as { insertId: number }).insertId)

  const page = await db
    .insertInto('site_pages')
    .values({
      slug: `probe-rev-${marker}`,
      title: 'Revision probe page',
      schema_types: JSON.stringify(['Organization', 'LocalBusiness']),
      content_json: JSON.stringify([]),
      status: 'published',
    })
    .executeTakeFirst()
  pageId = Number(page.insertId ?? 0)
})

afterAll(async () => {
  await sql`delete from site_page_revisions where page_id = ${pageId}`.execute(db)
  await sql`delete from site_pages where id = ${pageId}`.execute(db)
  await (await getPool()).query("DELETE FROM users WHERE id = ?", [userId])
  await closePool()
})

describe('the §7 precondition: a revision is always restorable (DECISIONS 29.25)', () => {
  it('a revision with NULL schema_types is refused at insert by migration 026', async () => {
    let err: Error & { code?: string } | undefined
    try {
      await db
        .insertInto('site_page_revisions')
        .values({
          page_id: pageId,
          revision_no: 1,
          content_json: JSON.stringify([]),
          title: 'Broken snapshot',
          schema_types: null,
          changed_by: userId,
        })
        .execute()
    } catch (caught) {
      err = caught as Error & { code?: string }
    }
    expect(err?.code, 'a NULL revision was admitted — 026 did not land or was reverted').toBe('ER_BAD_NULL_ERROR')
  })

  it('the snapshot/restore round trip preserves schema_types through the revert write shape', async () => {
    const before = JSON.stringify(['Organization', 'LocalBusiness'])

    // Publish-shaped snapshot: the page's current schema_types into a revision.
    await db
      .insertInto('site_page_revisions')
      .values({
        page_id: pageId,
        revision_no: 2,
        content_json: JSON.stringify([{ type: 'text', text: 'old' }]),
        title: 'Older draft',
        schema_types: before,
        changed_by: userId,
      })
      .executeTakeFirstOrThrow()

    // The live page drifts (as a later publish would make it).
    await db
      .updateTable('site_pages')
      .set({ schema_types: JSON.stringify(['Product']) })
      .where('id', '=', pageId)
      .execute()

    // Revert (spec :1508): restore revision 2 as a new draft — the write the
    // route will perform, against the same NOT NULL column 21.4 worried about.
    const revision = await db
      .selectFrom('site_page_revisions')
      .select(['schema_types', 'title', 'content_json'])
      .where('page_id', '=', pageId)
      .where('revision_no', '=', 2)
      .executeTakeFirstOrThrow()

    await db
      .updateTable('site_pages')
      .set({
        schema_types: typeof revision.schema_types === 'string' ? revision.schema_types : JSON.stringify(revision.schema_types),
        title: revision.title,
        // The driver hands JSON columns back as longtext strings; pass the
        // stored string through untouched so the restore is byte-identical.
        content_json: typeof revision.content_json === 'string' ? revision.content_json : JSON.stringify(revision.content_json),
      })
      .where('id', '=', pageId)
      .execute()

    const restored = await db
      .selectFrom('site_pages')
      .select('schema_types')
      .where('id', '=', pageId)
      .executeTakeFirstOrThrow()
    expect(parseJsonColumn(restored.schema_types)).toEqual(JSON.parse(before))
  })
})
