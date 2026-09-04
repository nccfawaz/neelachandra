import { describe, expect, it } from 'vitest'
import {
  attendanceApproveSchema,
  attendanceBulkSchema,
  firstError,
  leaveDecisionSchema,
  leaveRequestSchema,
  monthInput,
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
