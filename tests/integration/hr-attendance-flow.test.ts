import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../../src/db/kysely.js'
import { closePool } from '../../src/db/pool.js'
import { addDays, isWorkingDay, today } from '../../src/lib/dates.js'
import { parseJsonColumn } from '../../src/lib/json.js'
import * as q from '../../src/modules/hr/queries.js'
import * as svc from '../../src/modules/hr/service.js'
import { attendanceBulkSchema, attendanceGridSchema, employeeSchema, exitSchema, leaveRequestSchema } from '../../src/modules/hr/schemas.js'

/*
 * HR attendance and leave (spec 6.6 rules 1 and 4), executed against MariaDB.
 *
 * What is here that tsc and the pure suite cannot reach:
 *
 *   - `uq_att (employee_id, attendance_date)`. recordAttendanceBulk picks the
 *     insert branch or the update branch from a prior SELECT. Picking wrong is a
 *     duplicate-key 500 on the second post of a day, which is the ordinary case:
 *     a supervisor corrects a mark.
 *   - The month lock is DERIVED from `attendance.approved_at`, read in three
 *     separate places (the month state, the per-row prior, and the leave path).
 *     They have to agree, and nothing but a server can say whether they do.
 *   - `paid_leave`, `unpaid_leave` and `half_day` are ENUM members with no writer
 *     anywhere except decideLeave. The UPDATE that clears `project_id` off a day
 *     that was already marked present had never run at all.
 *   - `leave_balances` is upserted on a three-column UNIQUE key with DECIMAL(5,1)
 *     arithmetic performed in JS. A half day is 0.5, and a column that truncated
 *     it would still pass every assertion made without a connection.
 *   - The two halves interlock: a supervisor marking over an approved leave day
 *     has to be refused, or the balance says a day was taken and the attendance
 *     says it was worked.
 *
 * Fixtures. Three obviously fake employees, one fake login, one client and one
 * project, removed afterwards by id above a high-water mark captured before
 * anything is written. Open question 8.1 is unanswered, so no real name appears.
 * Kysely 0.27 has no savepoints and the services open their own transactions, so
 * an outer rollback is not available.
 *
 * Dates are fixed rather than relative. Attendance is refused for a date that
 * has not happened yet, so every marked day is a real past date, and the working
 * days here depend on knowing which of them are Sundays: in 2026, September 6,
 * 13, 20 and 27 are Sundays, and so are August 2, 9, 16, 23 and 30.
 */

const db = getDb()

/** Child before parent. This is also the delete order in cleanup. */
const TRACKED = [
  'attendance',
  'leave_balances',
  'leave_requests',
  'leave_types',
  'employees',
  'projects',
  'clients',
  'audit_log',
  'users',
] as const

const highWater = new Map<string, number>()

/** The month the day-by-day work happens in, and the one that gets closed. */
const OPEN_MONTH = '2026-09'
const LOCK_MONTH = '2026-08'
/** Never written to, so the "nothing to close" refusal has a month to use. */
const EMPTY_MONTH = '2026-07'

const MARK_DAY = '2026-09-02'
const LOCK_DAY = '2026-08-03'

let actor = { userId: 0, ip: '127.0.0.1' as string | null }

let deptId = 0
let desigId = 0
let projectId = 0
let clientId = 0

/* EL is paid with 3 days' notice, PAT is paid with 15 and wants a document,
   LWP is unpaid. */
let elTypeId = 0
let patTypeId = 0
let lwpTypeId = 0
/* The one type in the database with a non-NULL annual_quota, created here rather
   than by editing a seeded row, so the quota gate has both branches to prove and
   the seven real types keep the NULL that 8.6 has not answered yet. */
let quotaTypeId = 0

/* Alpha approves, Beta is marked and takes leave, Gamma joins mid-month. */
let alphaId = 0
let betaId = 0
let gammaId = 0

/* The request ids threaded between tests. */
let betaLeaveId = 0
let gammaPatId = 0
let fyCrossingId = 0

/**
 * An employee, through the schema, so every call exercises the parse on the way
 * in. Only the columns the attendance and leave paths read are filled: the
 * identity and bank columns are hr-flow.test.ts's subject, not this file's.
 */
function employeeInput(over: Record<string, unknown>) {
  return employeeSchema.parse({
    employmentType: 'permanent',
    dateOfJoining: '2026-04-01',
    departmentId: String(deptId),
    designationId: String(desigId),
    ...over,
  })
}

/**
 * The grid as the browser posts it: `parseBody({ all: true })` hands back arrays
 * for a repeated field, and the schema's `repeated` preprocess is what flattens
 * the one-row case back into the same shape.
 */
function grid(
  date: string,
  rows: Array<{ employeeId: number; status: string; inTime?: string; outTime?: string; ot?: string }>,
  opts: { projectId?: number } = {}
) {
  return attendanceBulkSchema.parse({
    attendanceDate: date,
    projectId: opts.projectId === undefined ? '' : String(opts.projectId),
    employeeId: rows.map((r) => String(r.employeeId)),
    status: rows.map((r) => r.status),
    inTime: rows.map((r) => r.inTime ?? ''),
    outTime: rows.map((r) => r.outTime ?? ''),
    overtimeHours: rows.map((r) => r.ot ?? ''),
    remarks: rows.map(() => ''),
  })
}

function leaveInput(over: Record<string, unknown>) {
  return leaveRequestSchema.parse({ leaveTypeId: String(elTypeId), ...over })
}

/**
 * A working day `offset` days from now, for the two tests whose subject is
 * `min_notice_days`. Those are the only ones that cannot use a fixed date: the
 * notice is measured from the real clock, so "ten days out" has to be computed
 * or the test starts failing on a date nobody chose. Sundays are stepped over
 * because a range of nothing but Sundays is refused before the notice is ever
 * looked at, which would pass the test for the wrong reason.
 */
function workingDayIn(offset: number): string {
  let date = addDays(today(), offset)
  while (!isWorkingDay(date)) date = addDays(date, 1)
  return date
}

/** The one attendance row for a person on a day, or undefined. */
async function cell(employeeId: number, date: string) {
  return db
    .selectFrom('attendance')
    .select([
      'id',
      'status',
      'project_id',
      'in_time',
      'out_time',
      'overtime_hours',
      'remarks',
      'approved_at',
      'marked_by',
    ])
    .where('employee_id', '=', employeeId)
    .where('attendance_date', '=', date)
    .executeTakeFirst()
}

beforeAll(async () => {
  for (const table of TRACKED) {
    const res = await sql<{ n: number | null }>`select max(id) as n from ${sql.table(table)}`.execute(db)
    highWater.set(table, Number(res.rows[0]?.n ?? 0))
  }

  const user = await db
    .insertInto('users')
    .values({
      email: 'fixture.attendance.officer@example.invalid',
      full_name: 'Fixture Attendance Officer',
      status: 'active',
      must_change_password: 0,
    })
    .executeTakeFirst()
  actor = { userId: Number(user.insertId ?? 0), ip: '127.0.0.1' }

  // Seeded reference data, looked up rather than assumed.
  const dept = await db.selectFrom('departments').select('id').where('code', '=', 'SITE').executeTakeFirstOrThrow()
  deptId = Number(dept.id)
  const desig = await db
    .selectFrom('designations')
    .select('id')
    .where('code', '=', 'SITE-ENGR')
    .executeTakeFirstOrThrow()
  desigId = Number(desig.id)

  const types = await db.selectFrom('leave_types').select(['id', 'code']).execute()
  const byCode = new Map(types.map((t) => [t.code, Number(t.id)]))
  elTypeId = byCode.get('EL') ?? 0
  patTypeId = byCode.get('PAT') ?? 0
  lwpTypeId = byCode.get('LWP') ?? 0

  // A quota of 2 days, which is small enough that a 3-day request is short by 1
  // and a 2-day one fits exactly. Paid, no notice and no document, so nothing
  // but the quota can refuse a request against it.
  const quotaType = await db
    .insertInto('leave_types')
    .values({
      code: 'FIXQ',
      name: 'Fixture Quota Leave',
      annual_quota: 2,
      is_paid: 1,
      requires_document: 0,
      min_notice_days: 0,
      is_active: 1,
    })
    .executeTakeFirst()
  quotaTypeId = Number(quotaType.insertId ?? 0)

  // A project of its own, because the point of rule 1's project select is that
  // the day is charged somewhere, and the assertion that an approved leave day
  // is charged nowhere needs a project_id that was really set first.
  const client = await db
    .insertInto('clients')
    .values({
      code: 'FIXCL-ATT',
      name: 'Fixture Client for attendance',
      client_type: 'company',
      city: 'Bengaluru',
    })
    .executeTakeFirst()
  clientId = Number(client.insertId ?? 0)
  const project = await db
    .insertInto('projects')
    .values({
      code: 'FIXPR-ATT',
      name: 'Fixture project for attendance',
      client_id: clientId,
      project_type: 'residential_construction',
      delivery_model: 'item_rate',
      site_address: 'Fixture plot 12, Nelamangala',
      city: 'Bengaluru',
      status: 'in_progress',
      created_by: actor.userId,
    })
    .executeTakeFirst()
  projectId = Number(project.insertId ?? 0)

  alphaId = await svc.createEmployee(
    db,
    actor,
    employeeInput({ fullName: 'Fixture Supervisor Alpha', gender: 'male', fatherOrSpouseName: 'Fixture Parent Alpha' })
  )
  betaId = await svc.createEmployee(
    db,
    actor,
    employeeInput({ fullName: 'Fixture Worker Beta', gender: 'female', fatherOrSpouseName: 'Fixture Spouse Beta' })
  )
  // Joined on the 3rd, so the 1st and the 2nd are outside employment and the
  // August roster must not contain them at all.
  gammaId = await svc.createEmployee(
    db,
    actor,
    employeeInput({ fullName: 'Fixture Joiner Gamma', gender: 'male', dateOfJoining: '2026-09-03' })
  )
})

