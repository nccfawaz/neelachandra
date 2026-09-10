import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'

/**
 * Migration 026's backfill, proven by replay (DECISIONS 29.25, amended).
 *
 * 026 shipped against a dev database holding zero revisions, so its
 * UPDATE ... JOIN backfill never executed against real data and the NOT NULL
 * narrowing succeeded trivially. The applied file is not edited — forward
 * migrations only — so this suite reconstructs the pre-migration state with
 * TEMPORARY tables of the same shape (007:19-58 before 026, i.e. the
 * revision column nullable), inserts revisions with NULL schema_types, and
 * applies 026's backfill clause VERBATIM. It then asserts the value the
 * clause derives from the snapshotted page.
 *
 * The derived value is the page's current schema_types, whatever it is: for
 * a page whose schema_types is a populated JSON array the revision receives
 * that array; for a page whose schema_types is an empty JSON array ('[]')
 * the revision receives '[]' — still a valid, non-NULL JSON value, so the
 * narrowing holds even in the emptiest legitimate case. A page whose column
 * were SQL NULL cannot exist (site_pages.schema_types is NOT NULL, 007:27),
 * which is exactly why the backfill can source from it unconditionally.
 */

const db = getDb()

beforeAll(async () => {
  const pool = await getPool()
  // The pre-migration shape: site_pages.schema_types NOT NULL,
  // site_page_revisions.schema_types NULL (007:27 / 007:51 before 026).
  await pool.query(`
    CREATE TEMPORARY TABLE tmp_replay_pages (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(160) NOT NULL,
      schema_types LONGTEXT NOT NULL,
      CONSTRAINT schema_types CHECK (schema_types IS NOT NULL)
    ) ENGINE=InnoDB
  `)
  await pool.query(`
    CREATE TEMPORARY TABLE tmp_replay_revisions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      page_id BIGINT UNSIGNED NOT NULL,
      revision_no INT UNSIGNED NOT NULL,
      schema_types LONGTEXT NULL
      -- No FK: MariaDB refuses foreign keys between TEMPORARY tables, and
      -- the replay needs only the two shapes, not the referential guard.
    ) ENGINE=InnoDB
  `)
})

afterAll(async () => {
  const pool = await getPool()
  await pool.query('DROP TEMPORARY TABLE IF EXISTS tmp_replay_revisions')
  await pool.query('DROP TEMPORARY TABLE IF EXISTS tmp_replay_pages')
  await closePool()
})

/** 026's backfill clause, verbatim except for the replay table names. */
async function replayBackfill(): Promise<void> {
  await sql`
    UPDATE tmp_replay_revisions r
      JOIN tmp_replay_pages p ON p.id = r.page_id
       SET r.schema_types = p.schema_types
     WHERE r.schema_types IS NULL
  `.execute(db)
}

describe('026 backfill replay (DECISIONS 29.25, amended)', () => {
  it('a NULL revision receives its page’s populated schema_types, verbatim clause', async () => {
    const pool = await getPool()
    await pool.query("INSERT INTO tmp_replay_pages (slug, schema_types) VALUES ('replay-populated', '[\"Organization\",\"LocalBusiness\"]')")
    const [[page]] = await pool.query("SELECT id FROM tmp_replay_pages WHERE slug = 'replay-populated'") as [{ id: number }[], unknown]
    await pool.query('INSERT INTO tmp_replay_revisions (page_id, revision_no, schema_types) VALUES (?, 1, NULL)', [page.id])

    await replayBackfill()

    const [[rev]] = await pool.query('SELECT schema_types FROM tmp_replay_revisions WHERE page_id = ? AND revision_no = 1', [page.id]) as [{ schema_types: string }[], unknown]
    expect(rev.schema_types).toBe('["Organization","LocalBusiness"]')
  })

  it('a page whose schema_types is an empty JSON array backfills the empty array — valid, non-NULL JSON', async () => {
    const pool = await getPool()
    await pool.query("INSERT INTO tmp_replay_pages (slug, schema_types) VALUES ('replay-empty', '[]')")
    const [[page]] = await pool.query("SELECT id FROM tmp_replay_pages WHERE slug = 'replay-empty'") as [{ id: number }[], unknown]
    await pool.query('INSERT INTO tmp_replay_revisions (page_id, revision_no, schema_types) VALUES (?, 1, NULL)', [page.id])

    await replayBackfill()

    const [[rev]] = await pool.query('SELECT schema_types FROM tmp_replay_revisions WHERE page_id = ? AND revision_no = 1', [page.id]) as [{ schema_types: string | null }[], unknown]
    // The empty case still narrows cleanly: '[]' is valid JSON, so json_valid
    // passes and the NOT NULL conversion would succeed on such a row.
    expect(rev.schema_types).toBe('[]')
    expect(rev.schema_types).not.toBeNull()
  })

  it('after the backfill no NULL remains, so the NOT NULL narrowing succeeds', async () => {
    const pool = await getPool()
    // A second NULL revision on the populated page, to show the clause is
    // idempotent and complete over any number of rows.
    const [[page]] = await pool.query("SELECT id FROM tmp_replay_pages WHERE slug = 'replay-populated'") as [{ id: number }[], unknown]
    await pool.query('INSERT INTO tmp_replay_revisions (page_id, revision_no, schema_types) VALUES (?, 2, NULL)', [page.id])
    await replayBackfill()
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM tmp_replay_revisions WHERE schema_types IS NULL') as [{ n: number }[], unknown]
    expect(Number(n)).toBe(0)
    // And the narrowing itself, replayed on the temporary table: after the
    // MODIFY, an INSERT with NULL must be refused. (TEMPORARY tables do not
    // appear in information_schema, so the column check is behavioural.)
    await pool.query('ALTER TABLE tmp_replay_revisions MODIFY COLUMN schema_types LONGTEXT NOT NULL')
    let refused = false
    try {
      await pool.query('INSERT INTO tmp_replay_revisions (page_id, revision_no, schema_types) VALUES (?, 3, NULL)', [page.id])
    } catch {
      refused = true
    }
    expect(refused, 'a NULL revision was admitted after the narrowing replay').toBe(true)
  })
})
