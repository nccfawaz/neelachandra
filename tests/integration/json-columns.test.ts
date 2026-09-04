import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { JSON_COLUMNS, jsonColumnEquals, parseJsonColumn } from '../../src/lib/json.js'
import { allSettings, coerceSetting } from '../../src/lib/settings.js'
import * as svc from '../../src/modules/admin/service.js'

/*
 * The JSON columns, against the server that decides what they are.
 *
 * tests/json-columns.test.ts enforces the rule in the source: one JSON.parse in
 * src/, in src/lib/json.ts. It cannot know whether the list of columns that
 * reader exists for is still the truth, because the truth is a set of CHECK
 * constraints in a database. That is this file.
 *
 * Two things are checked here that nothing else can check:
 *
 *   - JSON_COLUMNS equals the `json_valid` CHECK constraints in
 *     information_schema. A migration that adds a JSON column fails this file
 *     until the column is registered, which is how the next module to be built
 *     — HR, finance, marketing, dashboard snapshots, site content, between them
 *     holding eight of the twelve columns and reading none of them yet — finds
 *     out that the column it is about to read needs the shared reader.
 *   - Saving the settings form without touching it writes nothing. That is the
 *     bug from DECISIONS.md 12 stated as a property: the comparison in
 *     saveSettings ran JSON text against a pre-parsed value, so it never matched
 *     and every save rewrote every row on the form, wrote an audit entry for
 *     each and told the user it had saved them. Only a real driver can show that
 *     the fix holds, because the whole defect is in what the driver returns.
 *
 * Nothing here writes. The settings save is asserted to be a no-op, and the
 * actor is user 0, which does not exist: if the comparison regresses, the write
 * it should not be doing fails the updated_by foreign key as well as the count.
 */

const db = getDb()

/** The exact string the settings page puts in the input (admin/routes.tsx:635). */
function formValue(dataType: string, value: unknown): string | undefined {
  if (dataType === 'bool') return value === true ? 'on' : undefined
  if (dataType === 'money') return String(Number(value ?? 0) / 100)
  if (dataType === 'json') return JSON.stringify(value)
  return String(value ?? '')
}

async function auditRowCount(): Promise<number> {
  const result = await sql<{ n: number }>`select count(*) as n from audit_log`.execute(db)
  return Number(result.rows[0]?.n ?? 0)
}

let settingsRows: Awaited<ReturnType<typeof allSettings>> = []
let unchangedPost: Record<string, string> = {}
let contradictory: string[] = []

beforeAll(async () => {
  settingsRows = await allSettings(db)
  unchangedPost = {}
  contradictory = []
  for (const row of settingsRows) {
    const raw = formValue(row.data_type, parseJsonColumn(row.value_json))
    const next = coerceSetting(row.data_type, raw ?? '')
    // A row whose stored value contradicts its own data_type cannot round-trip
    // through the form, so it is held out of the post and asserted separately.
    if (!jsonColumnEquals(row.value_json, next)) {
      contradictory.push(row.key_name)
      continue
    }
    if (raw !== undefined) unchangedPost[`s_${row.key_name}`] = raw
  }
})

afterAll(async () => {
  await closePool()
})

describe('the JSON column registry, against information_schema', () => {
  it('matches the json_valid CHECK constraints exactly', async () => {
    const result = await sql<{ t: string; cl: string }>`
      select table_name as t, check_clause as cl
      from information_schema.check_constraints
      where constraint_schema = database() and check_clause like '%json_valid%'
    `.execute(db)

    // The column comes out of the clause rather than the constraint name:
    // MariaDB names an inline CHECK after its column today, and a named
    // constraint in a later migration would silently break that assumption.
    const declared = result.rows
      .map((row) => {
        const column = /json_valid\s*\(\s*`([^`]+)`/i.exec(row.cl)
        expect(column, `could not read a column out of: ${row.cl}`).not.toBe(null)
        return `${row.t}.${column?.[1] ?? '?'}`
      })
      .sort()

    expect(declared).toEqual([...JSON_COLUMNS])
  })

  it('registers every column that exists under a name the grep would miss', async () => {
    // Three of the twelve are not called *_json, which is how they were missed
    // the first time. This asserts they are real columns, not stale entries.
    const odd = JSON_COLUMNS.filter((entry) => !entry.endsWith('_json'))
    expect(odd).toHaveLength(3)
    for (const entry of odd) {
      const [table, column] = entry.split('.')
      const result = await sql<{ n: number }>`
        select count(*) as n from information_schema.columns
        where table_schema = database() and table_name = ${table} and column_name = ${column}
      `.execute(db)
      expect(Number(result.rows[0]?.n ?? 0), `${entry} is registered but does not exist`).toBe(1)
    }
  })
})

describe('the reader, against what the driver actually returns', () => {
  it('reads every settings row without leaving it encoded', async () => {
    // If the reader ever hands back text that still starts with a JSON
    // structure character, some caller is about to parse it a second time.
    const stillEncoded = settingsRows
      .map((row) => ({ key: row.key_name, value: parseJsonColumn(row.value_json) }))
      .filter((row) => typeof row.value === 'string' && /^[[{"]/.test(row.value))
      .map((row) => row.key)
    expect(stillEncoded).toEqual([])
  })

  it('reads a value of the type the row declares', async () => {
    const wrongType = settingsRows
      .filter((row) => {
        const value = parseJsonColumn(row.value_json)
        if (value === null) return false
        if (row.data_type === 'bool') return typeof value !== 'boolean'
        if (row.data_type === 'int' || row.data_type === 'money') return typeof value !== 'number'
        if (row.data_type === 'json') return typeof value !== 'object'
        return false
      })
      .map((row) => `${row.key_name} (${row.data_type})`)
    expect(wrongType).toEqual([])
  })
})

describe('saving the settings form without changing it', () => {
  it('rewrites nothing and writes no audit row', async () => {
    const auditBefore = await auditRowCount()
    const changed = await svc.saveSettings(db, { userId: 0, ip: null }, unchangedPost)
    expect(changed).toBe(0)
    expect(await auditRowCount()).toBe(auditBefore)
  })

  it('leaves the stored values byte-identical', async () => {
    const after = await allSettings(db)
    expect(after.map((row) => [row.key_name, JSON.stringify(parseJsonColumn(row.value_json))])).toEqual(
      settingsRows.map((row) => [row.key_name, JSON.stringify(parseJsonColumn(row.value_json))])
    )
    for (const row of after) expect(row.updated_at).toBeTruthy()
  })

  it('names the rows whose stored value contradicts their data_type', () => {
    // Not a pass mark. migrations/003_reference.sql:217-219 insert 18.00, 2.00
    // and 5.00 as JSON numbers under data_type 'string', so the form renders
    // "18", the save coerces it back to the string "18", and the row is
    // rewritten as a different type than it was seeded with. Held out of the
    // post above so this suite writes nothing; recorded here so that fixing the
    // seed makes this list shorter and this assertion fail. DECISIONS.md 12.
    expect(contradictory).toEqual([
      'finance.gst_default_pct',
      'finance.retention_default_pct',
      'finance.tds_default_pct',
    ])
  })
})
