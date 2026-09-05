import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'

/*
 * Every CHECK constraint in the schema, against the server that evaluates them.
 *
 * This file is the output of a sweep, and the sweep found one bug -- which had
 * already been fixed by migration 014 by the time the sweep ran. So the value
 * here is not the repair. It is that the bug was a *class*, and a class needs a
 * rule rather than a fix.
 *
 * The class. A CHECK constraint refuses a row only when its expression
 * evaluates to FALSE. UNKNOWN is admitted. So a comparison against a column
 * that is NULL -- `quantity > 0` where quantity is NULL -- does not refuse the
 * row, and a constraint written without noticing that enforces nothing for
 * exactly the row shape it was written for. 013 wrote that constraint. 014
 * repaired it. DECISIONS.md 19.3 has the truth table.
 *
 * What that means for a reviewer: a CHECK is not verified by reading it. It is
 * verified by a row with a NULL in it being refused by the server. The three
 * refusals for chk_ca_quantity live in hr-contractor-flow.test.ts, next to the
 * fixtures that make an INSERT possible. This file holds the part that does not
 * belong to any one constraint:
 *
 *   - the inventory itself, so a constraint cannot be added without a decision
 *     being recorded about its NULL behaviour
 *   - the syntactic rule, applied to every explicit constraint: a nullable
 *     column may not be compared without an IS NOT NULL guard ahead of the
 *     comparison
 *   - proof that the twelve json_valid constraints are permissive over NULL by
 *     design and strict over every other shape, which is why the sweep left
 *     them alone
 *   - the three-valued evaluation from 19.3, run as SQL, so the argument that
 *     justified 014 is evidence rather than prose
 *
 * Nothing here writes to a table any module reads. The one INSERT is into
 * dashboard_daily_snapshot -- chosen because it has no foreign keys and two
 * NOT NULL columns -- under a sentinel metric_key that afterAll removes.
 */

const db = getDb()

/**
 * The explicit CHECK constraints, as `table.constraint_name`.
 *
 * A constraint MariaDB generated for a JSON column is not in this list; those
 * are recognised by shape below. Adding a constraint to a migration without
 * adding it here fails the first test, which is the point: the failure is where
 * the NULL question gets asked.
 */
const EXPLICIT_CHECKS = ['contractor_attendance.chk_ca_quantity'] as const

/**
 * Explicit constraints that are deliberately permissive over NULL, with the
 * reason. Empty today. An entry here is a decision that the NULL row is
 * meaningful and admitted -- as in 012, where a UNIQUE index over a nullable
 * pair is permissive on purpose (DECISIONS.md 19.1) -- not a note that the
 * constraint has not been thought about.
 */
const PERMISSIVE_OVER_NULL: Record<string, string> = {}

/** Columns whose json_valid CHECK is reachable by a NULL, i.e. the column is nullable. */
const NULLABLE_JSON_COLUMNS = [
  'audit_log.after_json',
  'audit_log.before_json',
  'dashboard_daily_snapshot.detail_json',
  'email_log.response_json',
  'project_documents.visible_to_roles',
  'quotes.payment_schedule_json',
  'site_page_revisions.schema_types',
  'site_services.body_json',
] as const

/** The sentinel row the json_valid proof writes and removes. */
const SENTINEL_KEY = 'zz_schema_constraints_probe'
const SENTINEL_DATE = '2099-12-31'

type CheckRow = { table_name: string; constraint_name: string; check_clause: string }
type ColumnRow = { table_name: string; column_name: string; is_nullable: string }

let checks: CheckRow[] = []
/** `table.column` -> true when the column accepts NULL. */
let nullable = new Map<string, boolean>()

/** A json_valid constraint MariaDB named after its own column. */
function isAutoJsonCheck(row: CheckRow): boolean {
  const column = /^json_valid\(`([^`]+)`\)$/i.exec(row.check_clause.trim())
  return column !== null && column[1] === row.constraint_name
}

/** The columns of `row`'s own table that its clause names, deduplicated. */
function referencedColumns(row: CheckRow): string[] {
  const names = (row.check_clause.match(/`[^`]+`/g) ?? []).map((s) => s.slice(1, -1))
  return [...new Set(names)].filter((name) => nullable.has(`${row.table_name}.${name}`))
}

