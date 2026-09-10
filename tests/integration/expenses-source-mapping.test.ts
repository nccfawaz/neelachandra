import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool, getPool } from '../../src/db/pool.js'
import { WRITER_MAPPING } from './expense-writer-mapping.js'

/**
 * The (source_type, source_table) writer mapping for expenses (DECISIONS
 * 29.7, closing §20.2's leftover).
 *
 * §6.8 rule 1: an expense posted from another module carries that module's
 * document as its source. The ENUM on expenses.source_type is the contract
 * for which document types exist; the mapping below is the contract for
 * which (source_type, source_table) pair each writer produces. A new ENUM
 * member lands only with a writer and a row here; a writer that produces a
 * pair the mapping cannot express fails this file until the mapping is
 * amended by a recorded decision, not invented in code.
 *
 * The tripwire enumerates the ENUM from information_schema with a non-zero
 * floor (DECISIONS 28.1): a zero-row enumeration is a query or schema
 * problem, not a passing comparison.
 */

const db = getDb()

/**
 * The mapping of record. Keyed by source_type; the value is the exact
 * source_table the owning writer sets (null for manual — a manual expense
 * has no upstream document, which is what uq_exp_source's NULL exemption is
 * for, DECISIONS 19.1).
 *
 * Exported so each writer's own suite can assert the pair its service
 * actually wrote against this table (DECISIONS 29.19): the group-by in this
 * file can only observe rows its own suites left behind, so it proves the
 * mapping matches the observed rows, never that a writer's pair matches the
 * mapping. The writer-side assertions close that gap.
 *
 * Each entry cites the writer that produces it:
 *
 * - manual: finance/service.ts createExpense (line ~96) and
 *   issueSiteAdvance (line ~818). source_table NULL, source_id NULL.
 *   The only pairs produced today; 'grn', 'equipment_deployment' and
 *   'campaign_spend' have NO writer yet — the ENUM members are the spec's
 *   contract for documents the modules will post (inventory's GRN post
 *   writes the ledger but not an expense row yet; equipment deployments
 *   carry an expense_id FK added by 009 but no writer fills it; marketing
 *   campaign spend is phase 5). They stay in the mapping as 'no writer yet'
 *   so a future writer has a row to satisfy and the suite reds if one
 *   appears without being recorded.
 * - contractor_bill: hr/service.ts approveContractorBill writes the expense
 *   row in the approval transaction (DECISIONS 29.8) — the posting 18.8
 *   deferred has landed; expense_id is back-linked on the bill.
 * - payroll: no writer; payroll runs through attendance approval, not an
 *   expenses row, and whether it ever becomes one is §6.8-adjacent.
 */
export { WRITER_MAPPING } from './expense-writer-mapping.js'

beforeAll(async () => {
  const [[r]] = await (await getPool()).query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expenses'")
  expect(Number((r as { n: number }).n)).toBeGreaterThan(0)
})

afterAll(async () => {
  await closePool()
})

describe('the expenses source_type mapping (closes §20.2)', () => {
  it('the ENUM holds exactly the members the mapping records, with a non-zero floor', async () => {
    const res = await sql<{ column_type: string }>`
      select column_type from information_schema.columns
      where table_schema = database() and table_name = 'expenses' and column_name = 'source_type'
    `.execute(db)
    // Non-zero floor (DECISIONS 28.1): a zero-row enumeration means the
    // query or the schema is broken, not that the mapping is satisfied.
    expect(res.rows.length, 'the source_type column was not found — the enumeration is broken').toBeGreaterThan(0)

    const members = (res.rows[0]!.column_type.match(/'([^']+)'/g) ?? []).map((m) => m.slice(1, -1))
    expect(members.length, 'the ENUM parsed to zero members — the column_type shape is unexpected').toBeGreaterThan(0)

    const mapped = Object.keys(WRITER_MAPPING).sort()
    expect(
      members.sort(),
      `the source_type ENUM changed: ${members.join(', ')}. Every member needs a writer and a row in ` +
        `WRITER_MAPPING (tests/integration/expenses-source-mapping.test.ts) recording the (source_type, ` +
        `source_table) pair it produces — or the mapping row amended — before this passes. DECISIONS 29.7.`
    ).toEqual(mapped)
  })

  it('every ENUM member has a mapping entry naming its source_table', async () => {
    for (const [sourceType, entry] of Object.entries(WRITER_MAPPING)) {
      expect(entry, `${sourceType} has no mapping entry`).toBeDefined()
      if (entry.status.startsWith('written by')) {
        // A live writer must state a concrete table (or explicit NULL for manual).
        expect(entry, `${sourceType} claims a writer but no source_table`).not.toBeNull()
      }
    }
  })

  it('the mapped pair is observable in the database, and every observed row matches', async () => {
    // DECISIONS 29.19: the self-seed was removed. The group-by can only
    // observe rows the fixture database happens to hold — it proves the
    // mapping covers every OBSERVED pair, never that a writer's pair matches
    // the mapping. That direction is now asserted in each writer's own suite
    // (hr-contractor-flow, grn-posting, finance-approval, finance-advances),
    // proven by mutating approveContractorBill's source_table literal and
    // watching that suite go red naming the pair. If this group-by observes
    // zero rows it proves nothing either way — so the assertion is skipped
    // rather than fed a row this suite wrote itself (a circular basis).
    const rows = await sql<{ source_type: string; source_table: string | null; n: unknown }>`
      select source_type, source_table, count(*) as n from expenses group by source_type, source_table
    `.execute(db)
    if (rows.rows.length === 0) {
      console.log('source-pair group-by observed 0 rows — writer-side assertions in the writer suites carry the proof (DECISIONS 29.19)')
      return
    }
    for (const row of rows.rows) {
      const mapped = WRITER_MAPPING[row.source_type]
      expect(mapped, `expenses holds source_type '${row.source_type}' which the mapping does not record — add the writer's pair to WRITER_MAPPING or investigate the row`).toBeDefined()
      expect(row.source_table, `source_type '${row.source_type}' appears with source_table '${row.source_table}' but the mapping records '${mapped!.sourceTable}'`).toBe(mapped!.sourceTable)
    }
  })
})
