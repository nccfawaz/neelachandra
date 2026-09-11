import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { JSON_COLUMNS, jsonColumnEquals, parseJsonColumn, toJsonText } from '../../src/lib/json.js'
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

    // The non-zero floor (DECISIONS 28.1): the probe `and 1 = 0` appended to
    // this query made `declared` empty and this comparison fail — which is
    // loud, but names the wrong thing ("the registry is wrong") rather than
    // "the enumeration found nothing". The floor names the actual failure: an
    // empty enumeration is a query or schema problem, not a registry mismatch.
    expect(
      declared,
      'no json_valid CHECK constraints found — the query returned zero rows, ' +
        'which is a wrong-database or wrong-filter problem, not a registry mismatch. See DECISIONS 28.1.'
    ).not.toHaveLength(0)
    expect(declared).toEqual([...JSON_COLUMNS])
  })

  it('registers every column that exists under a name the grep would miss', async () => {
    // Three of the twelve are not called *_json, which is how they were missed
    // the first time. This asserts they are real columns, not stale entries.
    // (visible_to_roles and the two 027 draft columns make it five of
    // fourteen now.)
    const odd = JSON_COLUMNS.filter((entry) => !entry.endsWith('_json'))
    expect(odd).toHaveLength(4)
    for (const entry of odd) {
      const [table, column] = entry.split('.')
      const result = await sql<{ n: number }>`
        select count(*) as n from information_schema.columns
        where table_schema = database() and table_name = ${table} and column_name = ${column}
      `.execute(db)
      expect(Number(result.rows[0]?.n ?? 0), `${entry} is registered but does not exist`).toBe(1)
    }
  })

  it('holds no row whose stored value fails JSON_VALID or is the literal [object Object]', async () => {
    // The stored bytes are observed, not inferred. Every registered column is
    // scanned for a value that is non-NULL and either fails json_valid or is
    // exactly the '[object Object]' literal that Kysely's binding produces
    // from a bare object (DECISIONS 29.29's first cms-revisions run failed
    // all nine tests on exactly that literal).
    //
    // What the CHECKs do and do not catch, proven against this server on
    // 2026-09-11: a json_valid CHECK refuses '[object Object]' on both INSERT
    // and UPDATE on a nullable column (email_log.response_json, live-refused
    // errno 4025), so the seven nullable columns are NOT naked — the
    // three-valued-logic hole admits only NULL itself, which is legitimate
    // for a nullable column. The literal could only be stored if a column
    // lacked its CHECK entirely; the registry==CHECKs test above pins that at
    // twelve, and this scan catches the case a future migration drops one.
    expect(JSON_COLUMNS.length, 'the column enumeration is empty').toBeGreaterThan(0)
    expect(JSON_COLUMNS.length).toBe(14) // +2 from migration 027's draft columns
    for (const entry of JSON_COLUMNS) {
      const [table, column] = entry.split('.')
      const result = await sql<{ n: number }>`
        select count(*) as n from ${sql.table(table)}
        where ${sql.ref(column)} is not null
          and (json_valid(${sql.ref(column)}) = 0 or ${sql.ref(column)} = '[object Object]')
      `.execute(db)
      expect(
        Number(result.rows[0]?.n ?? 0),
        `${entry} holds a value that is not valid JSON or is the '[object Object]' binding literal`
      ).toBe(0)
    }
  })

  it('toJsonText is the sanctioned write path: a raw object is normalised, null passes through', async () => {
    // The writer-side twin of parseJsonColumn (src/lib/json.ts). Proves the
    // encoding contract at the point every JSON write is expected to go
    // through: an object that mysql2 would hand back from a read is encoded
    // to canonical text rather than bound as '[object Object]'.
    const parsed = { blocks: [{ type: 'richtext', text: 'x' }] }
    expect(toJsonText(parsed)).toBe(JSON.stringify(parsed))
    expect(toJsonText(JSON.stringify(parsed))).toBe(JSON.stringify(parsed))
    expect(toJsonText(null)).toBe(null)
    expect(toJsonText(undefined)).toBe(null)
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
        // 'string' is checked too, and it is the one that caught the three
        // finance rates: JSON numbers seeded under data_type 'string', which the
        // settings form would have rewritten as strings on its first save.
        // Fixed in migrations/011_settings_rate_units.sql. DECISIONS.md 12.7.
        if (row.data_type === 'string') return typeof value !== 'string'
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

  it('finds no row whose stored value contradicts its data_type', () => {
    // Three rows failed this until migrations/011_settings_rate_units.sql:
    // 003_reference.sql seeded the GST, TDS and retention defaults as unquoted
    // JSON numbers under data_type 'string', so the first save of the settings
    // form would have rewritten all three as strings and reported three changes
    // nobody made. They are now basis-point integers under 'int', which is what
    // spec 4.3 uses for a percentage in a general column. DECISIONS.md 13.
    expect(contradictory).toEqual([])
  })

  it('holds the finance rates in basis points', () => {
    // 1800 not 18: spec 6.8 makes every rate DECIMAL(5,2) and 4.3 stores a pct
    // as basis points, which encodes those two decimal places exactly and
    // matches what submitQuote already compares against approval_limits.
    const rates = new Map(
      settingsRows
        .filter((row) => row.key_name.startsWith('finance.') && row.key_name.endsWith('_pct'))
        .map((row) => [row.key_name, parseJsonColumn(row.value_json)])
    )
    expect(Object.fromEntries(rates)).toEqual({
      'finance.gst_default_pct': 1800,
      'finance.retention_default_pct': 500,
      'finance.tds_default_pct': 200,
    })
  })
})
