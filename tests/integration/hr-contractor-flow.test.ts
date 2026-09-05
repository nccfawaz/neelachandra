import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { addDays, today } from '../../src/lib/dates.js'
import { parseJsonColumn } from '../../src/lib/json.js'
import { getSetting } from '../../src/lib/settings.js'
import * as q from '../../src/modules/hr/queries.js'
import * as svc from '../../src/modules/hr/service.js'
import {
  contractorAttendanceSchema,
  contractorBillGenerateSchema,
  contractorPeriodSchema,
  contractorRateSchema,
  contractorSchema,
  type ContractorAttendanceInput,
} from '../../src/modules/hr/schemas.js'

/*
 * Contractor labour and bills (spec 6.6 rules 2 and 3), executed against MariaDB.
 *
 * What is here that tsc and the pure suite cannot reach:
 *
 *   - `uq_ca (contractor_id, project_id, attendance_date, skill_level, work_type)`,
 *     widened by migration 016. recordContractorAttendance chooses insert or
 *     update from a prior SELECT, and choosing wrong is a duplicate-key 500 on the
 *     second post of a day -- which is the ordinary case, a gate clerk correcting a
 *     headcount. Since 016 the prior SELECT is keyed on the PAIR, so a day holding
 *     two measured rows at one skill level is where getting it wrong now shows.
 *     Every member of the key is NOT NULL, and that is load bearing rather than
 *     tidy: a UNIQUE index treats a row with NULL in an indexed column as distinct
 *     from every other row, so a nullable member would not widen the key, it would
 *     punch a hole in it.
 *   - The rate resolution is four SQL predicates and a JS sort. Whether a project
 *     rate really outranks a company-wide one, and whether an `effective_to` a
 *     day in the past really drops out, is a question only the server answers.
 *   - The whole point of the bill: `bill_id` is stamped under a
 *     `WHERE bill_id IS NULL` guard and the update count is compared to the row
 *     count. That guard has no meaning without concurrent-safe SQL behind it.
 *   - Money. `applyPct` runs in JS over BIGINT columns mysql2 returns as STRINGS,
 *     and gross/retention/TDS/net have to still add up after a round trip.
 *   - `nextNumber` writes to `document_numbering` inside the same transaction, so
 *     two bills in one financial year have to come back with consecutive serials.
 *   - The identity finance will key on: `contractor_bills.id`. A bill that
 *     generated but left `expense_id` non-NULL, or whose id moved, would break
 *     6.8 rule 1 before it is written.
 *   - Measured work (migration 013). A per-sqft amount is a rate times a
 *     DECIMAL(14,3) that arrives as a string, the rate is chosen by work type
 *     rather than by skill level, and `chk_ca_quantity` is a CHECK constraint --
 *     none of the three is visible to tsc or to the pure suite.
 *
 * Fixtures. Two obviously fake contractors, one fake login, one client and two
 * projects, removed afterwards by id above a high-water mark captured before
 * anything is written. No `employees` row is created anywhere in this file and
 * none is read: that separation is the subject of the first test.
 *
 * Dates are fixed and in the past, because recording a future day is refused.
 * 2026-08 is used throughout so nothing here collides with hr-attendance-flow's
 * 2026-09, and both suites run in one fork. The measured-work block at the end
 * has 2026-06 and a third contractor to itself, for the same reason.
 */

const db = getDb()

/** Child before parent. This is also the delete order in cleanup. */
const TRACKED = [
  'contractor_attendance',
  'contractor_bills',
  'expenses',
  'contractor_rates',
  'labour_contractors',
  'document_numbering',
  'approval_limits',
  'projects',
  'clients',
  'audit_log',
  'users',
] as const

const highWater = new Map<string, number>()

/* The period every bill in this file covers, and the days inside it. */
const FROM = '2026-08-03'
const TO = '2026-08-08'
const DAY_1 = '2026-08-03'
const DAY_2 = '2026-08-04'
const DAY_3 = '2026-08-05'
/** Outside FROM..TO, so a bill for the period must not touch it. */
const OUTSIDE = '2026-08-17'

/* The measured-work period, its own contractor and its own dates. 2026-06 is
   used rather than a gap inside 2026-08, because several assertions above are
   counts over a period and a stray row would move them -- and 2026-07 is the
   empty range the "nothing to approve" refusal is asserted against. */
const M_FROM = '2026-06-08'
const M_TO = '2026-06-13'
const M_DAY_1 = '2026-06-08'
const M_DAY_2 = '2026-06-09'
/** The day two work types share one skill level, which 016 made recordable. */
const M_DAY_3 = '2026-06-10'

let actor = { userId: 0, ip: '127.0.0.1' as string | null }
let otherActor = { userId: 0, ip: '127.0.0.1' as string | null }

let clientId = 0
let projectId = 0
let otherProjectId = 0

/* Anna is compliant and does the work. Boru's licence expired last year, which
   is what the override branch needs. */
let annaId = 0
let boruId = 0

let firstBillId = 0
let firstBillNo = ''
let secondBillNo = ''

/**
 * A fake role key for the approval limit. `approval_limits.role_key` is a free
 * VARCHAR with no FK to `roles`, so this row is invisible to every real role and
 * is deleted with the rest of the fixtures. Nothing here seeds a real limit:
 * 8.2 has not supplied the figures.
 */
const LIMIT_ROLE = 'fixture_contractor_approver'

function contractorInput(over: Record<string, unknown>) {
  return contractorSchema.parse({
    name: 'Fixture Contractor',
    status: 'active',
    ...over,
  })
}

function rateInput(over: Record<string, unknown>) {
  return contractorRateSchema.parse({
    workType: 'General labour',
    uom: 'per_day',
    effectiveFrom: '2026-04-01',
    ...over,
  })
}

/**
 * The entry grid as the browser posts it: repeated fields, blanks for none.
 *
 * All six row names are posted on every call, including the three that arrived
 * with 013, because the screen emits a value for each of them on every rendered
 * line -- hidden inputs on the day grid -- and index alignment across the two
 * grids is exactly what would break if a caller emitted five.
 */
function day(
  date: string,
  contractorId: number,
  rows: Array<{ skill: string; headcount: string; ot?: string; uom?: string; work?: string; qty?: string }>,
  opts: { projectId?: number; override?: boolean } = {}
) {
  return contractorAttendanceSchema.parse({
    contractorId: String(contractorId),
    projectId: String(opts.projectId ?? projectId),
    attendanceDate: date,
    skillLevel: rows.map((r) => r.skill),
    uom: rows.map((r) => r.uom ?? 'per_day'),
    workType: rows.map((r) => r.work ?? ''),
    headcount: rows.map((r) => r.headcount),
    quantity: rows.map((r) => r.qty ?? ''),
    overtimeHours: rows.map((r) => r.ot ?? ''),
    ...(opts.override ? { overrideCompliance: 'on' } : {}),
  })
}

function period(contractorId: number, over: Record<string, unknown> = {}) {
  return contractorPeriodSchema.parse({
    contractorId: String(contractorId),
    projectId: String(projectId),
    from: FROM,
    to: TO,
    ...over,
  })
}

function billInput(contractorId: number, over: Record<string, unknown> = {}) {
  return contractorBillGenerateSchema.parse({
    contractorId: String(contractorId),
    projectId: String(projectId),
    from: FROM,
    to: TO,
    ...over,
  })
}

/**
 * The serial off the end of a bill number. Absolute serials are not asserted:
 * `document_numbering` keeps a row per financial year and a crashed earlier run
 * would leave it advanced, so what matters is that consecutive bills are
 * consecutive.
 */
function serialOf(billNo: string): number {
  return Number(billNo.split('/').pop())
}

/**
 * The one attendance row for a contractor, day and skill, or undefined.
 *
 * Since migration 016 a skill level is no longer unique within a day -- masons
 * plastering and masons tiling are two rows -- so this returns the ONLY row where
 * there is one and throws where there is more than one, rather than quietly
 * returning whichever the server listed first. Callers that mean a particular line
 * use `line()` and name the work type.
 */
async function cell(contractorId: number, date: string, skill: string) {
  const rows = await lines(contractorId, date, skill)
  if (rows.length > 1) {
    throw new Error(
      `cell(${date}, ${skill}) matched ${rows.length} rows (${rows
        .map((r) => `'${r.work_type}'`)
        .join(', ')}); name the work type with line() instead`
    )
  }
  return rows[0]
}

/** The row for a contractor, day, skill AND work type: the whole key of uq_ca. */
async function line(contractorId: number, date: string, skill: string, workType: string) {
  return (await lines(contractorId, date, skill)).find((r) => r.work_type === workType)
}

async function lines(contractorId: number, date: string, skill: string) {
  return db
    .selectFrom('contractor_attendance')
    .select([
      'id',
      'project_id',
      'uom',
      'work_type',
      'headcount',
      'quantity',
      'overtime_hours',
      'rate_paise',
      'amount_paise',
      'approved_by',
      'approved_at',
      'bill_id',
    ])
    .where('contractor_id', '=', contractorId)
    .where('attendance_date', '=', date)
    .where('skill_level', '=', skill as 'mason')
    .orderBy('id')
    .execute()
}

