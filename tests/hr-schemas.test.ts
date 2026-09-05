import { describe, expect, it } from 'vitest'
import {
  attendanceApproveSchema,
  attendanceBulkSchema,
  attendanceGridSchema,
  contractorAttendanceSchema,
  firstError,
  leaveDecisionSchema,
  leaveRequestSchema,
  monthInput,
  STATUS_KEYS,
} from '../src/modules/hr/schemas.js'

/**
 * The HR attendance and leave form contracts (spec 6.6 rules 1 and 4).
 *
 * The attendance grid is the highest-risk form in the module and the risk is not
 * in its validation, it is in its SHAPE. `parseBody({ all: true })` hands back a
 * string when a field appears once and an array when it appears twice, so a grid
 * posted for one employee and the same grid posted for two go through different
 * branches -- and the one-employee case is the one nobody tests by hand on a
 * ten-person company. Every test below is run against both shapes where the
 * distinction applies.
 *
 * The second thing pinned here is that a blank status is DROPPED rather than
 * refused. The grid renders every employee on the books, so marking four of ten
 * people posts ten rows, six of them blank. A schema that refused them would
 * make the screen unusable, and one that accepted them would write six rows of
 * ''.
 */

/** One employee marked: every field a scalar, which is the trap. */
const oneRow = {
  attendanceDate: '2026-09-03',
  employeeId: '7',
  status: 'present',
  inTime: '09:00',
  outTime: '18:00',
  overtimeHours: '',
  remarks: '',
}

/** Two employees, the second left blank: arrays, with a hole to be dropped. */
const twoRows = {
  attendanceDate: '2026-09-03',
  employeeId: ['7', '9'],
  status: ['present', ''],
  inTime: ['09:00', ''],
  outTime: ['18:00', ''],
  overtimeHours: ['2', ''],
  remarks: ['', ''],
}

describe('attendanceBulkSchema, the parseBody shape', () => {
  it('reads a single row posted as scalars', () => {
    const parsed = attendanceBulkSchema.safeParse(oneRow)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.rows).toEqual([
      {
        employeeId: 7,
        status: 'present',
        inTime: '09:00:00',
        outTime: '18:00:00',
        overtimeHours: 0,
        remarks: null,
      },
    ])
  })

  it('reads several rows posted as arrays and drops the unmarked ones', () => {
    const parsed = attendanceBulkSchema.safeParse(twoRows)
    expect(parsed.success).toBe(true)
    // Employee 9 was left as 'not marked' and is not written at all. A row of
    // '' would otherwise reach a status ENUM.
    expect(parsed.success && parsed.data.rows.map((r) => r.employeeId)).toEqual([7])
    expect(parsed.success && parsed.data.rows[0]!.overtimeHours).toBe(2)
  })

  it('keeps the positional alignment when the dropped row is first', () => {
    const parsed = attendanceBulkSchema.safeParse({
      ...twoRows,
      status: ['', 'absent'],
      inTime: ['', ''],
      outTime: ['', ''],
      overtimeHours: ['', ''],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.rows).toEqual([
      { employeeId: 9, status: 'absent', inTime: null, outTime: null, overtimeHours: 0, remarks: null },
    ])
  })

  it('widens HH:MM to the TIME column HH:MM:SS and accepts HH:MM:SS unchanged', () => {
    const parsed = attendanceBulkSchema.safeParse({ ...oneRow, inTime: '09:30', outTime: '17:45:30' })
    expect(parsed.success && parsed.data.rows[0]!.inTime).toBe('09:30:00')
    expect(parsed.success && parsed.data.rows[0]!.outTime).toBe('17:45:30')
  })

  it('treats a project as optional, because a day with no project is overhead', () => {
    expect(attendanceBulkSchema.safeParse(oneRow).success).toBe(true)
    const parsed = attendanceBulkSchema.safeParse({ ...oneRow, projectId: '4' })
    expect(parsed.success && parsed.data.projectId).toBe(4)
    const blank = attendanceBulkSchema.safeParse({ ...oneRow, projectId: '' })
    expect(blank.success && blank.data.projectId).toBeNull()
  })
})

