import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'kysely'
import { afterAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'

/**
 * Does the database layer reach a database.
 *
 * This suite exists because of a specific failure. On 2026-09-03 every Kysely
 * query in the application hung forever with no error, no timeout and no log
 * line: src/db/kysely.ts passed MysqlDialect the mysql2/promise pool wrapper,
 * whose getConnection() takes no callback, while the dialect calls
 * getConnection(cb) and waits. tsc passed, 148 unit tests passed, and the bug
 * was found only by running a script against a real MariaDB by hand.
 *
 * So the assertions below are chosen to be the ones a mock cannot satisfy and
 * a type check cannot make. Each pins a runtime contract of the pool or the
 * dialect that the rest of the codebase silently assumes:
 *
 *   - queries and transactions complete rather than hang       (the 38ca44f bug)
 *   - the migrations actually ran, all of them
 *   - Kysely and the raw mysql2 path see the same database
 *   - DECIMAL arrives as a string, DATE as a string
 *
 * The last one looks like trivia and is not. src/db/pool.ts leaves
 * decimalNumbers unset and sets dateStrings, so every arithmetic site in the
 * codebase wraps DECIMAL in Number() and every date is compared as text.
 * Flipping either option would keep tsc and the unit suite green and quietly
 * change money and date behaviour across eight modules.
 *
 * tests/db-wiring.test.ts holds the companion check that needs no database: it
 * pins the shape difference between the two pool objects, so the specific
 * mistake is caught in the ordinary test run too.
 */

const db = getDb()

afterAll(async () => {
  // Ends the one physical pool. Kysely was handed getPool().pool, the callback
  // pool underneath this wrapper, so this closes its connections too and
  // calling db.destroy() as well would end an already-ended pool.
  await closePool()
})

describe('database integration', () => {
  it('executes a query through getDb() instead of hanging', async () => {
    const result = await sql<{ n: number }>`select 1 + 1 as n`.execute(db)

    expect(result.rows).toHaveLength(1)
    expect(Number(result.rows[0]!.n)).toBe(2)
  })

  it('reads a migrated table through the typed query builder', async () => {
    const rows = await db
      .selectFrom('permissions')
      .select(['key', 'module'])
      .orderBy('key')
      .execute()

    // The count is not pinned: 002_rbac.sql may legitimately gain permissions.
    // What is pinned is that the seed ran and its own key convention holds,
    // since requirePermission() and notifyPermission() take these as strings
    // and a typo in either is not a type error.
    //
    // `module` is a grouping label for the UI, not the key's namespace: nine of
    // the sixty rows differ on purpose (`audit.view` and `users.manage` sit in
    // module `auth`, `dashboard.view_own_kpi` and `enquiries.view` in `admin`).
    // Asserting key.startsWith(module) looked obvious and was wrong.
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.key).toMatch(/^[a-z_]+\.[a-z0-9_]+$/)
      expect(row.module).toMatch(/^[a-z_]+$/)
    }
  })

  it('has every migration file recorded as applied', async () => {
    const files = (await readdir(path.join(process.cwd(), 'migrations')))
      .filter((name) => name.endsWith('.sql'))
      .sort()

    const applied = await sql<{ name: string }>`
      select name from schema_migrations order by name
    `.execute(db)

    // Reading the directory rather than hardcoding 9 means adding a migration
    // and forgetting to run it fails here rather than at the first query that
    // needs the new table.
    expect(applied.rows.map((row) => row.name)).toEqual(files)
  })

  it('opens, uses and commits a transaction', async () => {
    // Every service function runs inside one of these, and the transaction path
    // acquires its connection separately from a top-level query, so a pool
    // wired wrongly for one is not necessarily wired wrongly for the other.
    const count = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('roles')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow()
      return Number(row.n)
    })

    expect(count).toBeGreaterThan(0)
  })

  it('shares one connection pool with the raw mysql2 path', async () => {
    // spec 2.4: one pool per process. Two pools is how a raw query and a Kysely
    // query deadlock by holding a connection each while waiting for the other.
    // Proving object identity would prove less than this: both APIs work, and
    // they agree on what the database contains.
    const viaKysely = await db
      .selectFrom('permissions')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow()

    const [rawRows] = await getPool().query<
      Array<{ n: number } & Record<string, unknown>>
    >('SELECT COUNT(*) AS n FROM permissions')

    expect(Number(rawRows[0]!.n)).toBe(Number(viaKysely.n))
  })

  it('returns DECIMAL as a string and DATE as a string', async () => {
    const row = (
      await sql<{ d: unknown; dt: unknown }>`
        select cast(1.5 as decimal(14,3)) as d, cast('2026-09-03' as date) as dt
      `.execute(db)
    ).rows[0]!

    // decimalNumbers is unset in src/db/pool.ts, deliberately: a DECIMAL(14,3)
    // quantity through a float loses exactness, and money is BIGINT paise.
    expect(typeof row.d).toBe('string')
    expect(row.d).toBe('1.500')

    // dateStrings: ['DATE','DATETIME'], so nothing in the codebase has to think
    // about the server's timezone when comparing a txn_date.
    expect(typeof row.dt).toBe('string')
    expect(row.dt).toBe('2026-09-03')
  })
})