beforeAll(async () => {
  const checkResult = await sql<CheckRow>`
    select table_name, constraint_name, check_clause
    from information_schema.check_constraints
    where constraint_schema = database()
    order by table_name, constraint_name
  `.execute(db)
  checks = checkResult.rows

  const columnResult = await sql<ColumnRow>`
    select table_name, column_name, is_nullable
    from information_schema.columns
    where table_schema = database()
  `.execute(db)
  nullable = new Map(
    columnResult.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable === 'YES'])
  )

  // Loud rather than a silent zero: every assertion below is over these two
  // sets, and an empty set makes all of them pass.
  expect(checks.length, 'no CHECK constraints found -- did the migrations run?').toBeGreaterThan(0)
  expect(nullable.size, 'no columns found -- wrong database?').toBeGreaterThan(100)
})

afterAll(async () => {
  await sql`delete from dashboard_daily_snapshot where metric_key = ${SENTINEL_KEY}`.execute(db)
  await closePool()
})

describe('the CHECK constraint inventory', () => {
  it('holds exactly the explicit constraints this file has classified', () => {
    const explicit = checks
      .filter((row) => !isAutoJsonCheck(row))
      .map((row) => `${row.table_name}.${row.constraint_name}`)
      .sort()

    // TRIPWIRE. A new CHECK in a migration lands here first. Add it to
    // EXPLICIT_CHECKS, then satisfy the IS NOT NULL rule below or record it in
    // PERMISSIVE_OVER_NULL with the reason.
    expect(explicit).toEqual([...EXPLICIT_CHECKS])
  })

  it('accounts for every constraint as either explicit or an auto json_valid', () => {
    const auto = checks.filter(isAutoJsonCheck).map((row) => `${row.table_name}.${row.constraint_name}`)
    expect(auto).toHaveLength(checks.length - EXPLICIT_CHECKS.length)
    // MariaDB implements JSON as LONGTEXT plus this constraint, so the count is
    // the number of JSON columns. json-columns.test.ts asserts the same set
    // equals JSON_COLUMNS; here it only has to be separable from the explicit
    // ones, because an auto constraint is not something a migration chose.
    expect(auto).toHaveLength(12)
  })

  it('records a NULL decision for every nullable column an explicit CHECK compares', () => {
    const unguarded: string[] = []
    for (const row of checks) {
      if (isAutoJsonCheck(row)) continue
      const key = `${row.table_name}.${row.constraint_name}`
      if (key in PERMISSIVE_OVER_NULL) continue
      for (const column of referencedColumns(row)) {
        if (!nullable.get(`${row.table_name}.${column}`)) continue
        // The guard has to be in the clause. Whether it is positioned ahead of
        // the comparison is what the refusal tests prove; this is the cheap
        // half, and it is the half that fails on a constraint nobody has run a
        // NULL through yet.
        const guarded = new RegExp('`' + column + '`\\s+is\\s+not\\s+null', 'i').test(row.check_clause)
        if (!guarded) unguarded.push(`${key} compares nullable ${column} with no IS NOT NULL guard`)
      }
    }
    // This is the 013 bug as a rule. `quantity > 0` against a NULL is UNKNOWN,
    // and a CHECK admits UNKNOWN, so the constraint enforced nothing for the one
    // row shape it existed to refuse.
    expect(unguarded).toEqual([])
  })
})