describe('attendanceBulkSchema, the refusals', () => {
  const reject = (patch: Record<string, unknown>) => {
    const parsed = attendanceBulkSchema.safeParse({ ...oneRow, ...patch })
    expect(parsed.success).toBe(false)
    return parsed.success ? '' : firstError(parsed.error)
  }

  it('refuses a whole grid with nothing marked, rather than posting nothing', () => {
    expect(reject({ status: '' })).toMatch(/Nothing was marked/)
  })

  it('refuses a status that is not in the enum', () => {
    expect(reject({ status: 'holiday_ish' })).toMatch(/is not an attendance status/)
  })

  it('refuses an unreadable employee id on a row that does carry a status', () => {
    expect(reject({ employeeId: 'x' })).toMatch(/unreadable employee/)
    expect(reject({ employeeId: '0' })).toMatch(/unreadable employee/)
  })

  it('refuses the same employee twice in one day', () => {
    const parsed = attendanceBulkSchema.safeParse({
      ...twoRows,
      employeeId: ['7', '7'],
      status: ['present', 'absent'],
    })
    expect(parsed.success).toBe(false)
    expect(!parsed.success && firstError(parsed.error)).toMatch(/same employee twice/)
  })

  it('holds overtime to the day, not just to the DECIMAL(4,1) column', () => {
    expect(reject({ overtimeHours: '25' })).toMatch(/between 0 and 24/)
    expect(reject({ overtimeHours: '-1' })).toMatch(/between 0 and 24/)
    expect(reject({ overtimeHours: 'two' })).toMatch(/between 0 and 24/)
    const ok = attendanceBulkSchema.safeParse({ ...oneRow, overtimeHours: '2.55' })
    // DECIMAL(4,1) keeps one place, so the rounding happens here rather than
    // silently in the column.
    expect(ok.success && ok.data.rows[0]!.overtimeHours).toBe(2.6)
  })

  it('refuses a time that is not HH:MM, rather than storing null for it', () => {
    expect(reject({ inTime: '9am' })).toMatch(/Enter a time as HH:MM/)
    expect(reject({ outTime: '25:00:00:00' })).toMatch(/Enter a time as HH:MM/)
  })

  it('refuses an out time at or before the in time', () => {
    expect(reject({ inTime: '18:00', outTime: '09:00' })).toMatch(/after the in time/)
    expect(reject({ inTime: '09:00', outTime: '09:00' })).toMatch(/after the in time/)
  })

  it('accepts one time without the other, because a half day may have only one', () => {
    expect(attendanceBulkSchema.safeParse({ ...oneRow, outTime: '' }).success).toBe(true)
    expect(attendanceBulkSchema.safeParse({ ...oneRow, inTime: '' }).success).toBe(true)
  })

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(reject({ attendanceDate: '3-9-2026' })).toMatch(/YYYY-MM-DD/)
  })

  it('truncates remarks to the VARCHAR(255) the column is', () => {
    const parsed = attendanceBulkSchema.safeParse({ ...oneRow, remarks: 'x'.repeat(400) })
    expect(parsed.success && parsed.data.rows[0]!.remarks).toHaveLength(255)
  })
})

describe('monthInput and attendanceApproveSchema', () => {
  it('accepts a real month and refuses a thirteenth one', () => {
    expect(monthInput.safeParse('2026-09').success).toBe(true)
    expect(monthInput.safeParse('2026-12').success).toBe(true)
    expect(monthInput.safeParse('2026-13').success).toBe(false)
    expect(monthInput.safeParse('2026-00').success).toBe(false)
    expect(monthInput.safeParse('2026-9').success).toBe(false)
    expect(monthInput.safeParse('2026-09-01').success).toBe(false)
  })

  it('carries the month and nothing else, because a close has no project scope', () => {
    const parsed = attendanceApproveSchema.safeParse({ month: '2026-09', projectId: '4' })
    expect(parsed.success && parsed.data).toEqual({ month: '2026-09' })
  })
})

