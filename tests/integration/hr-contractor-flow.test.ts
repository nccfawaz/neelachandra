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
} from '../../src/modules/hr/schemas.js'

/*
 * Contractor labour and bills (spec 6.6 rules 2 and 3), executed against MariaDB.
 *
 * What is here that tsc and the pure suite cannot reach:
 *
 *   - `uq_ca (contractor_id, project_id, attendance_date, skill_level)`.
 *     recordContractorAttendance chooses insert or update from a prior SELECT,
 *     and choosing wrong is a duplicate-key 500 on the second post of a day --
 *     which is the ordinary case, a gate clerk correcting a headcount.
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
 *
 * Fixtures. Two obviously fake contractors, one fake login, one client and two
 * projects, removed afterwards by id above a high-water mark captured before
 * anything is written. No `employees` row is created anywhere in this file and
 * none is read: that separation is the subject of the first test.
 *
 * Dates are fixed and in the past, because recording a future day is refused.
 * 2026-08 is used throughout so nothing here collides with hr-attendance-flow's
 * 2026-09, and both suites run in one fork.
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

/** The entry grid as the browser posts it: repeated fields, blanks for none. */
function day(
  date: string,
  contractorId: number,
  rows: Array<{ skill: string; headcount: string; ot?: string }>,
  opts: { projectId?: number; override?: boolean } = {}
) {
  return contractorAttendanceSchema.parse({
    contractorId: String(contractorId),
    projectId: String(opts.projectId ?? projectId),
    attendanceDate: date,
    skillLevel: rows.map((r) => r.skill),
    headcount: rows.map((r) => r.headcount),
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

/** The one attendance row for a contractor, day and skill, or undefined. */
async function cell(contractorId: number, date: string, skill: string) {
  return db
    .selectFrom('contractor_attendance')
    .select([
      'id',
      'project_id',
      'headcount',
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
    .executeTakeFirst()
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
    // 500/day everywhere, 620/day on the fixture project. Rule 2: the project
    // rate wins where it applies.
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
    // TRIPWIRE: when a second-approval column lands, this test fails and
    // DECISIONS 18.9 is the note to update.
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
    // Half a pair is exempt by the same NULL rule. Nothing writes one, but the
    // migration comment claims it, so it is asserted rather than assumed.
    await insertExpense({ source_table: 'contractor_bills' })
    await insertExpense({ source_table: 'contractor_bills' })

    const n = await db
      .selectFrom('expenses')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('source_id', 'is', null)
      .where('expense_no', 'like', 'FIXEXP/%')
      .executeTakeFirstOrThrow()
    expect(Number(n.n)).toBe(5)
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
