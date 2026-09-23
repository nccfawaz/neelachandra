import { execFile } from 'node:child_process'
import { createConnection } from 'mysql2/promise'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { closePool } from '../../src/db/pool.js'

/**
 * The schema-drift tripwire (DECISIONS 29.77).
 *
 * Production 500'd on POST /app/admin/users/:id/roles because every writer
 * in admin/service.ts inserts user_roles.granted_by but no migration ever
 * created it. Nothing caught it because (a) the route sat unexercised on the
 * route-coverage allowlist, and (b) no test compared the schema the
 * migrations produce against the schema the app actually runs against. This
 * is that comparison.
 *
 * Method: apply the full migration chain to a throwaway database on the same
 * server as the dev database, snapshot both schemas from information_schema
 * (columns, indexes, tables/views, triggers), and assert the sets are equal.
 * Drift in either direction fails — a column only dev has means the chain is
 * incomplete; a column only the chain has means dev was never migrated.
 *
 * The probe database is created with the same credentials the dev database
 * uses, so the test needs nothing a gate doesn't already have. The
 * empty-green rule: a broken information_schema query would produce two
 * empty sets that compare equal, so a non-zero floor on the table count is
 * asserted first.
 */

const run = promisify(execFile)

interface Snapshot {
  tables: string[]
  columns: string[]
  indexes: string[]
  triggers: string[]
}

type Conn = Awaited<ReturnType<typeof createConnection>>

async function snapshot(db: Conn, schema: string): Promise<Snapshot> {
  const [cols] = await db.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ct, IS_NULLABLE nul, COLUMN_DEFAULT d, EXTRA e
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  )
  const [idx] = await db.query(
    `SELECT TABLE_NAME t, INDEX_NAME i, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols, NON_UNIQUE nu
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND INDEX_NAME != 'PRIMARY'
      GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
    [schema],
  )
  const [tbls] = await db.query(
    `SELECT TABLE_NAME t, TABLE_TYPE tt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [schema],
  )
  const [trigs] = await db.query(
    `SELECT TRIGGER_NAME n, EVENT_OBJECT_TABLE t, ACTION_TIMING tm, EVENT_MANIPULATION em
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
    [schema],
  )
  return {
    tables: (tbls as { t: string; tt: string }[]).map((r) => `${r.t}:${r.tt}`).sort(),
    columns: (cols as { t: string; c: string; ct: string; nul: string; d: unknown; e: string }[])
      .map((r) => `${r.t}.${r.c}:${r.ct}:${r.nul}:${String(r.d)}:${r.e}`)
      .sort(),
    indexes: (idx as { t: string; i: string; cols: string; nu: number }[])
      .map((r) => `${r.t}.${r.i}(${r.cols}):${r.nu}`)
      .sort(),
    triggers: (trigs as { n: string; t: string; tm: string; em: string }[])
      .map((r) => `${r.n}@${r.t}:${r.tm}:${r.em}`)
      .sort(),
  }
}

const PROBE_DB = 'ncc_schema_drift_probe'
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
}
const DEV_SCHEMA = process.env.DB_NAME || 'ncc_dev'
let clean: Snapshot | null = null

describe('schema drift: migration chain vs the database the app runs against', () => {
  it('builds the migration-chain schema on a probe database (non-zero floor: the chain must produce tables)', async () => {
    const admin = await createConnection(DB)
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`)
      await admin.query(`CREATE DATABASE ${PROBE_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    } finally {
      await admin.end()
    }
    const repoRoot = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    await run('node', ['scripts/migrate.mjs'], {
      env: { ...process.env, DB_NAME: PROBE_DB },
      cwd: repoRoot,
    })
    const conn = await createConnection({ ...DB, database: PROBE_DB })
    try {
      clean = await snapshot(conn, PROBE_DB)
    } finally {
      await conn.end()
    }
    // Empty-green guard: a broken snapshot must not pass by comparing [] to [].
    expect(clean.tables.length).toBeGreaterThan(20)
  }, 120_000)

  it('the dev schema equals the migration-chain schema — columns, indexes, tables, triggers', async () => {
    expect(clean).not.toBeNull()
    const dev = await snapshot(await createConnection({ ...DB, database: DEV_SCHEMA }), DEV_SCHEMA)
    expect(dev.tables).toEqual(clean!.tables)
    expect(dev.columns).toEqual(clean!.columns)
    expect(dev.indexes).toEqual(clean!.indexes)
    expect(dev.triggers).toEqual(clean!.triggers)
  }, 60_000)

  afterAll(async () => {
    const admin = await createConnection(DB)
    await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`).catch(() => {})
    await admin.end()
    await closePool()
  })
})