/**
 * STATUS_KEYS: the month matrix's keyboard, asserted as a derivation.
 *
 * The point of these three is not the letters. It is that the letters are a
 * FUNCTION of `ATTENDANCE_STATUSES`, so adding a tenth status cannot silently
 * give two cells the same key. The uniqueness test is the one that would catch
 * that; the spelled-out table below it is there so a change to the derivation
 * shows up as a diff someone reads rather than as nine letters quietly moving.
 */
describe('STATUS_KEYS, the derived keyboard', () => {
  it('gives the first free letter of each status, in declaration order', () => {
    // holiday -> 'o' because half_day took 'h'; paid_leave -> 'i' because 'p'
    // and 'a' are gone by then. Both are the derivation working, not a typo.
    expect(STATUS_KEYS).toEqual({
      present: 'p',
      absent: 'a',
      half_day: 'h',
      weekly_off: 'w',
      holiday: 'o',
      paid_leave: 'i',
      unpaid_leave: 'u',
      on_duty_travel: 'n',
      comp_off: 'c',
    })
  })

  it('never gives one letter to two statuses', () => {
    const letters = Object.values(STATUS_KEYS)
    expect(new Set(letters).size).toBe(letters.length)
  })

  it('only ever yields a single lower-case letter, which is what the client indexes by', () => {
    for (const key of Object.values(STATUS_KEYS)) expect(key).toMatch(/^[a-z]$/)
  })
})

/**
 * attendanceGridSchema: the month matrix's wire shape.
 *
 * Read the assertions here against the ones for `attendanceBulkSchema` above.
 * That schema zips six parallel arrays and its tests are mostly about
 * ALIGNMENT -- which row a value lands on. There is no equivalent test below,
 * and there cannot be, because a cell carries its own employee and its own day
 * in the same string. That absence is the property the shape was chosen for.
 */
describe('attendanceGridSchema, the self-identifying cell', () => {
  const post = (cell: unknown, patch: Record<string, unknown> = {}) =>
    attendanceGridSchema.safeParse({ month: '2026-09', cell, ...patch })

  it('reads one cell posted as a scalar, the shape a one-cell save actually has', () => {
    const parsed = post('7|3|present')
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.cells).toEqual([
      { employeeId: 7, date: '2026-09-03', status: 'present' },
    ])
  })

  it('builds the date from the posted month, so a cell cannot name another month', () => {
    const parsed = post(['7|1|present', '9|30|absent'], { month: '2026-04' })
    expect(parsed.success && parsed.data.cells.map((x) => x.date)).toEqual(['2026-04-01', '2026-04-30'])
  })

  it('drops a blank status and keeps the marked cells around it', () => {
    const parsed = post(['7|3|', '9|3|absent', '11|3|'])
    expect(parsed.success && parsed.data.cells).toEqual([
      { employeeId: 9, date: '2026-09-03', status: 'absent' },
    ])
  })

  it('treats a project as optional, because the grid charges only the rows it inserts', () => {
    expect(post('7|3|present').success).toBe(true)
    const with_ = post('7|3|present', { projectId: '4' })
    expect(with_.success && with_.data.projectId).toBe(4)
    const blank = post('7|3|present', { projectId: '' })
    expect(blank.success && blank.data.projectId).toBeNull()
  })
})