/** The newest audit entry for an action, with its JSON payload parsed. */
async function lastAudit(action: string) {
  const row = await db
    .selectFrom('audit_log')
    .select(['id', 'action', 'entity_type', 'entity_id', 'after_json'])
    .where('action', '=', action)
    .orderBy('id', 'desc')
    .executeTakeFirst()
  if (row === undefined) return undefined
  // Through the helper, not JSON.parse: MariaDB holds JSON as LONGTEXT and the
  // column arrives as a string, which is the whole reason src/lib/json.ts exists.
  return { ...row, payload: (parseJsonColumn(row.after_json) ?? {}) as Record<string, unknown> }
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const user = await db
    .insertInto('users')
    .values({
      email: 'fixture.contractor.officer@example.invalid',
      full_name: 'Fixture Contractor Officer',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  actor = { userId: Number(user.insertId ?? 0), ip: '127.0.0.1' }

  // A second login, because self-approval is refused and the bill has to be
  // approved by somebody who did not raise it.
  const other = await db
    .insertInto('users')
    .values({
      email: 'fixture.contractor.approver@example.invalid',
      full_name: 'Fixture Contractor Approver',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  otherActor = { userId: Number(other.insertId ?? 0), ip: '127.0.0.1' }

  const client = await db
    .insertInto('clients')
    .values({
      code: 'FIXCL-CON',
      name: 'Fixture Client for contractors',
      client_type: 'company',
      city: 'Bengaluru',
    })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)

  const project = await db
    .insertInto('projects')
    .values({
      code: 'FIXPR-CON',
      name: 'Fixture project for contractors',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 8, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: actor.userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)

  // A second site, so "a project rate beats a company-wide one" has a project
  // it does NOT apply to.
  const otherProject = await db
    .insertInto('projects')
    .values({
      code: 'FIXPR-CON2',
      name: 'Second fixture project for contractors',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 9, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: actor.userId,
    })
    .executeTakeFirst()
  otherProjectId = Number(otherProject.insertId ?? 0)

  annaId = await svc.createContractor(
    db,
    actor,
    contractorInput({
      code: 'FIXLC-ANNA',
      name: 'Fixture Labour Supply Anna',
      pan: 'AAAPA1234A',
      tradeSpecialisation: 'Masonry and finishing',
      licenceNo: 'FIX/LIC/ANNA',
      licenceValidUntil: '2027-03-31',
      wcPolicyNo: 'FIX/WC/ANNA',
      wcPolicyValidUntil: '2027-03-31',
      esiRegistered: 'on',
      pfRegistered: 'on',
    })
  )

  // Licence and WC both lapsed in 2025, so every day in 2026-08 needs the
  // override. Nothing else about Boru differs.
  boruId = await svc.createContractor(
    db,
    actor,
    contractorInput({
      code: 'FIXLC-BORU',
      name: 'Fixture Labour Supply Boru',
      licenceNo: 'FIX/LIC/BORU',
      licenceValidUntil: '2025-03-31',
      wcPolicyNo: 'FIX/WC/BORU',
      wcPolicyValidUntil: '2025-03-31',
    })
  )
})

afterAll(async () => {
  // contractor_attendance.bill_id is RESTRICT and every _by column points at
  // users with RESTRICT, so the order in TRACKED is load-bearing.
  for (const table of TRACKED) {
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
})

/**
 * The separation is the whole reason this table exists rather than a flag on
 * `employees`, and it is a property of the schema rather than of the code, so it
 * is worth one test that fails loudly if anybody adds a link.
 */
describe('contractor labour is structurally separate from the employee master', () => {
  it('has no employee column anywhere in the four contractor tables', async () => {
    const rows = await sql<{ TABLE_NAME: string; COLUMN_NAME: string }>`
      select TABLE_NAME, COLUMN_NAME from information_schema.COLUMNS
      where TABLE_SCHEMA = database()
        and TABLE_NAME in ('labour_contractors','contractor_rates','contractor_attendance','contractor_bills')
        and (COLUMN_NAME like '%employee%' or COLUMN_NAME like '%aadhaar%')
    `.execute(db)
    expect(rows.rows).toEqual([])
  })

  it('creates no employees row for a contractor', async () => {
    const before = await db
      .selectFrom('employees')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow()
    const id = await svc.createContractor(
      db,
      actor,
      contractorInput({ code: 'FIXLC-TMP', name: 'Fixture Contractor Temporary' })
    )
    const after = await db
      .selectFrom('employees')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow()
    expect(Number(after.n)).toBe(Number(before.n))
    await db.deleteFrom('labour_contractors').where('id', '=', id).execute()
  })

  it('refuses a duplicate code and names who holds it', async () => {
    await expect(
      svc.createContractor(db, actor, contractorInput({ code: 'FIXLC-ANNA', name: 'Fixture Impostor' }))
    ).rejects.toThrow(/already belongs to Fixture Labour Supply Anna/)
  })
})

/**
 * The rate card. Every assertion here is about which of several overlapping rows
 * `applicableRate` picks, which is four SQL predicates plus a JS sort and cannot
 * be checked without the server doing the comparing.
 */
describe('the rate card', () => {
  it('accepts a company-wide per-day rate and a dearer one for one project', async () => {
    // 500/day everywhere, 620/day on the fixture project, and the claim under test
    // is that the project rate wins where it applies.
    //
    // Its basis is spec :1644, `contractor_rates.project_id BIGINT UNSIGNED NULL`,
    // and it is an inference from that column rather than a stated rule: a rate
    // whose project scope may be NULL is one that can be company-wide, and a
    // project-specific rate would price nothing if the company-wide one outranked
    // it. §6.6's numbered rules do not say which wins. This comment cited "Rule 2"
    // by number until 2026-09-05; rule 2 (:1743) is the bill-generation rule and
    // says nothing about rate precedence, so the citation was wrong about which
    // rule as well as being a number rather than a line. DECISIONS 20.3.
    await svc.addContractorRate(
      db,
      actor,
      annaId,
      rateInput({ skillLevel: 'mason', rate: '500', workType: 'Brickwork' })
    )
    await svc.addContractorRate(
      db,
      actor,
      annaId,
      rateInput({ skillLevel: 'mason', rate: '620', workType: 'Brickwork', projectId: String(projectId) })
    )
    await svc.addContractorRate(
      db,
      actor,
      annaId,
      rateInput({ skillLevel: 'helper', rate: '380', workType: 'General labour' })
    )
    await svc.addContractorRate(
      db,
      actor,
      boruId,
      rateInput({ skillLevel: 'helper', rate: '400', workType: 'General labour' })
    )

    const rates = await q.contractorRates(db, annaId)
    expect(rates).toHaveLength(3)
    expect(rates.map((r) => r.rate_paise).sort((a, b) => a - b)).toEqual([38000, 50000, 62000])
  })

  it('prefers the project rate on that project and the company rate elsewhere', async () => {
    const here = await q.applicableRate(db, {
      contractorId: annaId,
      projectId,
      skillLevel: 'mason',
      onDate: DAY_1,
    })
    const there = await q.applicableRate(db, {
      contractorId: annaId,
      projectId: otherProjectId,
      skillLevel: 'mason',
      onDate: DAY_1,
    })
    expect(here).toMatchObject({ ratePaise: 62000, projectId, ambiguous: false })
    expect(there).toMatchObject({ ratePaise: 50000, projectId: null, ambiguous: false })
  })

  it('closes the earlier open line when a later rate supersedes it', async () => {
    // A raise from 2026-08-06, so DAY_1..DAY_3 straddle the change.
    await svc.addContractorRate(
      db,
      actor,
      annaId,
      rateInput({
        skillLevel: 'helper',
        rate: '420',
        workType: 'General labour',
        effectiveFrom: '2026-08-06',
      })
    )
    const helper = (await q.contractorRates(db, annaId)).filter((r) => r.skill_level === 'helper')
    const closed = helper.find((r) => r.rate_paise === 38000)
    const open = helper.find((r) => r.rate_paise === 42000)
    expect(closed?.effective_to).toBe(addDays('2026-08-06', -1))
    expect(open?.effective_to).toBeNull()

    // And the resolution follows the dates, not the insert order.
    expect(await q.applicableRate(db, { contractorId: annaId, projectId, skillLevel: 'helper', onDate: DAY_1 }))
      .toMatchObject({ ratePaise: 38000 })
    expect(
      await q.applicableRate(db, { contractorId: annaId, projectId, skillLevel: 'helper', onDate: '2026-08-07' })
    ).toMatchObject({ ratePaise: 42000 })
  })

  it('refuses a second line starting on the same day rather than guessing', async () => {
    await expect(
      svc.addContractorRate(
        db,
        actor,
        annaId,
        rateInput({ skillLevel: 'helper', rate: '450', workType: 'General labour', effectiveFrom: '2026-08-06' })
      )
    ).rejects.toThrow(/already/i)
  })

  it('has no rate for a skill nobody priced, so that day cannot be recorded', async () => {
    expect(
      await q.applicableRate(db, { contractorId: annaId, projectId, skillLevel: 'plumber', onDate: DAY_1 })
    ).toBeUndefined()
    await expect(
      svc.recordContractorAttendance(db, actor, day(DAY_1, annaId, [{ skill: 'plumber', headcount: '2' }]), {
        canManageContractors: true,
      })
    ).rejects.toThrow(/plumber/i)
  })
})

/**
 * Recording a day. The subject is `uq_ca` and the insert/update branch: a gate
 * clerk correcting a headcount is the ordinary second post of a day, not an edge
 * case, and getting the branch wrong is a duplicate-key 500.
 */
describe('recording a day of contractor labour', () => {
  it('writes one row per skill, priced from the project rate', async () => {
    const result = await svc.recordContractorAttendance(
      db,
      actor,
      day(DAY_1, annaId, [
        { skill: 'mason', headcount: '4' },
        { skill: 'helper', headcount: '6', ot: '3' },
      ]),
      { canManageContractors: true }
    )
    expect(result).toMatchObject({ inserted: 2, updated: 0, headcount: 10 })
    // 4 masons at the 620 project rate, 6 helpers at the 380 company rate.
    expect(result.grossPaise).toBe(4 * 62000 + 6 * 38000)
    expect(result.complianceOverride).toEqual([])
    expect(result.ambiguousRates).toEqual([])

    const mason = await cell(annaId, DAY_1, 'mason')
    expect(mason).toMatchObject({ headcount: 4, bill_id: null, approved_at: null })
    // The snapshot: rate_paise is stored, not joined, so the day keeps its price.
    expect(Number(mason?.rate_paise)).toBe(62000)
    expect(Number(mason?.amount_paise)).toBe(248000)
    const helper = await cell(annaId, DAY_1, 'helper')
    expect(Number(helper?.rate_paise)).toBe(38000)
    expect(Number(helper?.overtime_hours)).toBe(3)
  })

  it('updates rather than inserting on the second post of the same day', async () => {
    const result = await svc.recordContractorAttendance(
      db,
      actor,
      day(DAY_1, annaId, [{ skill: 'mason', headcount: '5' }]),
      { canManageContractors: true }
    )
    expect(result).toMatchObject({ inserted: 0, updated: 1, headcount: 5 })
    const mason = await cell(annaId, DAY_1, 'mason')
    expect(mason).toMatchObject({ headcount: 5 })
    expect(Number(mason?.amount_paise)).toBe(5 * 62000)
    // The helper row is untouched: a blank headcount writes nothing.
    expect(await cell(annaId, DAY_1, 'helper')).toMatchObject({ headcount: 6 })
  })

  it('refuses a day that has not happened yet', async () => {
    await expect(
      svc.recordContractorAttendance(
        db,
        actor,
        day(addDays(today(), 1), annaId, [{ skill: 'mason', headcount: '2' }]),
        { canManageContractors: true }
      )
    ).rejects.toThrow(/has not happened yet/)
  })

  it('refuses an expired licence without an override, and records the reasons with one', async () => {
    await expect(
      svc.recordContractorAttendance(db, actor, day(DAY_1, boruId, [{ skill: 'helper', headcount: '3' }]), {
        canManageContractors: true,
      })
    ).rejects.toThrow(/labour licence expired|licence/i)

    const forced = await svc.recordContractorAttendance(
      db,
      actor,
      day(DAY_1, boruId, [{ skill: 'helper', headcount: '3' }], { override: true }),
      { canManageContractors: true }
    )
    expect(forced.inserted).toBe(1)
    expect(forced.complianceOverride).toHaveLength(2)

    const audit = await lastAudit('hr.contractor_attendance_record')
    expect(audit?.payload['compliance_override']).toHaveLength(2)
  })

  it('refuses the override to somebody without hr.labour_contractor_manage', async () => {
    await expect(
      svc.recordContractorAttendance(
        db,
        actor,
        day(DAY_2, boruId, [{ skill: 'helper', headcount: '3' }], { override: true }),
        { canManageContractors: false }
      )
    ).rejects.toThrow(/hr\.labour_contractor_manage/)
    expect(await cell(boruId, DAY_2, 'helper')).toBeUndefined()
  })

  it('refuses a blacklisted contractor with no override at all', async () => {
    await db.updateTable('labour_contractors').set({ status: 'blacklisted' }).where('id', '=', boruId).execute()
    await expect(
      svc.recordContractorAttendance(
        db,
        actor,
        day(DAY_2, boruId, [{ skill: 'helper', headcount: '3' }], { override: true }),
        { canManageContractors: true }
      )
    ).rejects.toThrow(/no override for this one/)
    await db.updateTable('labour_contractors').set({ status: 'active' }).where('id', '=', boruId).execute()
  })
})

/**
 * Approving attendance. Not a spec route -- rule 2 bills only rows whose
 * `approved_at` is set and the 6.6 route table gives nothing that sets it, so
 * this path is an addition recorded in DECISIONS 18.3. It is load-bearing, so it
 * is exercised here.
 */
describe('approving a period of contractor attendance', () => {
  it('refuses a period with nothing in it', async () => {
    await expect(
      svc.approveContractorAttendance(db, actor, period(annaId, { from: '2026-07-01', to: '2026-07-31' }))
    ).rejects.toThrow(/nothing to approve/)
  })

  it('approves every unapproved row in the period and leaves the rest alone', async () => {
    await svc.recordContractorAttendance(
      db,
      actor,
      day(DAY_2, annaId, [
        { skill: 'mason', headcount: '3' },
        { skill: 'helper', headcount: '5' },
      ]),
      { canManageContractors: true }
    )

    const result = await svc.approveContractorAttendance(db, otherActor, period(annaId))
    // DAY_1 mason + DAY_1 helper + DAY_2 mason + DAY_2 helper.
    expect(result).toMatchObject({ approved: 4, alreadyApproved: 0 })
    expect(result.grossPaise).toBe(5 * 62000 + 6 * 38000 + 3 * 62000 + 5 * 38000)

    const mason = await cell(annaId, DAY_1, 'mason')
    expect(mason?.approved_at).not.toBeNull()
    expect(Number(mason?.approved_by)).toBe(otherActor.userId)
    // Boru's day sits in the same period on the same project but a different
    // contractor, so it must still be unapproved.
    expect(await cell(boruId, DAY_1, 'helper')).toMatchObject({ approved_at: null })
  })

  it('refuses when the whole period is already approved', async () => {
    await expect(svc.approveContractorAttendance(db, otherActor, period(annaId))).rejects.toThrow(
      /already approved/
    )
  })

  it('clears the approval when an approved row is corrected', async () => {
    // The figure that was approved is not the figure the row now carries, so the
    // approval cannot stand. This is the assertion that a UPDATE ... SET
    // approved_by = NULL really runs.
    const result = await svc.recordContractorAttendance(
      db,
      actor,
      day(DAY_2, annaId, [{ skill: 'mason', headcount: '4' }]),
      { canManageContractors: true }
    )
    expect(result.updated).toBe(1)
    expect(await cell(annaId, DAY_2, 'mason')).toMatchObject({ approved_at: null, approved_by: null })

    // Put it back, so the bill below has a fully approved period.
    const again = await svc.approveContractorAttendance(db, otherActor, period(annaId))
    expect(again).toMatchObject({ approved: 1, alreadyApproved: 3 })
  })
})

/**
 * Generating the bill (6.6 rule 2). This is the money, and none of it can be
 * checked without the server: the gross is summed from `amount_paise` columns
 * mysql2 hands back as strings, retention and TDS are computed in JS by
 * `applyPct`, and the four figures have to still add up after the round trip
 * into BIGINT and out again.
 */
describe('generating a contractor bill', () => {
  it('refuses while an unapproved row sits inside the period', async () => {
    // A third day, left unapproved on purpose. The helper rate on 2026-08-05 is
    // still 380 -- the 420 line starts on the 6th -- so this also checks the
    // snapshot follows the date and not the newest rate.
    const added = await svc.recordContractorAttendance(
      db,
      actor,
      day(DAY_3, annaId, [
        { skill: 'mason', headcount: '2' },
        { skill: 'helper', headcount: '3' },
      ]),
      { canManageContractors: true }
    )
    expect(added).toMatchObject({ inserted: 2, updated: 0 })
    expect(added.grossPaise).toBe(2 * 62000 + 3 * 38000)
    expect(Number((await cell(annaId, DAY_3, 'helper'))?.rate_paise)).toBe(38000)

    // Not "bills the other four and skips these": a bill that quietly left them
    // out would keep bill_id NULL and no later period covers those dates.
    await expect(svc.generateContractorBill(db, actor, billInput(annaId))).rejects.toThrow(
      /2 rows are not approved yet, the earliest on 2026-08-05/
    )
  })

  it('shows the same figure on the form as the bill it generates', async () => {
    const before = await q.unbilledSummary(db, { contractorId: annaId, projectId, from: FROM, to: TO })
    expect(before).toEqual({
      rows: 4,
      days: 2,
      headcountDays: 5 + 6 + 4 + 5,
      overtimeHours: 3,
      grossPaise: 5 * 62000 + 6 * 38000 + 4 * 62000 + 5 * 38000,
      unapproved: 2,
    })

    expect(await svc.approveContractorAttendance(db, otherActor, period(annaId))).toMatchObject({
      approved: 2,
      alreadyApproved: 4,
    })

    const after = await q.unbilledSummary(db, { contractorId: annaId, projectId, from: FROM, to: TO })
    expect(after).toEqual({
      rows: 6,
      days: 3,
      headcountDays: 25,
      overtimeHours: 3,
      grossPaise: 1214000,
      unapproved: 0,
    })
  })

  it('bills the period at the settings percentages and stamps every row', async () => {
    // Stated rather than assumed: 011 converted these two from DECIMAL percents
    // to basis points, so 500 here means 5%.
    const retentionBp = Number(await getSetting(db, 'finance.retention_default_pct', 0))
    const tdsBp = Number(await getSetting(db, 'finance.tds_default_pct', 0))
    expect([retentionBp, tdsBp]).toEqual([500, 200])

    const bill = await svc.generateContractorBill(db, actor, billInput(annaId))
    firstBillId = bill.billId
    firstBillNo = bill.billNo

    expect(bill.billNo).toMatch(/^NCC\/CB\/2026-27\/\d{3,}$/)
    expect(bill).toMatchObject({ rows: 6, days: 3, retentionBp: 500, tdsBp: 200, noPan: false })
    expect(bill.grossPaise).toBe(1214000)
    expect(bill.retentionPaise).toBe(60700)
    expect(bill.tdsPaise).toBe(24280)
    expect(bill.netPayablePaise).toBe(1214000 - 60700 - 24280)

    // Read back through the query the page uses, so the BIGINT round trip is
    // part of the assertion rather than the in-memory result being trusted.
    const row = await q.findContractorBill(db, bill.billId)
    expect(row).toMatchObject({
      bill_no: bill.billNo,
      contractor_id: annaId,
      project_id: projectId,
      period_from: FROM,
      period_to: TO,
      status: 'draft',
      approved_at: null,
      expense_id: null,
      contractor_code: 'FIXLC-ANNA',
      project_code: 'FIXPR-CON',
    })
    expect(row!.gross_paise - row!.retention_paise - row!.tds_paise).toBe(row!.net_payable_paise)

    // Rule 2's actual mechanism. bill_id is stamped on all six rows under a
    // WHERE bill_id IS NULL guard, which is what stops a day reaching two bills
    // -- there is no unique index on the period to do it.
    const lines = await q.contractorAttendance(db, { billId: bill.billId })
    expect(lines).toHaveLength(6)
    expect(lines.every((l) => l.bill_no === bill.billNo)).toBe(true)
    expect(lines.reduce((sum, l) => sum + l.amount_paise, 0)).toBe(1214000)
    expect(await q.unbilledSummary(db, { contractorId: annaId, projectId, from: FROM, to: TO })).toMatchObject({
      rows: 0,
      grossPaise: 0,
    })
  })

  it('will not let a billed day be corrected', async () => {
    await expect(
      svc.recordContractorAttendance(db, actor, day(DAY_1, annaId, [{ skill: 'mason', headcount: '7' }]), {
        canManageContractors: true,
      })
    ).rejects.toThrow(/already on bill NCC\/CB\/2026-27\//)
    expect(await cell(annaId, DAY_1, 'mason')).toMatchObject({ headcount: 5 })
  })

  it('refuses a second bill for a period it has already swept', async () => {
    await expect(svc.generateContractorBill(db, actor, billInput(annaId))).rejects.toThrow(
      /no approved unbilled attendance/i
    )
  })

  it('takes the next serial in the year and rounds the deductions half up', async () => {
    // 437.50 a day exists so the arithmetic has a tie in it: 1% of 43750 paise is
    // exactly 437.5, which roundPaise has to take upward, and 7.5% is 3281.25,
    // which it has to take down. Every rate above is a round multiple of 2000
    // paise and can never round at all.
    await svc.addContractorRate(
      db,
      actor,
      annaId,
      rateInput({ skillLevel: 'carpenter', rate: '437.50', workType: 'Shuttering', effectiveFrom: '2026-08-01' })
    )
    await svc.recordContractorAttendance(
      db,
      actor,
      day(OUTSIDE, annaId, [{ skill: 'carpenter', headcount: '1' }]),
      { canManageContractors: true }
    )
    await svc.approveContractorAttendance(db, otherActor, period(annaId, { from: OUTSIDE, to: OUTSIDE }))

    const bill = await svc.generateContractorBill(
      db,
      actor,
      billInput(annaId, {
        from: OUTSIDE,
        to: OUTSIDE,
        retentionPct: '7.5',
        tdsPct: '1',
        advanceRecovered: '100',
        penalty: '50.25',
      })
    )
    secondBillNo = bill.billNo

    expect(bill).toMatchObject({ rows: 1, days: 1, retentionBp: 750, tdsBp: 100 })
    expect(bill.grossPaise).toBe(43750)
    expect(bill.retentionPaise).toBe(3281)
    expect(bill.tdsPaise).toBe(438)
    expect(bill.netPayablePaise).toBe(43750 - 10000 - 3281 - 438 - 5025)

    expect(serialOf(bill.billNo)).toBe(serialOf(firstBillNo) + 1)

    // The first bill's period ended on the 8th, so the 17th was never inside it.
    const first = await q.findContractorBill(db, firstBillId)
    expect(first).toMatchObject({ gross_paise: 1214000, period_to: TO })
    const stored = await q.findContractorBill(db, bill.billId)
    expect(stored).toMatchObject({
      penalty_paise: 5025,
      advance_recovered_paise: 10000,
      retention_paise: 3281,
      tds_paise: 438,
      net_payable_paise: 25006,
    })
  })

  it('refuses deductions larger than the bill, and burns no bill number doing it', async () => {
    // Boru's one overridden day, approved now so it can be billed.
    expect(await svc.approveContractorAttendance(db, otherActor, period(boruId))).toMatchObject({ approved: 1 })

    await expect(
      svc.generateContractorBill(db, actor, billInput(boruId, { penalty: '5000' }))
    ).rejects.toThrow(/cannot be negative|more than the bill/i)

    // The refusal rolls back inside the transaction that took the number, so the
    // next bill still gets the next serial rather than skipping one.
    const bill = await svc.generateContractorBill(db, actor, billInput(boruId))
    expect(serialOf(bill.billNo)).toBe(serialOf(secondBillNo) + 1)
    expect(bill.grossPaise).toBe(3 * 40000)
    expect(bill.retentionPaise).toBe(6000)
    expect(bill.tdsPaise).toBe(2400)
    expect(bill.netPayablePaise).toBe(120000 - 6000 - 2400)
    // No PAN, so 206AA's 20% would apply if it were implemented. It is not: the
    // flag is raised for the screen and DECISIONS 18.7 records it.
    expect(bill.noPan).toBe(true)
  })
})

/**
 * Approving the bill (6.6 route table, "+ limit"). The reason this is worth a
 * server test is that it is the last HR step before 6.8 rule 1, and the row it
 * leaves behind is what finance will key on.
 */
describe('approving a contractor bill', () => {
  it('refuses the person who generated it, before it even looks at the limit', async () => {
    await expect(svc.approveContractorBill(db, actor, firstBillId, [LIMIT_ROLE])).rejects.toThrow(
      /you generated bill/i
    )
  })

  it('refuses every amount while approval_limits is empty', async () => {
    // This is the state the running system is in today: 8.2 has not supplied the
    // figures, the table is seeded empty, and so nothing can be approved. The
    // refusal has to say so rather than reading a missing row as unlimited.
    await expect(svc.approveContractorBill(db, otherActor, firstBillId, [LIMIT_ROLE])).rejects.toThrow(
      /No expense approval limit is set for your role/
    )
    // A user holding no roles at all is the same refusal, not a crash.
    await expect(svc.approveContractorBill(db, otherActor, firstBillId, [])).rejects.toThrow(
      /No expense approval limit is set/
    )
  })

  it('measures the gross, not the net payable, against the limit', async () => {
    await db
      .insertInto('approval_limits')
      .values({
        role_key: LIMIT_ROLE,
        document_type: 'expense',
        max_value: 1000000,
        requires_second_approval_above: null,
        effective_from: '2026-04-01',
      })
      .execute()

    // Gross 12,140.00 against a 10,000.00 limit. The net payable is 11,290.20,
    // which is also above it -- but a limit of 11,500.00 would pass on the net
    // and fail on the gross, and the gross is the cost committed.
    await expect(svc.approveContractorBill(db, otherActor, firstBillId, [LIMIT_ROLE])).rejects.toThrow(
      /12,140\.00 is above your approval limit of .*10,000\.00/
    )
    expect(await q.findContractorBill(db, firstBillId)).toMatchObject({ status: 'draft', approved_at: null })
  })

  it('approves within the limit and leaves the finance identity behind', async () => {
    await db
      .updateTable('approval_limits')
      .set({ max_value: 2000000 })
      .where('role_key', '=', LIMIT_ROLE)
      .execute()

    const result = await svc.approveContractorBill(db, otherActor, firstBillId, [LIMIT_ROLE])
    expect(result).toMatchObject({
      billNo: firstBillNo,
      grossPaise: 1214000,
      netPayablePaise: 1129020,
      limitRoleKey: LIMIT_ROLE,
    })

    const row = await q.findContractorBill(db, firstBillId)
    expect(row).toMatchObject({ status: 'approved', expense_id: null })
    expect(row!.approved_at).not.toBeNull()

    // The point of the slice. 6.8 rule 1 is not built, so `expense_id` is still
    // NULL and no expenses row exists -- but the identity it will post against
    // is recorded, and it is the bill's own id.
    const audit = await lastAudit('hr.contractor_bill_approve')
    expect(audit).toMatchObject({ entity_type: 'contractor_bill', entity_id: firstBillId })
    expect(audit?.payload).toMatchObject({
      status: 'approved',
      bill_no: firstBillNo,
      gross_paise: 1214000,
      limit_document_type: 'expense',
      limit_role_key: LIMIT_ROLE,
      finance_source_type: 'contractor_bill',
      finance_source_table: 'contractor_bills',
      finance_source_id: firstBillId,
      expense_id: null,
    })

    const posted = await db
      .selectFrom('expenses')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('source_table', '=', 'contractor_bills')
      .where('source_id', '=', firstBillId)
      .executeTakeFirstOrThrow()
    expect(Number(posted.n)).toBe(0)
  })

  it('refuses to approve the same bill twice', async () => {
    await expect(svc.approveContractorBill(db, otherActor, firstBillId, [LIMIT_ROLE])).rejects.toThrow(
      /is approved\. Only a bill that has not been approved/
    )
  })

  it('refuses rather than writing one signature where two are required', async () => {
    // contractor_bills has one approved_by and no second_approved_by, unlike
    // purchase_orders and expenses. Above the threshold the only honest answers
    // are refuse or add the column, and inventing the column mid-slice is worse.
    // TRIPWIRE: when a second-approval column lands, this test fails. DECISIONS
    // 18.9 describes what the code does; 21.2 is the reclassification and lists
    // what replaces it -- a `pending_approval` member on contractor_bills.status,
    // the second_approved_by/at pair, and the branch at
    // inventory/service.ts:1379-1426 copied. Both notes need updating together.
    await db
      .updateTable('approval_limits')
      .set({ requires_second_approval_above: 40000 })
      .where('role_key', '=', LIMIT_ROLE)
      .execute()

    const second = await db
      .selectFrom('contractor_bills')
      .select('id')
      .where('bill_no', '=', secondBillNo)
      .executeTakeFirstOrThrow()

    await expect(svc.approveContractorBill(db, otherActor, Number(second.id), [LIMIT_ROLE])).rejects.toThrow(
      /no column for a second approval/
    )
    expect(await q.findContractorBill(db, Number(second.id))).toMatchObject({ status: 'draft' })
  })

})

/**
 * The constraint 6.8 rule 1 promises, asserted before 6.8 exists.
 *
 * Migration 012 replaced `KEY idx_exp_source` with `UNIQUE KEY uq_exp_source`.
 * Rule 1's wording is "a unique index on (source_table, source_id) where both are
 * non-null", and MariaDB has no partial index for that clause -- it does not need
 * one, because a UNIQUE index already treats a row with a NULL in an indexed
 * column as distinct from every other row. So the permissiveness over NULLs below
 * is the requirement being met rather than a gap in it, and the manual expense
 * class rule 1 ends on keeps working.
 *
 * These live in this file because slice 3 is where the divergence was found:
 * `contractor_bills.id` is the first identity that will be posted through that
 * pair. DECISIONS 19.1.
 */
describe('the double-posting constraint 6.8 rule 1 promises', () => {
  let expenseSeq = 0

  /** Only the five columns that are NOT NULL without a default. */
  async function insertExpense(over: Record<string, unknown> = {}) {
    expenseSeq += 1
    return db
      .insertInto('expenses')
      .values({
        expense_no: `FIXEXP/${expenseSeq}`,
        expense_date: DAY_1,
        expense_type: 'labour_contractor',
        payee_type: 'contractor',
        created_by: actor.userId,
        ...over,
      })
      .executeTakeFirst()
  }

  it('indexes (source_table, source_id) uniquely, under a uq_ name', async () => {
    const idx = await sql<{ INDEX_NAME: string; NON_UNIQUE: number }>`
      select distinct INDEX_NAME, NON_UNIQUE from information_schema.STATISTICS
      where TABLE_SCHEMA = database() and TABLE_NAME = 'expenses'
        and COLUMN_NAME in ('source_table', 'source_id')
    `.execute(db)
    expect(idx.rows.map((r) => ({ name: r.INDEX_NAME, nonUnique: Number(r.NON_UNIQUE) }))).toEqual([
      { name: 'uq_exp_source', nonUnique: 0 },
    ])
  })

  it('still permits any number of rows with no source document', async () => {
    // Direct entry: statutory fees, professional fees, site overheads, travel.
    // There is no upstream row to be unique against and there are many of them.
    for (let i = 0; i < 3; i += 1) await insertExpense({ source_type: 'manual' })

    // Half a pair used to be exempt by the same NULL rule, and this test used to
    // assert that it was -- the 012 comment claimed it, so it was pinned rather
    // than assumed. Migration 015 closed it: a row naming a source table with no
    // id claims to be a posting and points at nothing, which a UNIQUE index
    // cannot refuse because the row is wrong on its own rather than a duplicate
    // of another. See DECISIONS.md 20.2. The exemption that remains is the one
    // that was wanted: any number of rows with the whole pair NULL.
    for (let i = 0; i < 2; i += 1) {
      const err = await insertExpense({ source_table: 'contractor_bills' }).then(
        () => null,
        (e: { message?: string; errno?: number }) => e
      )
      expect(err, 'a half-populated source pair was admitted').not.toBe(null)
      expect(err?.message).toMatch(/chk_exp_source_pair/)
      expect(err?.errno).toBe(4025)
    }

    const n = await db
      .selectFrom('expenses')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('source_id', 'is', null)
      .where('expense_no', 'like', 'FIXEXP/%')
      .executeTakeFirstOrThrow()
    expect(Number(n.n)).toBe(3)
  })

  it('refuses a second post of the same document in the database, not in code', async () => {
    expect(firstBillId).toBeGreaterThan(0)
    await insertExpense({
      source_type: 'contractor_bill',
      source_table: 'contractor_bills',
      source_id: firstBillId,
    })

    // No service call anywhere in this test: the second insert is the same
    // statement as the first and the refusal comes off the wire. errno 1062 with
    // the constraint name in the message is the proof of which layer said no --
    // an application check would throw a ConflictError with prose instead.
    let err: (Error & { code?: string; errno?: number }) | undefined
    try {
      await insertExpense({
        source_type: 'contractor_bill',
        source_table: 'contractor_bills',
        source_id: firstBillId,
      })
    } catch (caught) {
      err = caught as Error & { code?: string; errno?: number }
    }
    expect(err?.code).toBe('ER_DUP_ENTRY')
    expect(err?.errno).toBe(1062)
    expect(err?.message).toMatch(/uq_exp_source/)

    const posted = await db
      .selectFrom('expenses')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('source_table', '=', 'contractor_bills')
      .where('source_id', '=', firstBillId)
      .executeTakeFirstOrThrow()
    expect(Number(posted.n)).toBe(1)
  })
})

/**
 * Measured work reaching a bill (migration 013, DECISIONS 19.2).
 *
 * Before 013 the rate card offered five UOMs and `contractor_attendance` could
 * price exactly one of them, because the only multiplier it held was a headcount.
 * Four fifths of the card was unreachable: an interiors contractor billing
 * plastering by the sqft had nowhere to put the sqft.
 *
 * What needs the server rather than the pure suite:
 *
 *   - The rate is chosen by WORK TYPE, not by skill level. Two per-sqft lines for
 *     one contractor, both skill-less, both open, is the ordinary case, and which
 *     one `applicableRate` returns is four SQL predicates and a sort.
 *   - `quantity` is DECIMAL(14,3) and comes back as a string. The amount is a
 *     BIGINT of paise computed from it in JS, so the multiplication happens on
 *     something mysql2 typed as text.
 *   - `chk_ca_quantity` is a CHECK constraint. It is the only one of the three
 *     gates on this rule that no application code can be bypassed to reach.
 *   - `uq_ca` as migration 016 widened it, which is a consequence of 013 rather
 *     than a separate subject: once a measured row must name its work type, a key
 *     without work_type refuses one gang plastering and tiling on one day. The two
 *     tests before the bill are the permitted pair and the refused duplicate, and
 *     both are statements about an index that only the server holds.
 *
 * Its own contractor, its own dates and its own project-free rates, so that none
 * of the period counts asserted above move.
 */
describe('a measured rate reaches a bill (migration 013)', () => {
  let chitId = 0

  const PLASTER = 'Internal plastering'
  const CEILING = 'False ceiling'
  const PCC = 'PCC 1:4:8'

  /** 45.50 a sqft, 240.5 sqft: 4550 x 240.5 is a whole number of paise. */
  const PLASTER_PAISE = 4550
  const PLASTER_QTY = 240.5
  const PLASTER_AMOUNT = 1_094_275

  /** 6750.75 a cum, 3.5 cum: 2362762.5 paise, a tie roundPaise takes upward. */
  const PCC_PAISE = 675075
  const PCC_QTY = 3.5
  const PCC_AMOUNT = 2_362_763

  /* The two lines one gang of masons works on M_DAY_3, which is the pair migration
     016 exists for. Both are whole numbers of paise, because rounding is the
     subject of the test above and not of this one. */
  const CEILING_PAISE = 9600
  const CEILING_QTY = 42.5
  const CEILING_AMOUNT = 408_000
  const PLASTER_QTY_2 = 100
  const PLASTER_AMOUNT_2 = 455_000

  /** One ordinary day row in the same period, so the bill mixes both kinds. */
  const HELPER_DAY_AMOUNT = 3 * 40000

  /* Three dates for migration 017, deliberately OUTSIDE M_FROM..M_TO so that the
     rows the basis tests leave behind do not move the bill's row count or gross. */
  const M_DAY_4 = '2026-06-20'
  const M_DAY_5 = '2026-06-21'
  const M_DAY_6 = '2026-06-22'

  /* The lumpsum line, migration 018, and one more date outside the period for the
     same reason. 25,000 rupees is the WHOLE agreed sum for the scope rather than a
     unit price, which is what makes a quantity beside it a defect and not a
     rounding question: at the 300 below the row carries 75,00,00,000 paise. */
  const SCAFFOLD = 'Scaffolding, full site'
  const SCAFFOLD_PAISE = 2_500_000
  const M_DAY_7 = '2026-06-23'

  beforeAll(async () => {
    chitId = await svc.createContractor(
      db,
      actor,
      contractorInput({
        code: 'FIXLC-CHIT',
        name: 'Fixture Interiors Chit',
        pan: 'AAAPC5678C',
        tradeSpecialisation: 'Plastering and false ceiling',
        licenceNo: 'FIX/LIC/CHIT',
        licenceValidUntil: '2027-03-31',
        wcPolicyNo: 'FIX/WC/CHIT',
        wcPolicyValidUntil: '2027-03-31',
      })
    )

    // Two per-sqft lines and a per-cum one, none naming a skill level: measured
    // work is quoted per unit regardless of who lays it, which is what a nullable
    // `contractor_rates.skill_level` is for. All three stay open, because
    // supersession is keyed on (work_type, uom, skill_level, project) and these
    // differ in work type.
    await svc.addContractorRate(
      db,
      actor,
      chitId,
      rateInput({ uom: 'per_sqft', workType: PLASTER, rate: '45.50', effectiveFrom: '2026-04-01' })
    )
    await svc.addContractorRate(
      db,
      actor,
      chitId,
      rateInput({ uom: 'per_sqft', workType: CEILING, rate: '96', effectiveFrom: '2026-04-01' })
    )
    await svc.addContractorRate(
      db,
      actor,
      chitId,
      rateInput({ uom: 'per_cum', workType: PCC, rate: '6750.75', effectiveFrom: '2026-04-01' })
    )
    await svc.addContractorRate(
      db,
      actor,
      chitId,
      rateInput({ skillLevel: 'helper', rate: '400', workType: 'General labour', effectiveFrom: '2026-04-01' })
    )

    // The fifth member of the spec's UOM enum (`NCC_BUILD_SPEC.md:1645`), which
    // §18.2 recorded as unreachable and 013 made billable. No skill level: a lump
    // sum for a scope is not priced against who does it. The rate is the whole sum.
    await svc.addContractorRate(
      db,
      actor,
      chitId,
      rateInput({ uom: 'lumpsum', workType: SCAFFOLD, rate: '25000', effectiveFrom: '2026-04-01' })
    )
  })

  it('picks the per-sqft line by work type, and says so when the work type is missing', async () => {
    const plaster = await q.applicableRate(db, {
      contractorId: chitId,
      projectId,
      skillLevel: 'mason',
      onDate: M_DAY_1,
      uom: 'per_sqft',
      workType: PLASTER,
    })
    expect(plaster).toMatchObject({ ratePaise: PLASTER_PAISE, workType: PLASTER, uom: 'per_sqft', ambiguous: false })

    const ceiling = await q.applicableRate(db, {
      contractorId: chitId,
      projectId,
      skillLevel: 'mason',
      onDate: M_DAY_1,
      uom: 'per_sqft',
      workType: CEILING,
    })
    expect(ceiling).toMatchObject({ ratePaise: 9600, workType: CEILING, ambiguous: false })

    // Both lines tie on scope, skill and start date, so without a work type
    // there is nothing left to decide it. The caller is told rather than refused,
    // and this is why the schema requires a work type on a measured row.
    const blind = await q.applicableRate(db, {
      contractorId: chitId,
      projectId,
      skillLevel: 'mason',
      onDate: M_DAY_1,
      uom: 'per_sqft',
    })
    expect(blind?.ambiguous).toBe(true)

    // The day rate is a different UOM and must not be reachable from a per-sqft
    // ask, nor the other way round.
    expect(
      await q.applicableRate(db, {
        contractorId: chitId,
        projectId,
        skillLevel: 'helper',
        onDate: M_DAY_1,
        uom: 'per_sqft',
        workType: 'General labour',
      })
    ).toBeUndefined()
    expect(
      await q.applicableRate(db, { contractorId: chitId, projectId, skillLevel: 'helper', onDate: M_DAY_1 })
    ).toMatchObject({ ratePaise: 40000, uom: 'per_day' })
  })

  it('writes a measured row and a day row from one post, pricing each its own way', async () => {
    const result = await svc.recordContractorAttendance(
      db,
      actor,
      day(
        M_DAY_1,
        chitId,
        [
          { skill: 'mason', headcount: '2', uom: 'per_sqft', work: PLASTER, qty: String(PLASTER_QTY) },
          { skill: 'helper', headcount: '3' },
        ],
        { projectId }
      ),
      { canManageContractors: true }
    )
    expect(result).toMatchObject({ inserted: 2, updated: 0, headcount: 5 })
    expect(result.grossPaise).toBe(PLASTER_AMOUNT + HELPER_DAY_AMOUNT)

    const mason = await cell(chitId, M_DAY_1, 'mason')
    expect(mason).toMatchObject({ uom: 'per_sqft', work_type: PLASTER, headcount: 2, bill_id: null })
    expect(Number(mason?.quantity)).toBe(PLASTER_QTY)
    expect(Number(mason?.rate_paise)).toBe(PLASTER_PAISE)
    // The point of the migration: the amount is rate x quantity, and the
    // headcount of 2 multiplies nothing.
    expect(Number(mason?.amount_paise)).toBe(PLASTER_AMOUNT)

    // The day row beside it is untouched by any of that, and still carries no
    // quantity at all rather than a 0 that would look like a measure. Its work type
    // is '' rather than NULL since 016, because it is a member of uq_ca and a key
    // member that can be NULL is not a key member.
    const helper = await cell(chitId, M_DAY_1, 'helper')
    expect(helper).toMatchObject({ uom: 'per_day', work_type: '', quantity: null, headcount: 3 })
    expect(Number(helper?.amount_paise)).toBe(HELPER_DAY_AMOUNT)

    const audit = await lastAudit('hr.contractor_attendance_record')
    expect(audit?.payload['rows']).toEqual([
      `mason:2 @${PLASTER_QTY} per_sqft (${PLASTER})`,
      'helper:3',
    ])
  })

  it('rounds a measured amount half up, the same way a deduction is rounded', async () => {
    const result = await svc.recordContractorAttendance(
      db,
      actor,
      day(M_DAY_2, chitId, [{ skill: 'mason', headcount: '4', uom: 'per_cum', work: PCC, qty: String(PCC_QTY) }], {
        projectId,
      }),
      { canManageContractors: true }
    )
    // 675075 x 3.5 is exactly 2362762.5 paise. Half a paise cannot be stored and
    // is not silently truncated by the BIGINT column: roundPaise takes it up.
    expect(result.grossPaise).toBe(PCC_AMOUNT)
    const row = await cell(chitId, M_DAY_2, 'mason')
    expect(row).toMatchObject({ uom: 'per_cum', work_type: PCC })
    expect(Number(row?.quantity)).toBe(PCC_QTY)
    expect(Number(row?.rate_paise)).toBe(PCC_PAISE)
    expect(Number(row?.amount_paise)).toBe(PCC_AMOUNT)
  })

  it('refuses a measured row with no quantity, naming the unit', async () => {
    // Built as a service input rather than through the schema, because the schema
    // refuses this first and the service gate has to hold on its own -- it is
    // what stands between a route that grew a new caller and a wrong amount.
    const input: ContractorAttendanceInput = {
      contractorId: chitId,
      projectId,
      attendanceDate: M_FROM,
      rows: [{ skillLevel: 'painter', uom: 'per_sqft', workType: PLASTER, headcount: 2, quantity: null, overtimeHours: 0 }],
      overrideCompliance: false,
    }
    await expect(svc.recordContractorAttendance(db, actor, input, { canManageContractors: true })).rejects.toThrow(
      /quoted per sqft, so it needs a quantity above zero to price/
    )
    expect(await cell(chitId, M_FROM, 'painter')).toBeUndefined()

    // And the mirror: a day row carrying a quantity states a multiplier nothing
    // reads, so it is refused rather than ignored. The work type goes back to ''
    // for this one, because since 016 a day row that names work is refused by an
    // earlier gate and would answer the wrong question here.
    await expect(
      svc.recordContractorAttendance(
        db,
        actor,
        { ...input, rows: [{ ...input.rows[0]!, uom: 'per_day', workType: '', quantity: 12 }] },
        { canManageContractors: true }
      )
    ).rejects.toThrow(/quoted per day/)

    // A measured row that does not say what work it is for cannot pick between
    // the two per-sqft lines, so it is refused before a rate is chosen.
    await expect(
      svc.recordContractorAttendance(
        db,
        actor,
        { ...input, rows: [{ ...input.rows[0]!, workType: '', quantity: 30 }] },
        { canManageContractors: true }
      )
    ).rejects.toThrow(/does not say what work it is for/)
  })

  it('is refused by chk_ca_quantity in both directions, with no application code involved', async () => {
    const constraint = await sql<{ CONSTRAINT_NAME: string; CHECK_CLAUSE: string }>`
      select CONSTRAINT_NAME, CHECK_CLAUSE from information_schema.CHECK_CONSTRAINTS
      where CONSTRAINT_SCHEMA = database() and TABLE_NAME = 'contractor_attendance'
    `.execute(db)
    const clause = constraint.rows.find((r) => r.CONSTRAINT_NAME === 'chk_ca_quantity')?.CHECK_CLAUSE
    // The presence test is not enough, and this test is the reason 014 exists: as
    // 013 wrote it the clause ended `quantity > 0`, which against a NULL is
    // UNKNOWN rather than FALSE, and a CHECK admits UNKNOWN. The one row the
    // constraint existed to refuse was the one row it let through. TRIPWIRE: if
    // this match fails, read the migration that last touched the constraint
    // before trusting the three refusals below.
    expect(clause).toMatch(/quantity` is not null/)

    /** Only the columns that are NOT NULL without a default. */
    const insert = (over: Record<string, unknown>) =>
      db
        .insertInto('contractor_attendance')
        .values({
          contractor_id: chitId,
          project_id: projectId,
          attendance_date: M_TO,
          skill_level: 'barbender',
          headcount: 1,
          rate_paise: PLASTER_PAISE,
          amount_paise: PLASTER_PAISE,
          recorded_by: actor.userId,
          ...over,
        })
        .executeTakeFirst()

    const failure = async (over: Record<string, unknown>) => {
      let err: (Error & { errno?: number }) | undefined
      try {
        await insert(over)
      } catch (caught) {
        err = caught as Error & { errno?: number }
      }
      // 4025 is ER_CONSTRAINT_FAILED. Asserted with the constraint name because
      // that pair is the proof of which layer refused: an application check would
      // arrive as an UnprocessableError carrying prose.
      expect(err?.message).toMatch(/chk_ca_quantity/)
      expect(err?.errno).toBe(4025)
      return err
    }

    // A measured row with nothing to multiply, which is the row the third gate in
    // generateContractorBill exists for and which this constraint now makes
    // unreachable through any path at all.
    await failure({ uom: 'per_sqft', work_type: PLASTER, quantity: null })
    // Zero is not a measure either: the clause is `quantity > 0`, not NOT NULL.
    await failure({ uom: 'per_sqft', work_type: PLASTER, quantity: 0 })
    // And the mirror, in the database this time.
    await failure({ uom: 'per_day', quantity: 5 })

    const left = await db
      .selectFrom('contractor_attendance')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('contractor_id', '=', chitId)
      .where('attendance_date', '=', M_TO)
      .executeTakeFirstOrThrow()
    expect(Number(left.n)).toBe(0)
  })

  it('pins a lumpsum quantity to 1 in the database, and chk_ca_quantity is what refuses 300 (migration 018)', async () => {
    // TRIPWIRE, the same one the test above needs for a different clause. Every
    // refusal below is asserted to be this constraint's, so the clause is read off
    // the live server before any of them runs: if 018 were never applied the four
    // inserts would land and the failure would read as a wrong expectation rather
    // than as a missing migration.
    const clause = (
      await sql<{ CONSTRAINT_NAME: string; CHECK_CLAUSE: string }>`
        select CONSTRAINT_NAME, CHECK_CLAUSE from information_schema.CHECK_CONSTRAINTS
        where CONSTRAINT_SCHEMA = database() and TABLE_NAME = 'contractor_attendance'
      `.execute(db)
    ).rows.find((r) => r.CONSTRAINT_NAME === 'chk_ca_quantity')?.CHECK_CLAUSE
    expect(clause).toMatch(/lumpsum/)
    expect(clause).toMatch(/`quantity` = 1/)
    // And 014's guard is still a sibling conjunct of the new one, which is the only
    // reason the NULL case below is refused: `(uom <> 'lumpsum' OR quantity = 1)`
    // against a NULL quantity is UNKNOWN on its own, and a CHECK admits UNKNOWN.
    // `FALSE AND UNKNOWN` is FALSE, so what does the work is that the guard sits in
    // the same AND as the disjunction rather than inside one of its branches -- not
    // that it is written first. MariaDB promises no evaluation order and needs to
    // promise none. 19.3 is that bug; this is the fourth appearance of the class and
    // the first where the new conjunct was harmless only because an older one was
    // already there (DECISIONS 21.7). Anything that moves the lumpsum disjunct out
    // from under this guard stops refusing a NULL and says nothing while it does.
    expect(clause).toMatch(/`quantity` is not null/)

    const raw = (over: Record<string, unknown>) =>
      db
        .insertInto('contractor_attendance')
        .values({
          contractor_id: chitId,
          project_id: projectId,
          attendance_date: M_DAY_7,
          skill_level: 'barbender',
          uom: 'lumpsum',
          work_type: SCAFFOLD,
          headcount: 4,
          quantity: 1,
          rate_paise: SCAFFOLD_PAISE,
          amount_paise: SCAFFOLD_PAISE,
          recorded_by: actor.userId,
          ...over,
        })
        .executeTakeFirst()

    const refused = async (over: Record<string, unknown>) => {
      let err: (Error & { errno?: number }) | undefined
      try {
        await raw(over)
      } catch (caught) {
        err = caught as Error & { errno?: number }
      }
      // The constraint name and 4025 together are the proof of which layer said no.
      // The service's refusal is prose and carries no errno at all, which the
      // second half of this test asserts separately.
      expect(err?.message, 'a lumpsum quantity was admitted by the database').toMatch(/chk_ca_quantity/)
      expect(err?.errno).toBe(4025)
    }

    // The row that cost the most, and the one 014's clause admitted: the square
    // footage typed into the quantity box of a line whose rate_paise is a whole
    // contract sum. 25,00,000 x 300 is 75,00,00,000 paise.
    await refused({ quantity: 300, amount_paise: SCAFFOLD_PAISE * 300 })
    // Not a magnitude check. Two occurrences is the reading 19.2 implemented and is
    // refused too, because whether a lumpsum is due per occurrence at all is an
    // owner question (19.2's last paragraph, on the blocking list at 17.3). 018
    // makes the wrong answer unrepresentable rather than answering it.
    await refused({ quantity: 2, amount_paise: SCAFFOLD_PAISE * 2 })
    // Below one, which no reading of the unit makes sense of.
    await refused({ quantity: 0.999 })
    // And NULL, which is 014's guard rather than the new conjunct.
    await refused({ quantity: null })

    // The shape that must keep working. The basis for asserting a PERMITTED shape
    // here is the spec and not 018's own header: `NCC_BUILD_SPEC.md:1645` declares
    // `lumpsum` a member of the rate-card UOM enum, and §18.2 records a declared
    // unit that cannot reach a bill as a structural gap -- so a constraint that
    // made every lumpsum row unwritable would reopen that gap for one enum member.
    // DECISIONS 21.7 records the choice; this assertion does not rest on it.
    await raw({})
    const admitted = await line(chitId, M_DAY_7, 'barbender', SCAFFOLD)
    expect(Number(admitted?.quantity)).toBe(1)
    expect(Number(admitted?.amount_paise)).toBe(SCAFFOLD_PAISE)

    // The adjacent shape 018 must not have touched, and it needs its own basis:
    // DECISIONS 19.2 prices a measured row rate x quantity with the quantity a free
    // measure above zero. Per CLAUDE.md's second clause that citation covers
    // per_sqft and says nothing about lumpsum, which is why the line above cites
    // the spec instead of inheriting this one.
    await raw({
      uom: 'per_sqft',
      work_type: PLASTER,
      quantity: 300,
      rate_paise: PLASTER_PAISE,
      amount_paise: PLASTER_PAISE * 300,
    })
    expect(Number((await line(chitId, M_DAY_7, 'barbender', PLASTER))?.quantity)).toBe(300)

    await sql`delete from contractor_attendance where contractor_id = ${chitId} and attendance_date = ${M_DAY_7}`.execute(
      db
    )

    // The other half, and the half that has to be reachable without a form:
    // `contractorAttendanceSchema` supplies the 1, so no posted body can carry a
    // lumpsum quantity of 300 at all. A caller that builds rows itself can, and the
    // input is spread past the schema here exactly as the per-day mirror above does
    // it.
    const base = day(M_DAY_7, chitId, [{ skill: 'barbender', headcount: '4', uom: 'lumpsum', work: SCAFFOLD }])
    expect(base.rows[0]?.quantity).toBe(1)

    const typed = await svc
      .recordContractorAttendance(db, actor, { ...base, rows: [{ ...base.rows[0]!, quantity: 300 }] }, {
        canManageContractors: true,
      })
      .then(
        () => null,
        (e: Error & { errno?: number }) => e
      )
    expect(typed?.message).toMatch(/is a lumpsum, which is one agreed sum for the whole scope/)
    expect(typed?.message).toMatch(/so its quantity is 1 and not 300/)
    // No errno, so this refusal was not 4025 relayed off the wire: the service
    // refused before the insert. Same distinction 017's tests draw between the
    // trigger's 128-character message and the one a clerk should meet.
    expect(typed?.errno).toBeUndefined()
    expect(await lines(chitId, M_DAY_7, 'barbender')).toHaveLength(0)

    // Blank is refused as well, by the SAME gate and not by the general measured
    // one above it, which is the second thing this test pins. Left to that gate the
    // message read "it needs a quantity above zero to price" -- an instruction that,
    // followed on a lumpsum line, produces exactly the row 018 makes unwritable. So
    // the general gate steps around lumpsum and this branch has to be reachable.
    const blank = await svc
      .recordContractorAttendance(db, actor, { ...base, rows: [{ ...base.rows[0]!, quantity: null }] }, {
        canManageContractors: true,
      })
      .then(
        () => null,
        (e: Error) => e
      )
    expect(blank?.message).toMatch(/its quantity is 1 rather than blank/)
    expect(blank?.message).not.toMatch(/quantity above zero/)
    expect(await lines(chitId, M_DAY_7, 'barbender')).toHaveLength(0)

    // And the whole way through with nobody having typed a 1 anywhere. The
    // arithmetic is the same `rate x quantity` the other three measured units use,
    // which is why 018 pinned the quantity to 1 and not to NULL: there is no third
    // branch here to get wrong. The headcount of 4 multiplies nothing.
    expect(await svc.recordContractorAttendance(db, actor, base, { canManageContractors: true })).toMatchObject({
      inserted: 1,
      updated: 0,
      headcount: 4,
      grossPaise: SCAFFOLD_PAISE,
    })
    const priced = await line(chitId, M_DAY_7, 'barbender', SCAFFOLD)
    expect(priced).toMatchObject({ uom: 'lumpsum', work_type: SCAFFOLD, headcount: 4, bill_id: null })
    expect(Number(priced?.quantity)).toBe(1)
    expect(Number(priced?.rate_paise)).toBe(SCAFFOLD_PAISE)
    expect(Number(priced?.amount_paise)).toBe(SCAFFOLD_PAISE)
  })

  it('records two work types at one skill level on one day (migration 016)', async () => {
    // One gang of masons, one date, two rate-card lines. Before 016 uq_ca was
    // (contractor, project, date, skill_level) and this post was a duplicate-key
    // 500 on its second row: the table could not record ordinary interiors work.
    const result = await svc.recordContractorAttendance(
      db,
      actor,
      day(
        M_DAY_3,
        chitId,
        [
          { skill: 'mason', headcount: '4', uom: 'per_sqft', work: PLASTER, qty: String(PLASTER_QTY_2) },
          { skill: 'mason', headcount: '2', uom: 'per_sqft', work: CEILING, qty: String(CEILING_QTY) },
        ],
        { projectId }
      ),
      { canManageContractors: true }
    )
    expect(result).toMatchObject({ inserted: 2, updated: 0, headcount: 6 })
    expect(result.grossPaise).toBe(PLASTER_AMOUNT_2 + CEILING_AMOUNT)

    // Each line keeps its OWN rate and its own measure. This is the assertion that
    // would fail if either the prior-row map or the rate lookup still keyed on
    // skill level alone: both rows would price off whichever line won.
    const plaster = await line(chitId, M_DAY_3, 'mason', PLASTER)
    expect(plaster).toMatchObject({ uom: 'per_sqft', headcount: 4, bill_id: null })
    expect(Number(plaster?.quantity)).toBe(PLASTER_QTY_2)
    expect(Number(plaster?.rate_paise)).toBe(PLASTER_PAISE)
    expect(Number(plaster?.amount_paise)).toBe(PLASTER_AMOUNT_2)

    const ceiling = await line(chitId, M_DAY_3, 'mason', CEILING)
    expect(ceiling).toMatchObject({ uom: 'per_sqft', headcount: 2, bill_id: null })
    expect(Number(ceiling?.quantity)).toBe(CEILING_QTY)
    expect(Number(ceiling?.rate_paise)).toBe(CEILING_PAISE)
    expect(Number(ceiling?.amount_paise)).toBe(CEILING_AMOUNT)
    expect(plaster?.id).not.toBe(ceiling?.id)

    // The second post of the day is the ordinary case, and it is the case the
    // widened key makes delicate: the update branch chooses by (skill, work type),
    // so correcting the plastering headcount must leave the ceiling row alone.
    const again = await svc.recordContractorAttendance(
      db,
      actor,
      day(
        M_DAY_3,
        chitId,
        [
          { skill: 'mason', headcount: '5', uom: 'per_sqft', work: PLASTER, qty: String(PLASTER_QTY_2) },
          { skill: 'mason', headcount: '2', uom: 'per_sqft', work: CEILING, qty: String(CEILING_QTY) },
        ],
        { projectId }
      ),
      { canManageContractors: true }
    )
    expect(again).toMatchObject({ inserted: 0, updated: 2, headcount: 7 })
    expect(await line(chitId, M_DAY_3, 'mason', PLASTER)).toMatchObject({ id: plaster?.id, headcount: 5 })
    expect(await line(chitId, M_DAY_3, 'mason', CEILING)).toMatchObject({ id: ceiling?.id, headcount: 2 })
    // Still two rows: an update that had picked the wrong row would have left the
    // count right and the rows wrong, so the count alone is not the check.
    expect((await lines(chitId, M_DAY_3, 'mason')).length).toBe(2)

    const audit = await lastAudit('hr.contractor_attendance_record')
    expect(audit?.payload['rows']).toEqual([
      `mason:5 @${PLASTER_QTY_2} per_sqft (${PLASTER})`,
      `mason:2 @${CEILING_QTY} per_sqft (${CEILING})`,
    ])
  })

  it('still refuses the same skill level and work type twice, in the key itself', async () => {
    // TRIPWIRE, and the reason it is asserted rather than assumed: a UNIQUE index
    // treats a row with NULL in an indexed column as distinct from every other row.
    // Had 016 added `work_type` while it was still nullable, the key would have
    // stopped refusing two identical per-day rows -- the commonest shape in the
    // table -- in the course of permitting the pair above, and both would bill. If
    // this list or the NOT NULL fails, none of the refusals below mean anything.
    const key = await sql<{ COLUMN_NAME: string; NULLABLE: string }>`
      select COLUMN_NAME, NULLABLE from information_schema.STATISTICS
      where TABLE_SCHEMA = database() and TABLE_NAME = 'contractor_attendance'
        and INDEX_NAME = 'uq_ca'
      order by SEQ_IN_INDEX
    `.execute(db)
    expect(key.rows.map((r) => r.COLUMN_NAME)).toEqual([
      'contractor_id',
      'project_id',
      'attendance_date',
      'skill_level',
      'work_type',
    ])
    expect(key.rows.map((r) => r.NULLABLE)).toEqual(['', '', '', '', ''])

    // No service call: the same statement as the row that is already there, and the
    // refusal comes off the wire. 1062 with the key name in the message is the
    // proof of which layer said no.
    let err: (Error & { code?: string; errno?: number }) | undefined
    try {
      await db
        .insertInto('contractor_attendance')
        .values({
          contractor_id: chitId,
          project_id: projectId,
          attendance_date: M_DAY_3,
          skill_level: 'mason',
          uom: 'per_sqft',
          work_type: PLASTER,
          headcount: 1,
          quantity: 1,
          rate_paise: PLASTER_PAISE,
          amount_paise: PLASTER_PAISE,
          recorded_by: actor.userId,
        })
        .executeTakeFirst()
    } catch (caught) {
      err = caught as Error & { code?: string; errno?: number }
    }
    expect(err?.code).toBe('ER_DUP_ENTRY')
    expect(err?.errno).toBe(1062)
    expect(err?.message).toMatch(/uq_ca/)

    // The form refuses the pair before any of that, which is what a clerk meets.
    const posted = contractorAttendanceSchema.safeParse({
      contractorId: String(chitId),
      projectId: String(projectId),
      attendanceDate: M_DAY_3,
      skillLevel: ['mason', 'mason'],
      uom: ['per_sqft', 'per_sqft'],
      workType: [PLASTER, PLASTER],
      headcount: ['4', '4'],
      quantity: [String(PLASTER_QTY_2), '10'],
      overtimeHours: ['', ''],
    })
    expect(posted.success).toBe(false)

    // And the service, reached with the same pair the form would have refused: the
    // prior-row map is a SELECT taken before the loop, so the second row does not
    // see the first one's insert and the database is the only thing left to catch
    // it. The whole post is one transaction, so it rolls back rather than leaving
    // the first row of a pair behind.
    let svcErr: (Error & { errno?: number }) | undefined
    try {
      await svc.recordContractorAttendance(
        db,
        actor,
        {
          contractorId: chitId,
          projectId,
          attendanceDate: M_DAY_3,
          rows: [
            { skillLevel: 'mason', uom: 'per_cum', workType: PCC, headcount: 3, quantity: PCC_QTY, overtimeHours: 0 },
            { skillLevel: 'mason', uom: 'per_cum', workType: PCC, headcount: 3, quantity: PCC_QTY, overtimeHours: 0 },
          ],
          overrideCompliance: false,
        },
        { canManageContractors: true }
      )
    } catch (caught) {
      svcErr = caught as Error & { errno?: number }
    }
    expect(svcErr?.errno).toBe(1062)
    expect(await line(chitId, M_DAY_3, 'mason', PCC)).toBeUndefined()
    expect((await lines(chitId, M_DAY_3, 'mason')).length).toBe(2)
  })

  it('refuses a day rate beside a measured rate for one skill, in the database (migration 017)', async () => {
    // TRIPWIRE. Every refusal below is a trigger's, and a trigger is invisible to
    // `tsc`, to the Kysely types and to anyone reading the module. If it were
    // dropped or never applied, the four inserts under it would all succeed and the
    // test would still be asserting something -- so the triggers are asserted to
    // exist, by name and by timing, before any of them is exercised.
    const triggers = await sql<{ TRIGGER_NAME: string; ACTION_TIMING: string; EVENT_MANIPULATION: string }>`
      select TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION from information_schema.TRIGGERS
      where TRIGGER_SCHEMA = database() and EVENT_OBJECT_TABLE = 'contractor_attendance'
      order by TRIGGER_NAME
    `.execute(db)
    expect(
      triggers.rows.map((r) => `${r.TRIGGER_NAME} ${r.ACTION_TIMING} ${r.EVENT_MANIPULATION}`)
    ).toEqual(['trg_ca_basis_bi BEFORE INSERT', 'trg_ca_basis_bu BEFORE UPDATE'])

    const raw = (over: Record<string, unknown>) =>
      db
        .insertInto('contractor_attendance')
        .values({
          contractor_id: chitId,
          project_id: projectId,
          attendance_date: M_DAY_4,
          skill_level: 'helper',
          uom: 'per_day',
          work_type: '',
          headcount: 3,
          quantity: null,
          rate_paise: 40000,
          amount_paise: 120000,
          recorded_by: actor.userId,
          ...over,
        })
        .executeTakeFirst()
    const refusal = async (over: Record<string, unknown>) => {
      let err: (Error & { code?: string; errno?: number; sqlState?: string }) | undefined
      try {
        await raw(over)
      } catch (caught) {
        err = caught as Error & { code?: string; errno?: number; sqlState?: string }
      }
      expect(err, 'a day rate and a measured rate for one skill were both admitted').toBeDefined()
      return err
    }

    // No service call in this test at all. The day row goes in, the measured row
    // for the same skill on the same date comes back refused, and uq_ca is not what
    // refused it: ('', 'Internal plastering') are different key values and the test
    // above proves the key only refuses an identical pair. 1644 / 45000 with the
    // trigger name in the message is the proof of which layer said no.
    await raw({})
    const first = await refusal({ uom: 'per_sqft', work_type: PLASTER, quantity: 50, rate_paise: PLASTER_PAISE })
    expect(first?.errno).toBe(1644)
    expect(first?.sqlState).toBe('45000')
    expect(first?.message).toMatch(/trg_ca_basis/)

    // The other insertion order, which is the same rule and a different row. A
    // clerk who measures first and adds the gang afterwards must meet it too.
    await sql`delete from contractor_attendance where contractor_id = ${chitId} and attendance_date = ${M_DAY_4}`.execute(
      db
    )
    await raw({ uom: 'per_sqft', work_type: PLASTER, quantity: 50, rate_paise: PLASTER_PAISE })
    expect((await refusal({}))?.errno).toBe(1644)

    // And the UPDATE hole, which is why 017 installs two triggers rather than one.
    // A mason measured row moved onto `helper` lands on no existing key -- (helper,
    // 'Internal plastering') is free -- so uq_ca admits it, and it arrives beside
    // the helper day row as exactly the pair the insert trigger just refused.
    await raw({ skill_level: 'mason', headcount: 2, rate_paise: 40000 })
    let moved: (Error & { errno?: number; sqlState?: string }) | undefined
    try {
      await db
        .updateTable('contractor_attendance')
        .set({ skill_level: 'helper' })
        .where('contractor_id', '=', chitId)
        .where('attendance_date', '=', M_DAY_4)
        .where('skill_level', '=', 'mason')
        .execute()
    } catch (caught) {
      moved = caught as Error & { errno?: number; sqlState?: string }
    }
    expect(moved?.errno).toBe(1644)
    expect(moved?.sqlState).toBe('45000')

    // The ordinary update path still works, or the two triggers would have closed
    // the hole by closing the door: this is the same statement the service's update
    // branch runs, on a row whose own basis is changing and which must not collide
    // with itself. `id <> NEW.id` in trg_ca_basis_bu is what makes it pass.
    await sql`delete from contractor_attendance where contractor_id = ${chitId} and attendance_date = ${M_DAY_4} and skill_level = 'helper'`.execute(
      db
    )
    await db
      .updateTable('contractor_attendance')
      .set({ uom: 'per_sqft', work_type: PLASTER, quantity: 25, rate_paise: PLASTER_PAISE })
      .where('contractor_id', '=', chitId)
      .where('attendance_date', '=', M_DAY_4)
      .where('skill_level', '=', 'mason')
      .execute()
    expect(await line(chitId, M_DAY_4, 'mason', PLASTER)).toMatchObject({ uom: 'per_sqft' })
  })

  it('refuses the same pair posted as two separate days of work, which no form sees', async () => {
    // The case the schema cannot reach and the reason the service checks as well as
    // the trigger. Two posts: the gang in the morning, the measure in the
    // afternoon. `contractorAttendanceSchema` validates one submission and each of
    // these is valid on its own, so between 016 and 017 both landed and both billed.
    expect(
      await svc.recordContractorAttendance(
        db,
        actor,
        day(M_DAY_5, chitId, [{ skill: 'helper', headcount: '3' }]),
        { canManageContractors: true }
      )
    ).toMatchObject({ inserted: 1, updated: 0 })

    const second = await svc
      .recordContractorAttendance(
        db,
        actor,
        day(M_DAY_5, chitId, [{ skill: 'helper', headcount: '3', uom: 'per_sqft', work: PLASTER, qty: '50' }]),
        { canManageContractors: true }
      )
      .then(
        () => null,
        (e: Error) => e
      )
    // The service's message, not the trigger's: the trigger caps MESSAGE_TEXT at
    // 128 characters and cannot name the skill or the work. Both refuse the row;
    // only one of them can explain it, and that is the one a clerk should meet.
    expect(second?.message).toMatch(/helper is already on a day rate for 2026-06-21/)
    expect(second?.message).toMatch(/record the second under its own skill level or on its own date/)
    expect(second?.message).not.toMatch(/trg_ca_basis/)
    expect((await lines(chitId, M_DAY_5, 'helper')).length).toBe(1)

    // The mirror, on its own date: the measure first, the gang second.
    await svc.recordContractorAttendance(
      db,
      actor,
      day(M_DAY_6, chitId, [{ skill: 'helper', headcount: '3', uom: 'per_sqft', work: PLASTER, qty: '50' }]),
      { canManageContractors: true }
    )
    const mirror = await svc
      .recordContractorAttendance(db, actor, day(M_DAY_6, chitId, [{ skill: 'helper', headcount: '3' }]), {
        canManageContractors: true,
      })
      .then(
        () => null,
        (e: Error) => e
      )
    expect(mirror?.message).toMatch(/helper is already on a measured rate for 2026-06-22/)
    expect((await lines(chitId, M_DAY_6, 'helper')).length).toBe(1)

    // A second measured work type at the same skill is still an ordinary second
    // line: the rule is one BASIS per skill per day, not one row.
    expect(
      await svc.recordContractorAttendance(
        db,
        actor,
        day(M_DAY_6, chitId, [{ skill: 'helper', headcount: '2', uom: 'per_sqft', work: CEILING, qty: '10' }]),
        { canManageContractors: true }
      )
    ).toMatchObject({ inserted: 1, updated: 0 })
    expect((await lines(chitId, M_DAY_6, 'helper')).length).toBe(2)
  })

  it('bills the period, mixing a measured amount with a day-rate one', async () => {
    expect(
      await svc.approveContractorAttendance(db, otherActor, period(chitId, { from: M_FROM, to: M_TO }))
    ).toMatchObject({ approved: 5, alreadyApproved: 0 })

    const gross = PLASTER_AMOUNT + HELPER_DAY_AMOUNT + PCC_AMOUNT + PLASTER_AMOUNT_2 + CEILING_AMOUNT
    expect(
      await q.unbilledSummary(db, { contractorId: chitId, projectId, from: M_FROM, to: M_TO })
    ).toMatchObject({ rows: 5, days: 3, grossPaise: gross, unapproved: 0 })

    const bill = await svc.generateContractorBill(db, actor, billInput(chitId, { from: M_FROM, to: M_TO }))
    expect(bill.billNo).toMatch(/^NCC\/CB\/2026-27\/\d{3,}$/)
    expect(bill).toMatchObject({ rows: 5, days: 3, retentionBp: 500, tdsBp: 200, noPan: false })
    expect(bill.grossPaise).toBe(gross)
    // 5% of 44,40,038 paise is 2,22,001.9 and 2% is 88,800.76; both round up.
    expect(bill.retentionPaise).toBe(222002)
    expect(bill.tdsPaise).toBe(88801)
    expect(bill.netPayablePaise).toBe(gross - 222002 - 88801)

    // Read back through the query the bill page uses, so the DECIMAL and BIGINT
    // round trips are inside the assertion.
    const stored = await q.findContractorBill(db, bill.billId)
    expect(stored).toMatchObject({ gross_paise: gross, period_from: M_FROM, period_to: M_TO, status: 'draft' })
    expect(stored!.gross_paise - stored!.retention_paise - stored!.tds_paise).toBe(stored!.net_payable_paise)

    const lines = await q.contractorAttendance(db, { billId: bill.billId })
    expect(lines).toHaveLength(5)
    expect(lines.reduce((sum, l) => sum + l.amount_paise, 0)).toBe(gross)
    // The bill stores one gross figure and nothing else about the mix, so the
    // audit entry is the only trace that four of these five were measured -- two of
    // them at the same skill level on the same day, which is what 016 permits.
    const audit = await lastAudit('hr.contractor_bill_generate')
    expect(audit?.payload).toMatchObject({ attendance_rows: 5, measured_rows: 4, gross_paise: gross })

    // A measured row is billed exactly once, like any other: bill_id is stamped
    // under the same WHERE bill_id IS NULL guard. Both of the M_DAY_3 lines are
    // stamped, and with their own ids -- billing the pair as one row would have
    // left the gross short by the amount of whichever it dropped.
    expect(Number((await cell(chitId, M_DAY_1, 'mason'))?.bill_id)).toBe(bill.billId)
    expect(Number((await line(chitId, M_DAY_3, 'mason', PLASTER))?.bill_id)).toBe(bill.billId)
    expect(Number((await line(chitId, M_DAY_3, 'mason', CEILING))?.bill_id)).toBe(bill.billId)
    expect(
      await q.unbilledSummary(db, { contractorId: chitId, projectId, from: M_FROM, to: M_TO })
    ).toMatchObject({ rows: 0, grossPaise: 0 })
  })
})