describe('the twelve json_valid constraints, left permissive on purpose', () => {
  it('is reachable by a NULL on exactly the eight nullable columns', () => {
    const reachable = checks
      .filter(isAutoJsonCheck)
      .map((row) => `${row.table_name}.${row.constraint_name}`)
      .filter((key) => nullable.get(key))
      .sort()

    // The other four are NOT NULL (settings.value_json, site_pages.content_json,
    // site_pages.schema_types, site_page_revisions.content_json), so the NULL
    // shape cannot arise and the question does not apply to them.
    expect(reachable).toEqual([...NULLABLE_JSON_COLUMNS])
  })

  it('evaluates to UNKNOWN over NULL and to FALSE over every other non-JSON', async () => {
    const probe = await sql<{ over_null: number | null; over_empty: number; over_text: number; over_object: number }>`
      select
        json_valid(null) as over_null,
        json_valid('') as over_empty,
        json_valid('nope') as over_text,
        json_valid('{}') as over_object
    `.execute(db)
    const row = probe.rows[0]
    // UNKNOWN, so the CHECK admits it. This is the same rule that made 013
    // vacuous -- here it is the wanted behaviour, because a nullable JSON column
    // means the document may be absent.
    expect(row?.over_null).toBe(null)
    // FALSE, so the CHECK refuses it. Note the empty string: a form field that
    // submits '' is not a JSON document, which is why src/lib/json.ts writes
    // NULL rather than '' for an absent value.
    expect(Number(row?.over_empty)).toBe(0)
    expect(Number(row?.over_text)).toBe(0)
    expect(Number(row?.over_object)).toBe(1)
  })

  it('accepts a NULL and refuses malformed text on a real nullable column', async () => {
    const insert = (detail: string | null) =>
      sql`
        insert into dashboard_daily_snapshot (snapshot_date, metric_key, detail_json)
        values (${SENTINEL_DATE}, ${SENTINEL_KEY}, ${detail})
      `.execute(db)

    await expect(insert(null)).resolves.toBeDefined()
    await sql`delete from dashboard_daily_snapshot where metric_key = ${SENTINEL_KEY}`.execute(db)

    for (const bad of ['', 'nope', '{unquoted: 1}']) {
      const err = await insert(bad).then(
        () => null,
        (e: { message?: string; errno?: number }) => e
      )
      expect(err, `json_valid admitted ${JSON.stringify(bad)}`).not.toBe(null)
      expect(err?.message).toMatch(/detail_json/)
      expect(err?.errno).toBe(4025)
    }

    const left = await sql<{ n: number }>`
      select count(*) as n from dashboard_daily_snapshot where metric_key = ${SENTINEL_KEY}
    `.execute(db)
    expect(Number(left.rows[0]?.n)).toBe(0)
  })
})

describe('the three-valued rule that made 013 vacuous', () => {
  it('gives UNKNOWN for the clause 013 wrote and FALSE for the one 014 wrote', async () => {
    // The two clauses verbatim, with a measured row that carries no quantity
    // substituted in. Not a paraphrase of DECISIONS.md 19.3 -- the argument
    // itself, evaluated by the server that admitted the row.
    const probe = await sql<{ as_013: number | null; as_014: number | null }>`
      select
        (('per_sqft' = 'per_day' and null is null)
          or ('per_sqft' <> 'per_day' and null > 0)) as as_013,
        (('per_sqft' = 'per_day' and null is null)
          or ('per_sqft' <> 'per_day' and null is not null and null > 0)) as as_014
    `.execute(db)
    const row = probe.rows[0]
    expect(row?.as_013).toBe(null)
    expect(Number(row?.as_014)).toBe(0)
  })

  it('gives FALSE for AND with a NULL only when the other side is FALSE', async () => {
    // Why ordering the guard first is the whole fix: `FALSE AND NULL` is FALSE,
    // so `quantity IS NOT NULL AND quantity > 0` collapses to FALSE on a NULL,
    // where `quantity > 0` alone stays UNKNOWN and is admitted.
    const probe = await sql<{ f_and_n: number | null; t_and_n: number | null; f_or_n: number | null }>`
      select (false and null) as f_and_n, (true and null) as t_and_n, (false or null) as f_or_n
    `.execute(db)
    expect(Number(probe.rows[0]?.f_and_n)).toBe(0)
    expect(probe.rows[0]?.t_and_n).toBe(null)
    expect(probe.rows[0]?.f_or_n).toBe(null)
  })
})