describe('attendanceGridSchema, the refusals', () => {
  const reject = (cell: unknown, patch: Record<string, unknown> = {}) => {
    const parsed = attendanceGridSchema.safeParse({ month: '2026-09', cell, ...patch })
    expect(parsed.success).toBe(false)
    return parsed.success ? '' : firstError(parsed.error)
  }

  it('refuses a cell that is not three parts', () => {
    expect(reject('7|3')).toMatch(/unreadable cell/)
    expect(reject('7|3|present|extra')).toMatch(/unreadable cell/)
    expect(reject('')).toMatch(/unreadable cell/)
  })

  it('refuses a day the posted month does not have', () => {
    expect(reject('7|31|present', { month: '2026-09' })).toMatch(/not in 2026-09/)
    expect(reject('7|29|present', { month: '2026-02' })).toMatch(/not in 2026-02/)
    expect(reject('7|0|present')).toMatch(/not in 2026-09/)
    // A leap February has the 29th, so the bound is the month's own length and
    // not a constant 28.
    expect(attendanceGridSchema.safeParse({ month: '2024-02', cell: '7|29|present' }).success).toBe(true)
  })

  it('refuses two controls for one cell whichever of them carries the status', () => {
    expect(reject(['7|3|present', '7|3|absent'])).toMatch(/same day twice/)
    // The blank is dropped AFTER the pair is registered, so a duplicate hidden
    // behind an empty status is still refused.
    expect(reject(['7|3|', '7|3|present'])).toMatch(/same day twice/)
    expect(reject(['7|3|present', '7|3|'])).toMatch(/same day twice/)
  })

  it('refuses a status outside the enum, including one that only looks like one', () => {
    expect(reject('7|3|Present')).toMatch(/not an attendance status/)
    expect(reject('7|3|leave')).toMatch(/not an attendance status/)
  })

  it('refuses a post in which every cell was left blank', () => {
    expect(reject(['7|3|', '9|3|'])).toMatch(/Nothing was marked/)
    // No `cell` field at all is the same refusal and not a crash: `repeated`
    // turns undefined into an empty array.
    expect(attendanceGridSchema.safeParse({ month: '2026-09' }).success).toBe(false)
  })

  it('refuses an unreadable employee before it looks at the day', () => {
    expect(reject('abc|3|present')).toMatch(/unreadable employee/)
    expect(reject('0|3|present')).toMatch(/unreadable employee/)
    expect(reject('-2|3|present')).toMatch(/unreadable employee/)
  })

  it('needs a valid month, because the month is what the lock check is about', () => {
    expect(reject('7|3|present', { month: '2026-13' })).toMatch(/month as YYYY-MM/)
    expect(reject('7|3|present', { month: '' })).toMatch(/month as YYYY-MM/)
  })
})

describe('leaveRequestSchema', () => {
  const base = {
    leaveTypeId: '2',
    fromDate: '2026-09-07',
    toDate: '2026-09-09',
    reason: 'Family function',
  }

  it('defaults the employee to absent, which the route reads as the requester', () => {
    const parsed = leaveRequestSchema.safeParse(base)
    expect(parsed.success && parsed.data.employeeId).toBeNull()
    const onBehalf = leaveRequestSchema.safeParse({ ...base, employeeId: '5' })
    expect(onBehalf.success && onBehalf.data.employeeId).toBe(5)
  })

  it('reads an unchecked checkbox as absent, not as false-ish text', () => {
    expect(leaveRequestSchema.safeParse(base).success && leaveRequestSchema.parse(base).halfDay).toBe(false)
    const checked = leaveRequestSchema.safeParse({ ...base, fromDate: '2026-09-07', toDate: '2026-09-07', halfDay: 'on' })
    expect(checked.success && checked.data.halfDay).toBe(true)
  })

  it('refuses a range that ends before it starts', () => {
    const parsed = leaveRequestSchema.safeParse({ ...base, fromDate: '2026-09-09', toDate: '2026-09-07' })
    expect(parsed.success).toBe(false)
    expect(!parsed.success && firstError(parsed.error)).toMatch(/cannot fall before the first/)
  })

  it('accepts a single-date range', () => {
    expect(leaveRequestSchema.safeParse({ ...base, toDate: base.fromDate }).success).toBe(true)
  })

  it('holds a half day to one date, because DECIMAL(4,1) days cannot express half a week', () => {
    const parsed = leaveRequestSchema.safeParse({ ...base, halfDay: 'on' })
    expect(parsed.success).toBe(false)
    expect(!parsed.success && firstError(parsed.error)).toMatch(/A half day is a single date/)
  })

  it('requires a leave type, because there is no default kind of leave', () => {
    expect(leaveRequestSchema.safeParse({ ...base, leaveTypeId: '' }).success).toBe(false)
    expect(leaveRequestSchema.safeParse({ ...base, leaveTypeId: '0' }).success).toBe(false)
  })
})