afterAll(async () => {
  // leave_requests.handover_to_employee_id is RESTRICT, and attendance.marked_by
  // and leave_requests.approved_by both point at users with RESTRICT, so the
  // order in TRACKED is load-bearing: every child goes before its parent.
  for (const table of TRACKED) {
    await sql`delete from ${sql.table(table)} where id > ${highWater.get(table) ?? 0}`.execute(db)
  }
  await closePool()
})

/**
 * A leftover from a crashed run would make the derived lock read closed and
 * every assertion below fail somewhere unrelated, so it is worth one test that
 * says so in its own name.
 */
describe('the fixtures', () => {
  it('starts with both working months open and no rows of its own', async () => {
    expect(await q.attendanceMonthState(db, LOCK_MONTH)).toMatchObject({ locked: false })
    expect(await q.attendanceMonthState(db, OPEN_MONTH)).toMatchObject({ locked: false })
    expect((await q.attendanceMonthState(db, EMPTY_MONTH)).total).toBe(0)
    expect([alphaId, betaId, gammaId].every((id) => id > 0)).toBe(true)
    expect([elTypeId, patTypeId, lwpTypeId].every((id) => id > 0)).toBe(true)
  })

  it('has exactly one leave type carrying a quota, and it is the fixture one', async () => {
    // The dormancy of the quota gate is a property of the DATA, so it is worth
    // asserting rather than assuming: if 8.6 lands and someone fills the seeded
    // quotas in, this test names what changed before the balance assertions
    // further down start failing for reasons that look unrelated.
    const withQuota = await db
      .selectFrom('leave_types')
      .select(['id', 'code'])
      .where('annual_quota', 'is not', null)
      .execute()
    expect(withQuota.map((t) => t.code)).toEqual(['FIXQ'])
    expect(Number(withQuota[0]!.id)).toBe(quotaTypeId)
  })
})

describe('the roster the grid and the muster roll are drawn from', () => {
  it('carries the statutory columns Form XVI wants beside the daily marks', async () => {
    const roster = await q.attendanceRoster(db, OPEN_MONTH)
    const beta = roster.find((r) => Number(r.id) === betaId)
    expect(beta).toBeDefined()
    // The three columns added for the muster roll. A left join that resolved to
    // the wrong table would land here, and nothing in the month grid reads them.
    expect(beta!.father_or_spouse_name).toBe('Fixture Spouse Beta')
    expect(beta!.gender).toBe('female')
    expect(beta!.designation_name).toBe('Site Engineer')
    expect(beta!.department_name).toBe('Site execution')
  })

  it('includes an employee who joined inside the month, with the date to grey out by', async () => {
    const september = await q.attendanceRoster(db, OPEN_MONTH)
    const gamma = september.find((r) => Number(r.id) === gammaId)
    expect(gamma).toBeDefined()
    expect(String(gamma!.date_of_joining)).toBe('2026-09-03')

    // And leaves them out of the month before they joined, rather than showing a
    // row of cells that can only be refused.
    const august = await q.attendanceRoster(db, LOCK_MONTH)
    expect(august.map((r) => Number(r.id))).not.toContain(gammaId)
    expect(august.map((r) => Number(r.id))).toContain(betaId)
  })

  it('orders by employee code, which is the order the grid renders in', async () => {
    const codes = (await q.attendanceRoster(db, OPEN_MONTH)).map((r) => r.employee_code)
    expect([...codes]).toEqual([...codes].sort())
  })
})

describe('one post for a whole day (6.6 rule 1)', () => {
  let betaRowId = 0

  it('writes a row per person and charges the day to the project', async () => {
    const result = await svc.recordAttendanceBulk(
      db,
      actor,
      grid(
        MARK_DAY,
        [
          { employeeId: alphaId, status: 'present', inTime: '09:00', outTime: '18:00' },
          { employeeId: betaId, status: 'present', inTime: '09:00', outTime: '20:30', ot: '2.5' },
        ],
        { projectId }
      ),
      { canOverridePeriod: false }
    )
    expect(result).toEqual({ inserted: 2, updated: 0 })

    const beta = await cell(betaId, MARK_DAY)
    expect(beta).toBeDefined()
    betaRowId = Number(beta!.id)
    expect(beta!.status).toBe('present')
    expect(Number(beta!.project_id)).toBe(projectId)
    // TIME is not in the driver's dateStrings list, so this is the widening the
    // schema does landing in the column: '09:00' was posted.
    expect(beta!.in_time).toBe('09:00:00')
    expect(beta!.out_time).toBe('20:30:00')
    expect(Number(beta!.overtime_hours)).toBe(2.5)
    expect(Number(beta!.marked_by)).toBe(actor.userId)
    expect(beta!.approved_at).toBeNull()
  })

  it('reads the day back with the project code the grid prints', async () => {
    const cells = await q.attendanceOn(db, MARK_DAY)
    const mine = cells.filter((r) => [alphaId, betaId].includes(Number(r.employee_id)))
    expect(mine).toHaveLength(2)
    expect(mine.every((r) => r.project_code === 'FIXPR-ATT')).toBe(true)
  })

  it('corrects a posted day in place rather than duplicating it', async () => {
    // The second post of a day is the ordinary case, and `uq_att` is what makes
    // a wrong branch here a 500 instead of a second row.
    const result = await svc.recordAttendanceBulk(
      db,
      actor,
      grid(
        MARK_DAY,
        [
          { employeeId: alphaId, status: 'present', inTime: '09:00', outTime: '18:00' },
          { employeeId: betaId, status: 'half_day', inTime: '09:00', outTime: '13:00' },
        ],
        { projectId }
      ),
      { canOverridePeriod: false }
    )
    expect(result).toEqual({ inserted: 0, updated: 2 })

    const beta = await cell(betaId, MARK_DAY)
    expect(Number(beta!.id)).toBe(betaRowId)
    expect(beta!.status).toBe('half_day')
    // Overtime posted blank is 0, not the 2.5 that was there before: a correction
    // that left the old overtime standing would pay for hours nobody claimed.
    expect(Number(beta!.overtime_hours)).toBe(0)
    expect(beta!.out_time).toBe('13:00:00')

    const rows = await db
      .selectFrom('attendance')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('employee_id', '=', betaId)
      .where('attendance_date', '=', MARK_DAY)
      .executeTakeFirst()
    expect(Number(rows?.n ?? 0)).toBe(1)
  })

  it('rounds overtime to the one place the column keeps', async () => {
    await svc.recordAttendanceBulk(
      db,
      actor,
      grid(MARK_DAY, [{ employeeId: betaId, status: 'present', inTime: '09:00', outTime: '21:00', ot: '3.55' }], {
        projectId,
      }),
      { canOverridePeriod: false }
    )
    // Rounded by the schema, not truncated by DECIMAL(4,1).
    expect(Number((await cell(betaId, MARK_DAY))!.overtime_hours)).toBe(3.6)
  })

  it('takes a day with no project as overhead', async () => {
    const result = await svc.recordAttendanceBulk(
      db,
      actor,
      grid('2026-09-03', [{ employeeId: gammaId, status: 'present', inTime: '09:00', outTime: '18:00' }]),
      { canOverridePeriod: false }
    )
    expect(result).toEqual({ inserted: 1, updated: 0 })
    expect((await cell(gammaId, '2026-09-03'))!.project_id).toBeNull()
  })

  it('filters the month grid by project but never the day the entry grid prefills from', async () => {
    const charged = await q.attendanceMonth(db, OPEN_MONTH, { projectId })
    expect(charged.map((r) => Number(r.employee_id))).not.toContain(gammaId)

    // attendanceOn takes no project on purpose: an overhead day showing as
    // unmarked would invite a supervisor to enter it again against a project.
    const day = await q.attendanceOn(db, '2026-09-03')
    expect(day.map((r) => Number(r.employee_id))).toContain(gammaId)
    expect(day.find((r) => Number(r.employee_id) === gammaId)!.project_code).toBeNull()
  })
})