describe('leaveDecisionSchema', () => {
  it('takes both outcomes on one route', () => {
    expect(leaveDecisionSchema.safeParse({ decision: 'approve' }).success).toBe(true)
    expect(
      leaveDecisionSchema.safeParse({ decision: 'reject', rejectReason: 'Site is short-handed that week' })
        .success
    ).toBe(true)
  })

  it('refuses a rejection with no reason, which is the thing an employee escalates', () => {
    const parsed = leaveDecisionSchema.safeParse({ decision: 'reject' })
    expect(parsed.success).toBe(false)
    expect(!parsed.success && firstError(parsed.error)).toMatch(/reason for the rejection/)
    expect(leaveDecisionSchema.safeParse({ decision: 'reject', rejectReason: '   ' }).success).toBe(false)
  })

  it('ignores a reason supplied with an approval rather than refusing it', () => {
    const parsed = leaveDecisionSchema.safeParse({ decision: 'approve', rejectReason: 'stray text' })
    expect(parsed.success).toBe(true)
  })

  it('refuses a decision that is neither', () => {
    expect(leaveDecisionSchema.safeParse({ decision: 'maybe' }).success).toBe(false)
  })
})

/**
 * The contractor grid's day/measured split (migration 013, DECISIONS 19.2).
 *
 * Two grids post into one array set, so every property here is really a property
 * of the pairing: the six repeated names line up by index or the form reads one
 * line's quantity against another line's unit. The tests that matter are the ones
 * where a cell is BLANK, because that is where the alignment is load-bearing and
 * where the old single-grid rule -- blank headcount means skip -- can silently
 * discard a measure.
 */
describe('contractorAttendanceSchema, the day and measured split', () => {
  const base = { contractorId: '3', projectId: '5', attendanceDate: '2026-09-04' }
  const reject = (patch: Record<string, unknown>) => {
    const parsed = contractorAttendanceSchema.safeParse({ ...base, ...patch })
    expect(parsed.success).toBe(false)
    return parsed.success ? '' : firstError(parsed.error)
  }

  it('reads a day row posted with no unit at all, which is every row written before 013', () => {
    const parsed = contractorAttendanceSchema.safeParse({
      ...base,
      skillLevel: 'mason',
      headcount: '4',
      overtimeHours: '',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.rows).toEqual([
      { skillLevel: 'mason', uom: 'per_day', workType: '', headcount: 4, quantity: null, overtimeHours: 0 },
    ])
  })

  it('reads the two grids as one indexed set', () => {
    const parsed = contractorAttendanceSchema.safeParse({
      ...base,
      skillLevel: ['mason', 'helper', 'painter'],
      uom: ['per_day', 'per_day', 'per_sqft'],
      workType: ['', '', 'Wall putty'],
      headcount: ['4', '', '2'],
      quantity: ['', '', '240.5'],
      overtimeHours: ['3', '', ''],
    })
    expect(parsed.success).toBe(true)
    // The helper line is blank in both measurable cells and is dropped; the
    // painter line keeps ITS OWN quantity rather than the hole above it.
    expect(parsed.success && parsed.data.rows).toEqual([
      { skillLevel: 'mason', uom: 'per_day', workType: '', headcount: 4, quantity: null, overtimeHours: 3 },
      {
        skillLevel: 'painter',
        uom: 'per_sqft',
        workType: 'Wall putty',
        headcount: 2,
        quantity: 240.5,
        overtimeHours: 0,
      },
    ])
  })

  it('rounds a quantity to the three decimals the column holds', () => {
    const parsed = contractorAttendanceSchema.safeParse({
      ...base,
      skillLevel: 'mason',
      uom: 'per_cum',
      workType: 'PCC 1:4:8',
      headcount: '3',
      quantity: '12.06649',
      overtimeHours: '',
    })
    expect(parsed.success && parsed.data.rows[0]!.quantity).toBe(12.066)
  })

  it('refuses a quantity with no headcount instead of dropping the line', () => {
    // The old rule skipped on a blank headcount, which would have thrown the
    // measure away and reported success.
    expect(
      reject({
        skillLevel: 'mason',
        uom: 'per_sqft',
        workType: 'Plastering',
        headcount: '',
        quantity: '300',
        overtimeHours: '',
      })
    ).toMatch(/quantity of 300 was entered with no headcount/)
  })

  it('refuses a measured line with no quantity, naming the unit', () => {
    expect(
      reject({
        skillLevel: 'mason',
        uom: 'per_sqft',
        workType: 'Plastering',
        headcount: '4',
        quantity: '',
        overtimeHours: '',
      })
    ).toMatch(/per sqft rate is priced by the measure/)
  })

  it('refuses a measured line with no work type, because skill cannot pick the rate', () => {
    expect(
      reject({
        skillLevel: 'mason',
        uom: 'per_sqft',
        workType: '',
        headcount: '4',
        quantity: '300',
        overtimeHours: '',
      })
    ).toMatch(/has to say what work it is for/)
  })

  it('refuses a quantity on a day line, which would state a multiplier nothing reads', () => {
    expect(
      reject({
        skillLevel: 'mason',
        uom: 'per_day',
        workType: '',
        headcount: '4',
        quantity: '300',
        overtimeHours: '',
      })
    ).toMatch(/per-day row is priced by headcount/)
  })

  it('refuses a quantity of zero or below on a measured line', () => {
    for (const quantity of ['0', '-5']) {
      expect(
        reject({ skillLevel: 'mason', uom: 'per_kg', workType: 'Binding wire', headcount: '1', quantity })
      ).toMatch(/priced by the measure, so enter a quantity above zero/)
    }
  })

  // uq_ca is (contractor_id, project_id, attendance_date, skill_level, work_type)
  // since migration 016. These four tests are the form-level mirror of that key,
  // and the basis for what each one asserts is the key itself plus
  // chk_ca_work_type -- both in 016, and 016's header says why each holds. The
  // first two are what the widened key permits and refuses; the third and fourth
  // are refusals the key cannot express, so the schema owns them.
  it('accepts two work types at one skill level on one day, which the old key refused', () => {
    const parsed = contractorAttendanceSchema.safeParse({
      ...base,
      skillLevel: ['mason', 'mason'],
      uom: ['per_sqft', 'per_sqft'],
      workType: ['Plastering', 'Tiling'],
      headcount: ['4', '4'],
      quantity: ['300', '40'],
      overtimeHours: ['', ''],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.rows.map((r) => r.workType)).toEqual(['Plastering', 'Tiling'])
  })

  it('refuses the same skill and the same work type twice, which the key still refuses', () => {
    expect(
      reject({
        skillLevel: ['mason', 'mason'],
        uom: ['per_sqft', 'per_sqft'],
        workType: ['Plastering', 'Plastering'],
        headcount: ['4', '4'],
        quantity: ['300', '40'],
        overtimeHours: ['', ''],
      })
    ).toMatch(/counts mason on Plastering twice for one day/)
  })

  it('refuses a day row that also names a work type, because two of them would not collide', () => {
    // chk_ca_work_type refuses this at the database too. Both exist because a
    // named day row is not a duplicate of an unnamed one in the widened key, so
    // two of them would insert and both bill -- 016's header has the reasoning.
    expect(
      reject({
        skillLevel: 'mason',
        uom: 'per_day',
        workType: 'Plastering',
        headcount: '4',
        quantity: '',
        overtimeHours: '',
      })
    ).toMatch(/cannot also name a work type/)
  })

  it('refuses a day row and a measured row for one skill, as the database now does too', () => {
    // Permitted by uq_ca since 016 ('' and 'Plastering' are different key values)
    // and refused by trg_ca_basis_bi/_bu since 017, whose header proves that no
    // UNIQUE index can express it. The basis for this assertion is that trigger.
    // What stays open at DECISIONS 21.5 is the policy -- two gangs or one gang
    // billed twice -- not which layer answers it. This block is the form-level
    // echo: it covers one submission, and the service covers the whole day.
    expect(
      reject({
        skillLevel: ['mason', 'mason'],
        uom: ['per_day', 'per_sqft'],
        workType: ['', 'Plastering'],
        headcount: ['4', '4'],
        quantity: ['', '300'],
        overtimeHours: ['', ''],
      })
    ).toMatch(/on a day rate and on Plastering for the same date/)
  })

  it('refuses a unit that is not on the rate card', () => {
    expect(
      reject({ skillLevel: 'mason', uom: 'per_hour', workType: 'Plastering', headcount: '4', quantity: '8' })
    ).toMatch(/not one of the rate units/)
  })

  // A lumpsum is the fourth measured unit and the only one whose rate is a whole
  // contract sum rather than a unit price, so `rate x quantity` makes the quantity
  // box a multiplier over the sum. Pinned to 1 by chk_ca_quantity since migration
  // 018; the basis for these four is that constraint and DECISIONS 21.7, which
  // records why the unit was pinned rather than refused on this table. Asserting
  // the refusals rather than the permission, per CLAUDE.md.
  it('gives a lumpsum row a quantity of 1 without being told one', () => {
    const parsed = contractorAttendanceSchema.safeParse({
      ...base,
      skillLevel: 'carpenter',
      uom: 'lumpsum',
      workType: 'False ceiling, Flat 3B',
      headcount: '3',
      quantity: '',
      overtimeHours: '',
    })
    expect(parsed.success).toBe(true)
    // Not null, which is what a per_day row gets: the amount is rate x quantity
    // for every measured unit and a lumpsum takes that path with no third branch.
    expect(parsed.success && parsed.data.rows[0]!.quantity).toBe(1)
  })

  it('refuses a quantity on a lumpsum row, which would multiply the contract sum', () => {
    expect(
      reject({
        skillLevel: 'carpenter',
        uom: 'lumpsum',
        workType: 'False ceiling, Flat 3B',
        headcount: '3',
        quantity: '300',
        overtimeHours: '',
      })
    ).toMatch(/one sum for the whole scope and takes no quantity/)
  })

  it('refuses a fractional lumpsum quantity too, not just a large one', () => {
    // 0.999 is the shape a stage payment would be entered as, and it is refused
    // for the same reason 300 is: the row states a fraction of a contract sum
    // that nothing downstream reads as a stage.
    expect(
      reject({
        skillLevel: 'carpenter',
        uom: 'lumpsum',
        workType: 'False ceiling, Flat 3B',
        headcount: '3',
        quantity: '0.999',
        overtimeHours: '',
      })
    ).toMatch(/takes no quantity/)
  })

  it('refuses a lumpsum row with no work type, because the sum is for a named scope', () => {
    expect(
      reject({
        skillLevel: 'carpenter',
        uom: 'lumpsum',
        workType: '',
        headcount: '3',
        quantity: '',
        overtimeHours: '',
      })
    ).toMatch(/has to name the work the sum is for/)
  })

  it('skips an untouched lumpsum line rather than posting its implied 1', () => {
    // The form posts a blank quantity for every lumpsum line it renders, so the
    // blank-headcount skip has to be what drops an untouched one. A hidden
    // quantity of 1 would instead trip "a quantity with no headcount beside it"
    // and refuse the whole grid over a line nobody filled in.
    const parsed = contractorAttendanceSchema.safeParse({
      ...base,
      skillLevel: ['mason', 'carpenter'],
      uom: ['per_day', 'lumpsum'],
      workType: ['', 'False ceiling, Flat 3B'],
      headcount: ['4', ''],
      quantity: ['', ''],
      overtimeHours: ['', ''],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.rows.map((r) => r.skillLevel)).toEqual(['mason'])
  })
})