describe('the refusals a day is worth (6.6 rule 1)', () => {
  it('refuses a date that has not happened yet', async () => {
    await expect(
      svc.recordAttendanceBulk(db, actor, grid('2027-01-04', [{ employeeId: betaId, status: 'present' }]), {
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/has not happened yet/i)
  })

  it('refuses a mark before the joining date, and names the person', async () => {
    await expect(
      svc.recordAttendanceBulk(db, actor, grid('2026-09-01', [{ employeeId: gammaId, status: 'present' }]), {
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/Fixture Joiner Gamma joined on 2026-09-03/)
  })

  it('refuses a project that no longer exists, before the FK gets a chance to', async () => {
    await expect(
      svc.recordAttendanceBulk(
        db,
        actor,
        grid(MARK_DAY, [{ employeeId: betaId, status: 'present' }], { projectId: 999999999 }),
        { canOverridePeriod: false }
      )
    ).rejects.toThrow(/project no longer exists/i)
  })

  it('refuses an employee id that resolves to nothing', async () => {
    await expect(
      svc.recordAttendanceBulk(db, actor, grid(MARK_DAY, [{ employeeId: 999999999, status: 'present' }]), {
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/no longer exists/i)
  })

  it('audits the post once, not once per person', async () => {
    const rows = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.attendance_bulk')
      .where('id', '>', highWater.get('audit_log') ?? 0)
      .orderBy('id')
      .execute()
    // Four posts have succeeded: the two-person day, its correction, the overtime
    // rounding and the overhead day. The refusals above wrote nothing.
    expect(rows).toHaveLength(4)

    const first = parseJsonColumn(rows[0]!.after_json) as Record<string, unknown>
    expect(first.attendance_date).toBe(MARK_DAY)
    expect(Number(first.project_id)).toBe(projectId)
    expect(first.inserted).toBe(2)
    expect(first.updated).toBe(0)
    // The statuses are in the entry as employee:status, which is what makes a
    // ten-person post readable six months later without joining anything.
    expect(first.statuses).toEqual([`${alphaId}:present`, `${betaId}:present`])
    expect(first.period_override).toBeUndefined()
  })
})

/*
 * The month lock (6.6 rule 4). August, so closing it leaves September -- which
 * every leave test below writes into -- open.
 */
describe('closing a month, and what a closed month refuses', () => {
  const FIRST_CLOSE_AT = '2026-08-31 10:00:00'

  it('counts the month before anything is closed', async () => {
    const result = await svc.recordAttendanceBulk(
      db,
      actor,
      grid(
        LOCK_DAY,
        [
          { employeeId: alphaId, status: 'present', inTime: '09:00', outTime: '18:00' },
          { employeeId: betaId, status: 'absent' },
        ],
        { projectId }
      ),
      { canOverridePeriod: false }
    )
    expect(result).toEqual({ inserted: 2, updated: 0 })
    expect(await q.attendanceMonthState(db, LOCK_MONTH)).toEqual({
      month: LOCK_MONTH,
      total: 2,
      approved: 0,
      locked: false,
    })
  })

  it('closes the whole month at once, with no project scope', async () => {
    expect(await svc.approveAttendanceMonth(db, actor, LOCK_MONTH)).toEqual({ approved: 2, alreadyApproved: 0 })

    const state = await q.attendanceMonthState(db, LOCK_MONTH)
    expect(state).toEqual({ month: LOCK_MONTH, total: 2, approved: 2, locked: true })
    // The lock is derived from this column and nothing else. There is no
    // attendance_periods table to disagree with.
    expect((await cell(betaId, LOCK_DAY))!.approved_at).not.toBeNull()

    // Backdated so the "left alone rather than restamped" assertion below has
    // something a restamp would visibly destroy.
    await sql`update attendance set approved_at = ${FIRST_CLOSE_AT}
              where attendance_date = ${LOCK_DAY} and employee_id in (${alphaId}, ${betaId})`.execute(db)
  })

  it('refuses a second close rather than restamping the month', async () => {
    await expect(svc.approveAttendanceMonth(db, actor, LOCK_MONTH)).rejects.toThrow(/already closed/i)
  })

  it('refuses an INSERT into the closed month, not only an update', async () => {
    // The reason rule 4 has to cover inserts: a month closed with twenty days
    // entered and the twenty-first added afterwards changes the same payroll
    // figure the lock exists to freeze.
    await expect(
      svc.recordAttendanceBulk(db, actor, grid('2026-08-04', [{ employeeId: betaId, status: 'present' }]), {
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/August 2026 is closed/)
    expect(await cell(betaId, '2026-08-04')).toBeUndefined()
  })

  it('refuses a correction to an approved row through the month lock', async () => {
    // Through the month check, not the per-row one. Under a derived lock any
    // approved row closes its month, so recordAttendanceBulk's per-row
    // `already approved` guard cannot fire while canOverridePeriod is false and
    // is skipped when it is true. It is a fail-safe for a stored or
    // project-scoped lock, not a reachable branch today.
    await expect(
      svc.recordAttendanceBulk(db, actor, grid(LOCK_DAY, [{ employeeId: betaId, status: 'present' }]), {
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/needs finance.period_close/)
    expect((await cell(betaId, LOCK_DAY))!.status).toBe('absent')
  })

  it('lets finance.period_close through, and records that it was used', async () => {
    const result = await svc.recordAttendanceBulk(
      db,
      actor,
      grid('2026-08-04', [{ employeeId: betaId, status: 'present', inTime: '09:00', outTime: '18:00' }], {
        projectId,
      }),
      { canOverridePeriod: true }
    )
    expect(result).toEqual({ inserted: 1, updated: 0 })

    const row = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.attendance_bulk')
      .where('id', '>', highWater.get('audit_log') ?? 0)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow()
    const after = parseJsonColumn(row.after_json) as Record<string, unknown>
    expect(after.attendance_date).toBe('2026-08-04')
    // Present only when it was used, so a search of the audit log for the flag
    // returns the overrides and not every post ever made.
    expect(after.period_override).toBe(true)
  })

  it('closes the added day without restamping the days closed the first time', async () => {
    expect(await svc.approveAttendanceMonth(db, actor, LOCK_MONTH)).toEqual({ approved: 1, alreadyApproved: 2 })
    // `where approved_at is null` is what keeps this true, and it is the only
    // record of when the month was first closed.
    expect(String((await cell(betaId, LOCK_DAY))!.approved_at)).toBe(FIRST_CLOSE_AT)
    expect((await cell(betaId, '2026-08-04'))!.approved_at).not.toBe(FIRST_CLOSE_AT)
  })

  it('refuses to close a month with nothing in it', async () => {
    await expect(svc.approveAttendanceMonth(db, actor, EMPTY_MONTH)).rejects.toThrow(/nothing to close/i)
  })

  it('leaves September open, which is what the rest of this file depends on', async () => {
    expect((await q.attendanceMonthState(db, OPEN_MONTH)).locked).toBe(false)
  })
})

describe('raising leave (6.6 route table)', () => {
  it('counts working days and files the request against the employee, not the login', async () => {
    betaLeaveId = await svc.requestLeave(
      db,
      actor,
      leaveInput({ employeeId: String(betaId), fromDate: '2026-09-01', toDate: '2026-09-03', reason: 'Family function' }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )
    expect(betaLeaveId).toBeGreaterThan(0)

    const row = await q.findLeaveRequest(db, betaLeaveId)
    expect(row).toBeDefined()
    // Tuesday to Thursday: three working days, and DECIMAL(4,1) keeps it as 3.0.
    expect(Number(row!.days)).toBe(3)
    expect(row!.status).toBe('pending')
    expect(Number(row!.employee_id)).toBe(betaId)
    expect(row!.type_code).toBe('EL')
  })

  it('shows a requester their own leave and nobody else theirs', async () => {
    // The filter is inside the query, so there is no shape of this call that
    // reads out another employee's leave for a caller who should not see it.
    const own = await q.listLeaveRequests(db, { employeeId: betaId })
    expect(own.map((r) => Number(r.id))).toContain(betaLeaveId)
    const alphas = await q.listLeaveRequests(db, { employeeId: alphaId })
    expect(alphas.map((r) => Number(r.id))).not.toContain(betaLeaveId)

    // And an approver, who passes no employeeId at all, sees it.
    const all = await q.listLeaveRequests(db, {})
    expect(all.map((r) => Number(r.id))).toContain(betaLeaveId)
    expect(all.find((r) => Number(r.id) === betaLeaveId)!.employee_name).toBe('Fixture Worker Beta')
  })

  it('refuses a second request over days already claimed, and names the first', async () => {
    // Raised on behalf, because the clash check sits behind the notice check and
    // a self-raise over a past range is refused for notice before it ever gets
    // to the overlap.
    await expect(
      svc.requestLeave(db, actor, leaveInput({ employeeId: String(betaId), fromDate: '2026-09-03', toDate: '2026-09-04' }), {
        selfEmployeeId: alphaId,
        canRaiseForOthers: true,
      })
    ).rejects.toThrow(new RegExp(`Request ${betaLeaveId} already covers 2026-09-01 to 2026-09-03 and is pending`))
  })

  it('refuses a range that is nothing but the weekly off', async () => {
    // 2026-09-20 is a Sunday, which is already the weekly off, so there is no
    // entitlement to draw down.
    await expect(
      svc.requestLeave(db, actor, leaveInput({ fromDate: '2026-09-20', toDate: '2026-09-20' }), {
        selfEmployeeId: betaId,
        canRaiseForOthers: false,
      })
    ).rejects.toThrow(/no working days/i)
  })

  it('refuses leave that starts before the employee joined', async () => {
    await expect(
      svc.requestLeave(db, actor, leaveInput({ fromDate: '2026-09-01', toDate: '2026-09-02' }), {
        selfEmployeeId: gammaId,
        canRaiseForOthers: false,
      })
    ).rejects.toThrow(/cannot start before the date of joining, 2026-09-03/)
  })

  it('refuses a login with no employee record rather than guessing one', async () => {
    await expect(
      svc.requestLeave(db, actor, leaveInput({ fromDate: '2026-10-19', toDate: '2026-10-20' }), {
        selfEmployeeId: null,
        canRaiseForOthers: false,
      })
    ).rejects.toThrow(/not linked to an employee record/i)
  })

  it('refuses raising leave for someone else without hr.leave_approve', async () => {
    await expect(
      svc.requestLeave(db, actor, leaveInput({ employeeId: String(betaId), fromDate: '2026-10-19', toDate: '2026-10-20' }), {
        selfEmployeeId: gammaId,
        canRaiseForOthers: false,
      })
    ).rejects.toThrow(/needs hr.leave_approve/)
  })
})

describe('min_notice_days, and the waiver that is audited', () => {
  /** Two or three days out, so 15 days' notice cannot be met from any run date. */
  const soon = workingDayIn(2)

  it('refuses a self-raised request that misses the notice its type carries', async () => {
    await expect(
      svc.requestLeave(db, actor, leaveInput({ leaveTypeId: String(patTypeId), fromDate: soon, toDate: soon }), {
        selfEmployeeId: gammaId,
        canRaiseForOthers: false,
      })
    ).rejects.toThrow(/needs 15 days' notice and this gives \d+/)
  })

  it('records the same request for an approver, and marks the waiver in the audit', async () => {
    // The waiver exists because a system that cannot record notice given at 3
    // days is a system HR keeps its real leave register outside of.
    gammaPatId = await svc.requestLeave(
      db,
      actor,
      leaveInput({
        leaveTypeId: String(patTypeId),
        employeeId: String(gammaId),
        fromDate: soon,
        toDate: soon,
        reason: 'Birth in the family, notice given verbally',
      }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )

    const row = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.leave_request')
      .where('entity_id', '=', gammaPatId)
      .executeTakeFirstOrThrow()
    const after = parseJsonColumn(row.after_json) as Record<string, unknown>
    expect(after.raised_on_behalf).toBe(true)
    expect(after.notice_days_required).toBe(15)
    expect(after.notice_waived).toBe(true)
    // PAT wants a document and none was attached. Surfaced, not enforced: three
    // of the seven seeded types need one and there is no upload route (15.1).
    expect(after.document_required_and_absent).toBe(true)
  })
})

describe('the queue, and who is allowed to decide', () => {
  it('keeps a decider out of their own queue, by employee and not by login', async () => {
    // Both requests were raised by the same login, so a queue that excluded by
    // user id would be empty for everyone. It excludes by employee, because that
    // is who the request is filed against.
    const gammasQueue = (await q.listLeaveRequests(db, { pendingFor: gammaId })).map((r) => Number(r.id))
    expect(gammasQueue).toContain(betaLeaveId)
    expect(gammasQueue).not.toContain(gammaPatId)

    const betasQueue = (await q.listLeaveRequests(db, { pendingFor: betaId })).map((r) => Number(r.id))
    expect(betasQueue).toContain(gammaPatId)
    expect(betasQueue).not.toContain(betaLeaveId)
  })

  it('filters by status for the pending tab', async () => {
    const pending = await q.listLeaveRequests(db, { status: 'pending' })
    expect(pending.map((r) => Number(r.id))).toEqual(
      expect.arrayContaining([betaLeaveId, gammaPatId])
    )
    expect(pending.every((r) => r.status === 'pending')).toBe(true)
  })

  it('refuses approving your own leave even though the row carries no user id', async () => {
    await expect(
      svc.decideLeave(db, actor, betaLeaveId, { decision: 'approve', rejectReason: null }, {
        approverEmployeeId: betaId,
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/your own leave/i)
  })

  it('refuses a decision on a request that is not there', async () => {
    await expect(
      svc.decideLeave(db, actor, 999999999, { decision: 'approve', rejectReason: null }, {
        approverEmployeeId: alphaId,
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/not found/i)
  })
})

/*
 * The approval, which is where the two halves of 6.6 meet. `paid_leave`,
 * `unpaid_leave` and `half_day` have no other writer in the codebase, and 6.8
 * rule 10 joins `attendance` to `employee_compensation` to cost staff time, so
 * approved paid leave that never reached `attendance` is time the company paid
 * for and charged to nothing.
 */
describe('approving leave, and the attendance rows it writes', () => {
  it('writes a day per working day and clears the project off one already worked', async () => {
    const before = await cell(betaId, MARK_DAY)
    // The day in the middle of the range was marked present and charged to the
    // project, with overtime. That is the row the UPDATE branch has to find.
    expect(before!.status).toBe('present')
    expect(Number(before!.project_id)).toBe(projectId)
    const priorRowId = Number(before!.id)

    const result = await svc.decideLeave(
      db,
      actor,
      betaLeaveId,
      { decision: 'approve', rejectReason: null },
      { approverEmployeeId: alphaId, canOverridePeriod: false }
    )
    expect(result).toEqual({
      decision: 'approve',
      employeeName: 'Fixture Worker Beta',
      days: 3,
      attendanceRowsWritten: 3,
      financialYear: '2026-27',
      balanceAfter: -3,
    })

    for (const date of ['2026-09-01', MARK_DAY, '2026-09-03']) {
      const row = await cell(betaId, date)
      expect(row, date).toBeDefined()
      expect(row!.status, date).toBe('paid_leave')
      // Charging a leave day to a project would put leave cost in a project
      // budget, which is the 6.8 figure this clears it for.
      expect(row!.project_id, date).toBeNull()
      expect(row!.in_time, date).toBeNull()
      expect(row!.out_time, date).toBeNull()
      expect(Number(row!.overtime_hours), date).toBe(0)
      expect(row!.remarks, date).toBe(`Leave request ${betaLeaveId}`)
    }

    // Updated in place: the same row, not a second one beside it.
    expect(Number((await cell(betaId, MARK_DAY))!.id)).toBe(priorRowId)
    expect((await q.findLeaveRequest(db, betaLeaveId))!.status).toBe('approved')
  })

  it('creates the balance row on first use and leaves the untouched types at zero', async () => {
    const balances = await q.leaveBalances(db, betaId, '2026-27')
    // Left joined from leave_types, so a new joiner sees the whole list rather
    // than an empty table. Counted against the active types rather than against
    // the literal seven, because this file adds an eighth of its own to exercise
    // the quota gate and the property being pinned is one row per type.
    const activeTypes = await db
      .selectFrom('leave_types')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('is_active', '=', 1)
      .executeTakeFirstOrThrow()
    expect(balances).toHaveLength(Number(activeTypes.n))
    expect(balances.length).toBeGreaterThanOrEqual(7)
    const el = balances.find((b) => b.type_code === 'EL')
    expect(el).toEqual({
      leave_type_id: elTypeId,
      type_code: 'EL',
      type_name: el!.type_name,
      annual_quota: null,
      opening: 0,
      accrued: 0,
      availed: 3,
      encashed: 0,
      balance: -3,
    })
    // Tracked, not enforced while the quota is NULL: every SEEDED annual_quota is
    // NULL pending 8.6, so a negative balance is a fact for HR to look at rather
    // than a refusal. The gate that fires when a quota is present is proven
    // separately, further down.
    expect(balances.filter((b) => b.type_code !== 'EL').every((b) => b.availed === 0)).toBe(true)
  })

  it('audits the two writes the approval implies', async () => {
    const row = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.leave_approve')
      .where('entity_id', '=', betaLeaveId)
      .executeTakeFirstOrThrow()
    const after = parseJsonColumn(row.after_json) as Record<string, unknown>
    expect(after.attendance_status_written).toBe('paid_leave')
    expect(after.attendance_rows_written).toBe(3)
    expect(after.financial_year).toBe('2026-27')
    expect(after.balance_after).toBe(-3)
    expect(after.period_override).toBeUndefined()
  })

  it('refuses a supervisor marking an approved leave day as worked, and names the request', async () => {
    await expect(
      svc.recordAttendanceBulk(
        db,
        actor,
        grid('2026-09-01', [{ employeeId: betaId, status: 'present', inTime: '09:00', outTime: '18:00' }], {
          projectId,
        }),
        { canOverridePeriod: false }
      )
    ).rejects.toThrow(new RegExp(`approved leave covering 2026-09-01 \\(request ${betaLeaveId}\\)`))
    expect((await cell(betaId, '2026-09-01'))!.status).toBe('paid_leave')
  })

  it('still allows a leave status on that day, because that is what a correction is', async () => {
    // The refusal is about a day on leave being recorded as worked, not about the
    // row being frozen: unpaid_leave over paid_leave is a correction a supervisor
    // is allowed to make.
    const result = await svc.recordAttendanceBulk(
      db,
      actor,
      grid('2026-09-01', [{ employeeId: betaId, status: 'unpaid_leave' }]),
      { canOverridePeriod: false }
    )
    expect(result).toEqual({ inserted: 0, updated: 1 })
    expect((await cell(betaId, '2026-09-01'))!.status).toBe('unpaid_leave')
    expect((await cell(betaId, '2026-09-01'))!.project_id).toBeNull()
  })

  it('refuses to decide the same request twice', async () => {
    await expect(
      svc.decideLeave(db, actor, betaLeaveId, { decision: 'reject', rejectReason: 'Changed my mind' }, {
        approverEmployeeId: alphaId,
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/already approved/i)
  })

  it('accumulates onto the existing balance row rather than inserting a second', async () => {
    // uq_bal (employee_id, leave_type_id, financial_year) makes the wrong branch
    // here a duplicate-key error, and the arithmetic is done in JS against a
    // DECIMAL(5,1) column.
    const second = await svc.requestLeave(
      db,
      actor,
      leaveInput({ employeeId: String(betaId), fromDate: '2026-09-08', toDate: '2026-09-09' }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )
    const result = await svc.decideLeave(
      db,
      actor,
      second,
      { decision: 'approve', rejectReason: null },
      { approverEmployeeId: alphaId, canOverridePeriod: false }
    )
    expect(result.days).toBe(2)
    expect(result.balanceAfter).toBe(-5)

    const rows = await db
      .selectFrom('leave_balances')
      .select(['id', 'availed', 'balance'])
      .where('employee_id', '=', betaId)
      .where('leave_type_id', '=', elTypeId)
      .execute()
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.availed)).toBe(5)
    expect(Number(rows[0]!.balance)).toBe(-5)
  })
})

describe('a half day, which the enum and the DECIMAL both have to carry', () => {
  it('books 0.5 of a day and writes half_day rather than a whole day of leave', async () => {
    const halfId = await svc.requestLeave(
      db,
      actor,
      leaveInput({
        employeeId: String(alphaId),
        fromDate: '2026-09-03',
        toDate: '2026-09-03',
        halfDay: 'on',
        reason: 'Half day for a bank visit',
      }),
      { selfEmployeeId: betaId, canRaiseForOthers: true }
    )
    // DECIMAL(4,1) keeps the .5. A column that rounded it would show 0 or 1 here
    // and every assertion made without a connection would still have passed.
    expect(Number((await q.findLeaveRequest(db, halfId))!.days)).toBe(0.5)

    const result = await svc.decideLeave(
      db,
      actor,
      halfId,
      { decision: 'approve', rejectReason: null },
      { approverEmployeeId: gammaId, canOverridePeriod: false }
    )
    expect(result.attendanceRowsWritten).toBe(1)
    expect(result.balanceAfter).toBe(-0.5)

    // Written as half_day, not as a full day of paid_leave that the muster roll
    // would then count as a whole day absent.
    expect((await cell(alphaId, '2026-09-03'))!.status).toBe('half_day')
    const balance = (await q.leaveBalances(db, alphaId, '2026-27')).find((b) => b.type_code === 'EL')
    expect(balance!.availed).toBe(0.5)
    expect(balance!.balance).toBe(-0.5)
  })
})

describe('rejecting, and withdrawing', () => {
  let lwpId = 0

  it('takes a self-raised request when the notice is met', async () => {
    // The only self-raise in this file that succeeds: LWP asks one day's notice
    // and this is a month out, so it passes from any run date.
    lwpId = await svc.requestLeave(
      db,
      actor,
      leaveInput({ leaveTypeId: String(lwpTypeId), fromDate: workingDayIn(30), toDate: workingDayIn(30) }),
      { selfEmployeeId: gammaId, canRaiseForOthers: false }
    )
    expect(Number((await q.findLeaveRequest(db, lwpId))!.days)).toBe(1)
  })

  it('rejects with a reason and writes no attendance and no balance', async () => {
    const result = await svc.decideLeave(
      db,
      actor,
      lwpId,
      { decision: 'reject', rejectReason: 'Site is short-handed that week' },
      { approverEmployeeId: alphaId, canOverridePeriod: false }
    )
    expect(result).toEqual({
      decision: 'reject',
      employeeName: 'Fixture Joiner Gamma',
      days: 1,
      attendanceRowsWritten: 0,
      financialYear: null,
      balanceAfter: null,
    })

    const row = (await q.listLeaveRequests(db, { employeeId: gammaId })).find((r) => Number(r.id) === lwpId)
    expect(row!.status).toBe('rejected')
    expect(row!.reject_reason).toBe('Site is short-handed that week')
    // approved_by is the only decision-maker column the table has, so a rejection
    // stamps it too and the list resolves it to a name.
    expect(row!.decided_by_name).toBe('Fixture Attendance Officer')

    expect(await cell(gammaId, workingDayIn(30))).toBeUndefined()
    const balances = await db
      .selectFrom('leave_balances')
      .select(['id'])
      .where('employee_id', '=', gammaId)
      .where('leave_type_id', '=', lwpTypeId)
      .execute()
    expect(balances).toHaveLength(0)
  })

  it('refuses withdrawing a request that is not yours', async () => {
    await expect(svc.withdrawLeave(db, actor, gammaPatId, { selfEmployeeId: betaId })).rejects.toThrow(
      /not your leave request/i
    )
    expect((await q.findLeaveRequest(db, gammaPatId))!.status).toBe('pending')
  })

  it('withdraws your own pending request', async () => {
    await svc.withdrawLeave(db, actor, gammaPatId, { selfEmployeeId: gammaId })
    expect((await q.findLeaveRequest(db, gammaPatId))!.status).toBe('withdrawn')
  })

  it('refuses withdrawing one that has already moved the balance', async () => {
    // An approved request has written attendance and moved leave_balances, so
    // undoing it is a reversal an approver makes, not a self-service action.
    await expect(svc.withdrawLeave(db, actor, betaLeaveId, { selfEmployeeId: betaId })).rejects.toThrow(
      /already approved and cannot be withdrawn/i
    )
  })
})

describe('leave inside a closed month (6.6 rules 1 and 4 disagreeing)', () => {
  let augustLeaveId = 0

  it('lets the request be raised, because the lock is on the write and not the ask', async () => {
    augustLeaveId = await svc.requestLeave(
      db,
      actor,
      leaveInput({ employeeId: String(betaId), fromDate: '2026-08-10', toDate: '2026-08-11' }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )
    expect(Number((await q.findLeaveRequest(db, augustLeaveId))!.days)).toBe(2)
  })

  it('refuses the approval, because approving it would write into the closed month', async () => {
    // The third place the derived lock is read. Approving here would add two rows
    // to a month whose payroll figure is already out.
    await expect(
      svc.decideLeave(db, actor, augustLeaveId, { decision: 'approve', rejectReason: null }, {
        approverEmployeeId: alphaId,
        canOverridePeriod: false,
      })
    ).rejects.toThrow(/August 2026 is closed/)
    expect((await q.findLeaveRequest(db, augustLeaveId))!.status).toBe('pending')
    expect(await cell(betaId, '2026-08-10')).toBeUndefined()
  })

  it('lets finance.period_close through, and leaves the reopened rows unapproved', async () => {
    const result = await svc.decideLeave(
      db,
      actor,
      augustLeaveId,
      { decision: 'approve', rejectReason: null },
      { approverEmployeeId: alphaId, canOverridePeriod: true }
    )
    expect(result.attendanceRowsWritten).toBe(2)
    expect(result.balanceAfter).toBe(-7)

    const audit = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.leave_approve')
      .where('entity_id', '=', augustLeaveId)
      .executeTakeFirstOrThrow()
    expect((parseJsonColumn(audit.after_json) as Record<string, unknown>).period_override).toBe(true)

    // The month stays closed and the two new rows are not swept into the old
    // close: they were written after it, so they need a close of their own.
    expect(await q.attendanceMonthState(db, LOCK_MONTH)).toEqual({
      month: LOCK_MONTH,
      total: 5,
      approved: 3,
      locked: true,
    })
    expect((await cell(betaId, '2026-08-10'))!.approved_at).toBeNull()
  })
})

describe('a range that crosses 31 March', () => {
  it('books the whole request in the financial year its first day falls in', async () => {
    // 2027-03-30 is a Tuesday, so the range is four working days across two
    // financial years. Splitting it would need a rule for which year a
    // March-to-April absence draws down, and 8.6 has not answered the simpler
    // quota question yet. Flagged in DECISIONS.
    fyCrossingId = await svc.requestLeave(
      db,
      actor,
      leaveInput({ employeeId: String(betaId), fromDate: '2027-03-30', toDate: '2027-04-02' }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )
    const result = await svc.decideLeave(
      db,
      actor,
      fyCrossingId,
      { decision: 'approve', rejectReason: null },
      { approverEmployeeId: alphaId, canOverridePeriod: false }
    )
    expect(result.days).toBe(4)
    expect(result.financialYear).toBe('2026-27')
    // Beta reaches -11 EL days across this file because `annual_quota` is NULL
    // for every seeded type and the quota gate in `decideLeave` is dormant while
    // it is (DECISIONS 17.1). When 8.6 supplies EL's quota this line is the first
    // thing that fails, and it fails because the gate started working: the
    // approval will be refused with a shortfall instead of returning a balance.
    // The fix then is to give this file's fixture employees an opening balance,
    // not to loosen the gate.
    expect(result.balanceAfter).toBe(-11)

    // Every one of the four days is written, on both sides of the boundary.
    for (const date of ['2027-03-30', '2027-03-31', '2027-04-01', '2027-04-02']) {
      expect((await cell(betaId, date))!.status, date).toBe('paid_leave')
    }
    // And the next year's balance is untouched, which is the assumption stated.
    const nextYear = (await q.leaveBalances(db, betaId, '2027-28')).find((b) => b.type_code === 'EL')
    expect(nextYear!.availed).toBe(0)
    expect(nextYear!.balance).toBe(0)
  })
})

describe('the quota gate, dormant and awake (DECISIONS 17.1)', () => {
  /* Both branches of the same code path, decided only by whether
     `leave_types.annual_quota` holds a number. Nothing in `decideLeave` is
     switched by a flag, an env var or a permission: the data is the switch, which
     is the property that makes 8.6 a data change rather than a release. */

  it('lets a NULL-quota approval take the balance negative, which is current behaviour', async () => {
    // 2026-09-16 and 17 are a Wednesday and a Thursday. Raised on behalf so EL's
    // three days of notice is waived rather than being what this test measures.
    const requestId = await svc.requestLeave(
      db,
      actor,
      leaveInput({ employeeId: String(gammaId), fromDate: '2026-09-16', toDate: '2026-09-17' }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )
    const result = await svc.decideLeave(
      db,
      actor,
      requestId,
      { decision: 'approve', rejectReason: null },
      { approverEmployeeId: alphaId, canOverridePeriod: false }
    )
    expect(result.days).toBe(2)
    // No opening, no accrual, no quota: the balance is simply what was taken,
    // negative, and HR reads it rather than the system refusing it.
    expect(result.balanceAfter).toBe(-2)
    const el = (await q.leaveBalances(db, gammaId, '2026-27')).find((b) => b.type_code === 'EL')
    expect(el!.annual_quota).toBeNull()
    expect(el!.availed).toBe(2)
    expect(el!.balance).toBe(-2)
  })

  it('admits a request that exactly fills a non-NULL quota', async () => {
    // 2026-09-20 is a Sunday, so this is the Monday and Tuesday after it: two
    // working days against a quota of exactly two.
    const requestId = await svc.requestLeave(
      db,
      actor,
      leaveInput({
        leaveTypeId: String(quotaTypeId),
        employeeId: String(gammaId),
        fromDate: '2026-09-21',
        toDate: '2026-09-22',
      }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )
    const result = await svc.decideLeave(
      db,
      actor,
      requestId,
      { decision: 'approve', rejectReason: null },
      { approverEmployeeId: alphaId, canOverridePeriod: false }
    )
    expect(result.days).toBe(2)
    // The gate compares 2 days requested against 2 available and lets it
    // through. The stored `balance` column is still the spec's formula, which
    // has no quota term in it, so it reads -2 on a request that was WITHIN
    // quota. That asymmetry is real and is what 17.1 records: the entitlement
    // lives on the type, the ledger lives on the balance row, and only an
    // accrual job would reconcile them.
    expect(result.balanceAfter).toBe(-2)

    const audit = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.leave_approve')
      .where('entity_id', '=', requestId)
      .executeTakeFirstOrThrow()
    const after = parseJsonColumn(audit.after_json) as Record<string, unknown>
    expect(after.quota_enforced).toBe(true)
    expect(Number(after.annual_quota)).toBe(2)
  })

  it('refuses the next day against that quota, naming the type and the shortfall', async () => {
    // One more working day, 2026-09-23, with the quota already spent.
    const requestId = await svc.requestLeave(
      db,
      actor,
      leaveInput({
        leaveTypeId: String(quotaTypeId),
        employeeId: String(gammaId),
        fromDate: '2026-09-23',
        toDate: '2026-09-23',
      }),
      { selfEmployeeId: alphaId, canRaiseForOthers: true }
    )
    await expect(
      svc.decideLeave(
        db,
        actor,
        requestId,
        { decision: 'approve', rejectReason: null },
        { approverEmployeeId: alphaId, canOverridePeriod: false }
      )
    ).rejects.toThrow(
      'Fixture Quota Leave has 0 days available in 2026-27 against a quota of 2 days, and this request needs 1 day. It is short by 1 day.'
    )

    // The refusal is a refusal, not a partial write. The request is still
    // pending, no attendance row exists for the day, and `availed` did not move
    // -- which is the part that needs a real transaction to prove, since the
    // gate runs before the attendance loop AND inside the same transaction.
    const still = await q.findLeaveRequest(db, requestId)
    expect(still!.status).toBe('pending')
    expect(await cell(gammaId, '2026-09-23')).toBeUndefined()
    const fixq = (await q.leaveBalances(db, gammaId, '2026-27')).find((b) => b.type_code === 'FIXQ')
    expect(fixq!.availed).toBe(2)
  })

  it('still rejects that request cleanly, since a refusal to approve is not a decision', async () => {
    // The gate sits in the approve branch only. Leave nobody can approve has to
    // remain rejectable or it would sit in the queue forever.
    const pending = await q.listLeaveRequests(db, { status: 'pending', pendingFor: alphaId })
    const stuck = pending.find((p) => p.type_code === 'FIXQ')
    expect(stuck).toBeDefined()
    const result = await svc.decideLeave(
      db,
      actor,
      Number(stuck!.id),
      { decision: 'reject', rejectReason: 'Quota for the year is spent' },
      { approverEmployeeId: alphaId, canOverridePeriod: false }
    )
    expect(result).toMatchObject({ decision: 'reject', attendanceRowsWritten: 0, balanceAfter: null })
  })
})

describe('what the entry grid prefills from, and what the dashboard counts', () => {
  it('marks the day as covered by an approved request, with the number to quote', async () => {
    const covered = await q.approvedLeaveOn(db, '2026-09-01')
    expect(covered.find((r) => r.employee_id === betaId)).toEqual({
      employee_id: betaId,
      request_id: betaLeaveId,
      type_code: 'EL',
      days: 3,
    })
    // A day inside the month but outside every approved range renders a status
    // select as usual.
    expect((await q.approvedLeaveOn(db, '2026-09-15')).map((r) => r.employee_id)).not.toContain(betaId)
  })

  it('counts unapproved attendance in every month, not only the open one', async () => {
    const mine = await db
      .selectFrom('attendance')
      .select(['id'])
      .where('employee_id', 'in', [alphaId, betaId, gammaId])
      .execute()
    const unapproved = await db
      .selectFrom('attendance')
      .select(['id'])
      .where('employee_id', 'in', [alphaId, betaId, gammaId])
      .where('approved_at', 'is', null)
      .execute()
    // The August rows closed earlier are the difference, so the widget is
    // approval-aware and month-blind rather than scoped to a period.
    expect(unapproved.length).toBeLessThan(mine.length)

    const data = await q.hrDashboard(db)
    expect(data.unapprovedAttendance).toBe(unapproved.length)
    expect(data.headcount.find((h) => h.status === 'active')!.n).toBeGreaterThanOrEqual(3)
  })
})

/*
 * The month matrix (spec 1761), which is `recordAttendanceGrid` and not the day
 * form above it.
 *
 * IT GETS ITS OWN MONTH. June 2026 is untouched by every test above, so the
 * counts below are the matrix's own writes and not a residue of the day form,
 * the leave approvals or the August close. June has 30 days, which is where the
 * `-30` in `matrixRows` comes from.
 *
 * The property under test is not really validation -- the wire shape is pinned
 * without a database in tests/hr-schemas.test.ts. It is that WHICH CELLS THE
 * CLIENT CHOSE TO SEND CANNOT CHANGE WHAT LANDS. A page with JavaScript off
 * posts every editable cell in the month; a keyboard user posts the same thing;
 * neither has a way to say "only these three changed". So the server compares
 * each cell against what is stored and writes only the difference, and that
 * comparison is the whole of the claim that the client holds no authority over
 * an attendance value. A returned count of zero is not evidence of it -- the
 * counts are computed by the same function under test -- so the no-op post
 * below is made by a DIFFERENT user and the assertion is that every row still
 * names the first one. `marked_by` cannot be faked by a miscounted loop.
 */
describe('the month matrix, one post for a whole month (spec 1761)', () => {
  const GRID_MONTH = '2026-06'

  /* A second officer, whose only job is to prove a no-op wrote nothing. */
  let officer = { userId: 0, ip: '127.0.0.1' as string | null }
  /* Joined with the others and left mid-June, so the post-exit refusal has a
     real leaver rather than a contrived date. */
  let deltaId = 0

  /** The matrix as the browser posts it: one self-identifying string per cell. */
  function matrix(
    month: string,
    cells: Array<{ employeeId: number; day: number; status: string }>,
    opts: { projectId?: number } = {}
  ) {
    return attendanceGridSchema.parse({
      month,
      projectId: opts.projectId === undefined ? '' : String(opts.projectId),
      cell: cells.map((c) => `${c.employeeId}|${c.day}|${c.status}`),
    })
  }

  /** Every attendance row inside the matrix month, with the stamps a no-op must not move. */
  async function matrixRows() {
    return db
      .selectFrom('attendance')
      .select([
        'employee_id',
        'attendance_date',
        'status',
        'project_id',
        'marked_by',
        'marked_at',
        'approved_at',
      ])
      .where('attendance_date', '>=', `${GRID_MONTH}-01`)
      .where('attendance_date', '<=', `${GRID_MONTH}-30`)
      .orderBy('employee_id')
      .orderBy('attendance_date')
      .execute()
  }

  const at = (rows: Awaited<ReturnType<typeof matrixRows>>, employeeId: number, date: string) =>
    rows.find((r) => Number(r.employee_id) === employeeId && String(r.attendance_date) === date)

  /**
   * The whole editable page, as a browser with JavaScript off posts it back:
   * every cell, whether or not it changed. A function and not a constant because
   * the employee ids are not known until `beforeAll` has run.
   */
  function wholePage(over: Record<string, string> = {}) {
    const base: Array<{ employeeId: number; day: number; status: string }> = [
      { employeeId: alphaId, day: 1, status: 'present' },
      { employeeId: alphaId, day: 2, status: 'present' },
      { employeeId: alphaId, day: 3, status: 'absent' },
      { employeeId: betaId, day: 1, status: 'present' },
      { employeeId: betaId, day: 2, status: 'half_day' },
      { employeeId: betaId, day: 3, status: 'present' },
    ]
    return base.map((c) => ({ ...c, status: over[`${c.employeeId}|${c.day}`] ?? c.status }))
  }

  beforeAll(async () => {
    const user = await db
      .insertInto('users')
      .values({
        email: 'fixture.matrix.officer@example.invalid',
        full_name: 'Fixture Matrix Officer',
        status: 'active',
        must_change_password: 0,
      })
      .executeTakeFirst()
    officer = { userId: Number(user.insertId ?? 0), ip: '127.0.0.1' }

    deltaId = await svc.createEmployee(
      db,
      actor,
      employeeInput({ fullName: 'Fixture Leaver Delta', gender: 'female' })
    )
    // No override passed on purpose: a blocker would fail this beforeAll with the
    // blocker's own message, which is a better fixture failure than an exit
    // forced through for reasons nobody wrote down.
    const exit = await svc.runExit(
      db,
      actor,
      deltaId,
      exitSchema.parse({ dateOfExit: '2026-06-15', exitType: 'resigned', exitReason: 'Fixture exit' })
    )
    expect(exit.overridden).toBe(false)
  })

  it('starts from a month nothing else in this file writes to', async () => {
    // If a crashed run left rows in June, every count below shifts and the
    // failure would look like a bug in the service. Say it here instead.
    expect(await q.attendanceMonthState(db, GRID_MONTH)).toEqual({
      month: GRID_MONTH,
      total: 0,
      approved: 0,
      locked: false,
    })
    expect(officer.userId).toBeGreaterThan(0)
    expect(officer.userId).not.toBe(actor.userId)
    expect(deltaId).toBeGreaterThan(0)
  })

  it('inserts every marked cell and charges the new rows to the posted project', async () => {
    const result = await svc.recordAttendanceGrid(db, actor, matrix(GRID_MONTH, wholePage(), { projectId }), {
      canOverridePeriod: false,
    })
    expect(result).toEqual({ inserted: 6, updated: 0, unchanged: 0 })

    const rows = await matrixRows()
    expect(rows).toHaveLength(6)
    expect(at(rows, betaId, '2026-06-02')).toMatchObject({
      status: 'half_day',
      project_id: projectId,
      marked_by: actor.userId,
      approved_at: null,
    })

    // The matrix writes a status and nothing else. Times, overtime and remarks
    // belong to the day form, and a cell the matrix inserted leaves them as the
    // column defaults rather than inventing a working day around the mark.
    const row = await cell(betaId, '2026-06-02')
    expect(row).toMatchObject({ in_time: null, out_time: null, remarks: null })
    expect(Number(row!.overtime_hours)).toBe(0)
  })

  it('writes nothing when the whole page is posted back unchanged', async () => {
    const before = await matrixRows()
    // Posted by the SECOND officer. If any row were rewritten -- even to the
    // value it already held -- `marked_by` would move to them, so this is a
    // claim about statements executed rather than about the returned counts.
    const result = await svc.recordAttendanceGrid(
      db,
      officer,
      matrix(GRID_MONTH, wholePage(), { projectId }),
      { canOverridePeriod: false }
    )
    expect(result).toEqual({ inserted: 0, updated: 0, unchanged: 6 })

    const after = await matrixRows()
    expect(after).toEqual(before)
    expect(after.every((r) => Number(r.marked_by) === actor.userId)).toBe(true)
  })

  it('lands the same row whether the post carries one cell or the whole page', async () => {
    // The same kind of correction made two ways. Alpha's 3rd changes inside a
    // post carrying all six cells; Beta's 3rd changes in a post carrying only
    // itself. Both rows end up in the same shape, which is what "no client-side
    // authority" means once it is a row rather than a sentence.
    const full = await svc.recordAttendanceGrid(
      db,
      officer,
      matrix(GRID_MONTH, wholePage({ [`${alphaId}|3`]: 'weekly_off' }), { projectId }),
      { canOverridePeriod: false }
    )
    expect(full).toEqual({ inserted: 0, updated: 1, unchanged: 5 })

    const one = await svc.recordAttendanceGrid(
      db,
      officer,
      matrix(GRID_MONTH, [{ employeeId: betaId, day: 3, status: 'weekly_off' }], { projectId }),
      { canOverridePeriod: false }
    )
    expect(one).toEqual({ inserted: 0, updated: 1, unchanged: 0 })

    const rows = await matrixRows()
    for (const id of [alphaId, betaId]) {
      expect(at(rows, id, '2026-06-03')).toMatchObject({
        status: 'weekly_off',
        project_id: projectId,
        marked_by: officer.userId,
      })
    }
    // And the four cells neither post was trying to change still name the
    // original officer, so a correction is not a re-marking of the month.
    expect(at(rows, alphaId, '2026-06-01')).toMatchObject({ marked_by: actor.userId })
    expect(at(rows, betaId, '2026-06-02')).toMatchObject({ marked_by: actor.userId })
  })

  it('never moves an existing row off the project it was charged to', async () => {
    // The matrix's project select is labelled "Charge new rows to" and this is
    // why: a supervisor correcting one status in a month must not silently
    // re-cost the days they left alone. 6.8 reads attendance.project_id, so a
    // grid that moved a charge would move money.
    const result = await svc.recordAttendanceGrid(
      db,
      actor,
      matrix(GRID_MONTH, [
        { employeeId: alphaId, day: 3, status: 'absent' },
        { employeeId: alphaId, day: 4, status: 'present' },
      ]),
      { canOverridePeriod: false }
    )
    expect(result).toEqual({ inserted: 1, updated: 1, unchanged: 0 })

    const rows = await matrixRows()
    // Corrected through a post charged to overhead, and still on the project.
    expect(at(rows, alphaId, '2026-06-03')).toMatchObject({ status: 'absent', project_id: projectId })
    // Inserted by the same post, so the charge applied to it and only to it.
    expect(at(rows, alphaId, '2026-06-04')).toMatchObject({ status: 'present', project_id: null })
  })

  /*
   * Every refusal below is one the rendered matrix must not have offered a
   * control for. `cellOptions` in the HR routes returns null for exactly this
   * list, in this order, and these tests are the other half of that pairing:
   * they say the service really does refuse what the grid declines to offer, so
   * a cell the client CAN post is a cell the database will take. Add a refusal
   * to recordAttendanceGrid and both halves owe a case.
   */
  describe('the refusals the matrix must not offer a cell for', () => {
    const post = (input: ReturnType<typeof matrix>, canOverridePeriod = false) =>
      svc.recordAttendanceGrid(db, actor, input, { canOverridePeriod })

    it('refuses a day that has not happened yet', async () => {
      // A month with nothing in it, so the month lock cannot be what refuses
      // this and pass the test for the wrong reason.
      await expect(post(matrix('2027-01', [{ employeeId: alphaId, day: 4, status: 'present' }]))).rejects.toThrow(
        /2027-01-04 has not happened yet/
      )
    })

    it('refuses a cell before the joining date, and names the person', async () => {
      await expect(post(matrix(GRID_MONTH, [{ employeeId: gammaId, day: 1, status: 'present' }]))).rejects.toThrow(
        /Fixture Joiner Gamma joined on 2026-09-03 and cannot be marked on 2026-06-01/
      )
    })

    it('refuses a cell after the exit date, and takes the day before it', async () => {
      await expect(post(matrix(GRID_MONTH, [{ employeeId: deltaId, day: 20, status: 'present' }]))).rejects.toThrow(
        /Fixture Leaver Delta left on 2026-06-15 and cannot be marked on 2026-06-20/
      )
      // The boundary is the date and not the person: a leaver's last days are
      // still markable, which is exactly the month payroll needs.
      expect(await post(matrix(GRID_MONTH, [{ employeeId: deltaId, day: 15, status: 'present' }]))).toEqual({
        inserted: 1,
        updated: 0,
        unchanged: 0,
      })
    })

    it('refuses marking an approved leave day as worked, and names the request', async () => {
      // September, because that is where the leave tests above left an approved
      // request. The bulk path has the same refusal; this is the matrix's, and
      // the pair with the test below it is the whole point.
      expect((await q.attendanceMonthState(db, OPEN_MONTH)).locked).toBe(false)
      await expect(post(matrix(OPEN_MONTH, [{ employeeId: betaId, day: 1, status: 'present' }]))).rejects.toThrow(
        new RegExp(`approved leave covering 2026-09-01 \\(request ${betaLeaveId}\\)`)
      )
    })

    it('refuses the whole post when the month is closed', async () => {
      // One check for the month rather than one per cell, which is sound because
      // no cell can name a day outside the posted month.
      await expect(post(matrix(LOCK_MONTH, [{ employeeId: alphaId, day: 3, status: 'present' }]))).rejects.toThrow(
        /August 2026 is closed/
      )
    })

    it('refuses a project that no longer exists, before the FK gets a chance to', async () => {
      await expect(
        post(matrix(GRID_MONTH, [{ employeeId: alphaId, day: 5, status: 'present' }], { projectId: 999999999 }))
      ).rejects.toThrow(/project no longer exists/i)
    })

    it('refuses an employee id that resolves to nothing', async () => {
      await expect(post(matrix(GRID_MONTH, [{ employeeId: 999999999, day: 5, status: 'present' }]))).rejects.toThrow(
        /employees no longer exists/i
      )
    })
  })

  /*
   * WHY THE UNCHANGED COMPARISON RUNS BEFORE EVERY REFUSAL IN THE LOOP.
   *
   * The page a supervisor is looking at was rendered at some earlier moment.
   * Between then and the save, a leave request covering one of its cells can be
   * approved -- and the save carries that cell too, because a page with
   * JavaScript off posts all of them. With the refusals ordered first, one
   * approved leave day makes the WHOLE MONTH unsavable over a cell the post was
   * not trying to change, and three real corrections are lost to a message about
   * a fourth.
   *
   * The cell used here is reachable through nothing but the app's own paths, and
   * that is the point. `datesBetween` in approvedLeaveMonth expands a request
   * over every CALENDAR day, while decideLeave writes attendance for WORKING
   * days only -- so a Sunday inside an approved range is leave-covered and keeps
   * whatever status it already had. A supervisor who marked that Sunday
   * `weekly_off` before the leave was approved now holds a page with a
   * leave-covered cell storing a non-leave status, which is the one shape that
   * makes the ordering observable.
   *
   * These two tests are a pair: the same cell, the same request, and the only
   * difference is whether the posted status is the one already stored. Swap the
   * order in recordAttendanceGrid and the second one goes red.
   */
  describe('a stale page, and the cell it is not trying to change', () => {
    /** A Sunday: 2026 has Sundays on June 7, 14, 21 and 28. */
    const SUNDAY = '2026-06-07'
    let requestId = 0

    beforeAll(async () => {
      // Marked FIRST, as a supervisor marking the week would. Doing it after the
      // approval is refused, which is the refusal this pair is about.
      const marked = await svc.recordAttendanceGrid(
        db,
        actor,
        matrix(GRID_MONTH, [{ employeeId: betaId, day: 7, status: 'weekly_off' }], { projectId }),
        { canOverridePeriod: false }
      )
      expect(marked).toEqual({ inserted: 1, updated: 0, unchanged: 0 })

      // Raised on behalf, which waives EL's notice: the range is in the past
      // because attendance is only recorded for days that have passed.
      requestId = await svc.requestLeave(
        db,
        actor,
        leaveInput({
          employeeId: String(betaId),
          fromDate: '2026-06-06',
          toDate: '2026-06-08',
          reason: 'Fixture leave spanning a Sunday',
        }),
        { selfEmployeeId: alphaId, canRaiseForOthers: true }
      )
      await svc.decideLeave(
        db,
        actor,
        requestId,
        { decision: 'approve', rejectReason: null },
        { approverEmployeeId: alphaId, canOverridePeriod: false }
      )
    })

    it('leaves a Sunday inside an approved range covered but not rewritten', async () => {
      // The fixture only works if both halves hold, so both are asserted rather
      // than assumed: the day is leave-covered, and it still stores the status
      // the supervisor put there.
      const covered = await q.approvedLeaveMonth(db, GRID_MONTH)
      expect(covered).toContainEqual({
        employee_id: betaId,
        attendance_date: SUNDAY,
        request_id: requestId,
        type_code: 'EL',
      })
      expect(await cell(betaId, SUNDAY)).toMatchObject({ status: 'weekly_off' })
      // And the working days either side of it were written by the approval.
      expect(await cell(betaId, '2026-06-06')).toMatchObject({ status: 'paid_leave' })
      expect(await cell(betaId, '2026-06-08')).toMatchObject({ status: 'paid_leave' })
    })

    it('refuses that cell when the post tries to change it, and names the request', async () => {
      await expect(
        svc.recordAttendanceGrid(
          db,
          actor,
          matrix(GRID_MONTH, [{ employeeId: betaId, day: 7, status: 'present' }]),
          { canOverridePeriod: false }
        )
      ).rejects.toThrow(new RegExp(`approved leave covering ${SUNDAY} \\(request ${requestId}\\)`))
    })

    it('takes the same cell when the post carries it back unchanged, alongside a real correction', async () => {
      const result = await svc.recordAttendanceGrid(
        db,
        actor,
        matrix(GRID_MONTH, [
          // Leave-covered, storing a status the refusal above rejects, and
          // posted back exactly as stored: not a write, so not refused.
          { employeeId: betaId, day: 7, status: 'weekly_off' },
          // The correction on the same page, which has to land.
          { employeeId: alphaId, day: 4, status: 'absent' },
        ]),
        { canOverridePeriod: false }
      )
      expect(result).toEqual({ inserted: 0, updated: 1, unchanged: 1 })
      expect(await cell(alphaId, '2026-06-04')).toMatchObject({ status: 'absent' })
      expect(await cell(betaId, SUNDAY)).toMatchObject({ status: 'weekly_off' })
    })
  })

  it('audits one entry per post, including the post that wrote nothing', async () => {
    const rows = await db
      .selectFrom('audit_log')
      .select(['after_json'])
      .where('action', '=', 'hr.attendance_grid')
      .where('id', '>', highWater.get('audit_log') ?? 0)
      .orderBy('id')
      .execute()
    // Eight posts have succeeded: the six-cell insert, the unchanged re-post, the
    // two halves of the one-cell/whole-page pair, the overhead insert beside a
    // correction, the leaver's last day, the Sunday marked before the leave was
    // approved, and the stale page carrying it back. Every refusal above threw
    // inside the transaction and wrote nothing at all.
    expect(rows).toHaveLength(8)

    const entries = rows.map((r) => parseJsonColumn(r.after_json) as Record<string, unknown>)
    expect(entries[0]).toMatchObject({ month: GRID_MONTH, inserted: 6, updated: 0, unchanged: 0 })
    expect(Number(entries[0]!.project_id)).toBe(projectId)
    // employee:date:status, so a corrected month is readable without a join.
    expect(entries[0]!.changed).toContain(`${betaId}:2026-06-02:half_day`)
    expect((entries[0]!.changed as string[]).length).toBe(6)

    // "Reviewed and there was nothing to correct" and "nobody looked" are
    // different facts, so the no-op is recorded -- with an empty changed list,
    // which is what distinguishes it from a post that did something.
    expect(entries[1]).toMatchObject({ inserted: 0, updated: 0, unchanged: 6, changed: [] })
    expect(entries[1]!.period_override).toBeUndefined()
  })

  /*
   * `approvedLeaveMonth` is the one lookup the matrix could not do a day at a
   * time, and the clipping is the part its own comment in queries.ts calls easy
   * to get wrong. Nothing above asserts it: the Sunday construction proves the
   * query sees a request that lies wholly inside the month, which is the case
   * that needs no clipping at all.
   *
   * Placed last in the file on purpose. Approving the range below writes
   * attendance in three months and adds an employee, so it must not run before
   * anything that counts rows or audit entries.
   */
  describe('approvedLeaveMonth, a request that starts and ends outside the month it covers', () => {
    let epsilonId = 0
    let spanId = 0

    /** Only this employee's cells, since the fixture shares the months with others. */
    async function covered(month: string) {
      const cells = await q.approvedLeaveMonth(db, month)
      return cells.filter((c) => c.employee_id === epsilonId).map((c) => c.attendance_date)
    }

    beforeAll(async () => {
      epsilonId = await svc.createEmployee(
        db,
        actor,
        employeeInput({ fullName: 'Fixture Spanner Epsilon', gender: 'male' })
      )
      // Raised on behalf, which waives EL's notice, and then approved: the query
      // filters on `approved`, so a pending request would make every assertion
      // below pass for the wrong reason.
      spanId = await svc.requestLeave(
        db,
        actor,
        leaveInput({
          employeeId: String(epsilonId),
          fromDate: '2026-04-29',
          toDate: '2026-06-02',
          reason: 'Fixture leave spanning three months',
        }),
        { selfEmployeeId: alphaId, canRaiseForOthers: true }
      )
      const decided = await svc.decideLeave(
        db,
        actor,
        spanId,
        { decision: 'approve', rejectReason: null },
        { approverEmployeeId: alphaId, canOverridePeriod: false }
      )
      expect(decided.decision).toBe('approve')
    })

    it('covers every day of the month in the middle, both endpoints being outside it', async () => {
      const may = await covered('2026-05')
      // 31 and not 26. This is coverage by the request, which is what a refusal
      // has to be measured against; the 26 is how many working days `decideLeave`
      // wrote attendance rows for, and the gap between the two numbers is the
      // asymmetry the stale-page block above depends on.
      expect(may).toHaveLength(31)
      expect(may[0]).toBe('2026-05-01')
      expect(may[30]).toBe('2026-05-31')
    })

    it('clips to the month asked about instead of reporting the request dates', async () => {
      // The request runs 29 April to 2 June. Each end month gets its own days and
      // nothing beyond the boundary, which is the whole of what clipping means.
      expect(await covered('2026-04')).toEqual(['2026-04-29', '2026-04-30'])
      expect(await covered('2026-06')).toEqual(['2026-06-01', '2026-06-02'])
      expect(await covered('2026-03')).toEqual([])
      expect(await covered('2026-07')).toEqual([])
    })

    it('names the request on every day it expanded, so a refusal can quote it', async () => {
      const cells = await q.approvedLeaveMonth(db, '2026-05')
      const mine = cells.filter((c) => c.employee_id === epsilonId)
      expect(new Set(mine.map((c) => c.request_id))).toEqual(new Set([spanId]))
      expect(new Set(mine.map((c) => c.type_code))).toEqual(new Set(['EL']))
    })

    it('does not see a request nobody has approved', async () => {
      // Otherwise the grid would refuse a cell over a request still waiting for a
      // decision, and the message would name a request the approver could not yet
      // have seen.
      const pendingId = await svc.requestLeave(
        db,
        actor,
        leaveInput({
          employeeId: String(epsilonId),
          fromDate: '2026-07-01',
          toDate: '2026-07-03',
          reason: 'Fixture leave left pending on purpose',
        }),
        { selfEmployeeId: alphaId, canRaiseForOthers: true }
      )
      expect(pendingId).toBeGreaterThan(0)
      expect(await covered('2026-07')).toEqual([])
    })
  })
})
