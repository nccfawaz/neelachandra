import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  addYears,
  currentFinancialYear,
  datesBetween,
  daysBetween,
  financialYear,
  financialYearBounds,
  formatDate,
  formatDateTime,
  formatMonth,
  isValidIsoDate,
  isWorkingDay,
  monthBounds,
  monthOf,
  nowSqlDateTime,
  periodOf,
  previousWorkingDay,
  relativeDays,
  sqlDateTimeIn,
  today,
  weekdayShort,
  workingDaysBetween,
  yesterday,
} from '../src/lib/dates.js'

/**
 * Every date in this application is a business date in Bengaluru, not an
 * instant. These tests pin the two things that break silently: the +05:30
 * conversion (a UTC server must not call 2026-04-01 00:30 IST "31 March") and
 * the Indian financial year boundary, which document numbering resets on.
 */

/** 2026-03-31 20:00 UTC is 2026-04-01 01:30 IST: a different date and a different FY. */
const LATE_UTC_MARCH = new Date('2026-03-31T20:00:00Z')
/** 2026-04-01 02:00 UTC is 2026-04-01 07:30 IST: same date either way. */
const MORNING_UTC_APRIL = new Date('2026-04-01T02:00:00Z')

describe('today', () => {
  it('reads the Bengaluru calendar, not the UTC one', () => {
    expect(today(LATE_UTC_MARCH)).toBe('2026-04-01')
    expect(today(MORNING_UTC_APRIL)).toBe('2026-04-01')
  })

  it('is always YYYY-MM-DD', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('yesterday', () => {
  it('steps back one Bengaluru day', () => {
    expect(yesterday(LATE_UTC_MARCH)).toBe('2026-03-31')
  })
})

describe('nowSqlDateTime', () => {
  it('is the DATETIME format in Bengaluru wall time', () => {
    expect(nowSqlDateTime(LATE_UTC_MARCH)).toBe('2026-04-01 01:30:00')
  })

  it('does not print 24 for midnight', () => {
    // en-CA with hour12: false renders midnight as 24 in some ICU versions,
    // which MariaDB rejects on a DATETIME. 18:30 UTC is exactly midnight IST.
    expect(nowSqlDateTime(new Date('2026-03-31T18:30:00Z'))).toBe('2026-04-01 00:00:00')
  })
})

describe('sqlDateTimeIn', () => {
  it('offsets by seconds, for session expiry columns', () => {
    expect(sqlDateTimeIn(3600, LATE_UTC_MARCH)).toBe('2026-04-01 02:30:00')
    expect(sqlDateTimeIn(-90, LATE_UTC_MARCH)).toBe('2026-04-01 01:28:30')
  })
})

describe('addDays', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('is a no-op at zero', () => {
    expect(addDays('2026-09-03', 0)).toBe('2026-09-03')
  })
})

describe('addMonths and addYears', () => {
  it('clamps the way the platform Date does when the day does not exist', () => {
    // 31 January plus one month has no 31 February; Date rolls into March.
    // Recorded because the MSME 45-day clock and payment terms both use it.
    expect(addMonths('2026-01-31', 1)).toBe('2026-03-03')
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addYears('2026-09-03', 1)).toBe('2027-09-03')
    expect(addYears('2028-02-29', 1)).toBe('2029-03-01')
  })
})

describe('daysBetween', () => {
  it('counts calendar days, signed', () => {
    expect(daysBetween('2026-09-01', '2026-09-03')).toBe(2)
    expect(daysBetween('2026-09-03', '2026-09-01')).toBe(-2)
    expect(daysBetween('2026-09-03', '2026-09-03')).toBe(0)
    expect(daysBetween('2026-03-31', '2026-04-01')).toBe(1)
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365)
  })
})

describe('financialYear', () => {
  it('runs 1 April to 31 March', () => {
    expect(financialYear('2026-04-01')).toBe('2026-27')
    expect(financialYear('2027-03-31')).toBe('2026-27')
    expect(financialYear('2026-03-31')).toBe('2025-26')
    expect(financialYear('2026-12-31')).toBe('2026-27')
  })

  it('pads a century rollover to two digits', () => {
    expect(financialYear('2099-04-01')).toBe('2099-00')
  })

  it('agrees with currentFinancialYear on the same instant', () => {
    expect(currentFinancialYear(LATE_UTC_MARCH)).toBe('2026-27')
    expect(currentFinancialYear(new Date('2026-03-31T10:00:00Z'))).toBe('2025-26')
  })
})

describe('financialYearBounds', () => {
  it('round-trips with financialYear', () => {
    const bounds = financialYearBounds('2026-27')
    expect(bounds).toEqual({ start: '2026-04-01', end: '2027-03-31' })
    expect(financialYear(bounds.start)).toBe('2026-27')
    expect(financialYear(bounds.end)).toBe('2026-27')
    expect(financialYear(addDays(bounds.end, 1))).toBe('2027-28')
    expect(financialYear(addDays(bounds.start, -1))).toBe('2025-26')
  })
})

describe('periodOf', () => {
  it('pairs the calendar month with the financial year it belongs to', () => {
    expect(periodOf('2026-04-01')).toEqual({ financialYear: '2026-27', month: 4 })
    expect(periodOf('2027-01-15')).toEqual({ financialYear: '2026-27', month: 1 })
    expect(periodOf('2026-03-15')).toEqual({ financialYear: '2025-26', month: 3 })
  })
})

describe('isWorkingDay and previousWorkingDay', () => {
  it('treats Sunday as the only weekly off', () => {
    // 2026-09-06 is a Sunday.
    expect(isWorkingDay('2026-09-06')).toBe(false)
    expect(isWorkingDay('2026-09-05')).toBe(true)
    expect(isWorkingDay('2026-09-07')).toBe(true)
  })

  it('steps back past Sunday for the missing-DPR check', () => {
    expect(previousWorkingDay('2026-09-07')).toBe('2026-09-05')
    expect(previousWorkingDay('2026-09-05')).toBe('2026-09-04')
  })
})

describe('formatDate and formatDateTime', () => {
  it('prints the display format without a leading zero on the day', () => {
    expect(formatDate('2026-09-02')).toBe('2 Sep 2026')
    expect(formatDate('2026-12-25')).toBe('25 Dec 2026')
  })

  it('accepts a DATETIME and keeps only the date part', () => {
    expect(formatDate('2026-09-02 14:30:00')).toBe('2 Sep 2026')
    expect(formatDateTime('2026-09-02 14:30:00')).toBe('2 Sep 2026, 14:30')
    expect(formatDateTime('2026-09-02')).toBe('2 Sep 2026')
  })

  it('renders null and undefined as empty', () => {
    expect(formatDate(null)).toBe('')
    expect(formatDate(undefined)).toBe('')
    expect(formatDateTime(null)).toBe('')
  })
})

describe('relativeDays', () => {
  it('reads as English on both sides of the reference date', () => {
    expect(relativeDays('2026-09-03', '2026-09-03')).toBe('today')
    expect(relativeDays('2026-09-02', '2026-09-03')).toBe('yesterday')
    expect(relativeDays('2026-08-31', '2026-09-03')).toBe('3 days ago')
    expect(relativeDays('2026-09-04', '2026-09-03')).toBe('tomorrow')
    expect(relativeDays('2026-09-13', '2026-09-03')).toBe('in 10 days')
  })
})

describe('isValidIsoDate', () => {
  it('accepts real dates', () => {
    expect(isValidIsoDate('2026-09-03')).toBe(true)
    expect(isValidIsoDate('2028-02-29')).toBe(true)
  })

  it('rejects impossible dates rather than rolling them over', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false)
    expect(isValidIsoDate('2026-13-01')).toBe(false)
    expect(isValidIsoDate('2026-00-10')).toBe(false)
    expect(isValidIsoDate('2026-04-31')).toBe(false)
  })

  it('rejects anything that is not the exact format', () => {
    expect(isValidIsoDate('3-9-2026')).toBe(false)
    expect(isValidIsoDate('2026-9-3')).toBe(false)
    expect(isValidIsoDate('2026-09-03T00:00:00Z')).toBe(false)
    expect(isValidIsoDate('')).toBe(false)
    expect(isValidIsoDate(null)).toBe(false)
    expect(isValidIsoDate(20260903)).toBe(false)
  })
})

/* The month and working-day helpers the attendance grid and leave counting
   rest on (spec 6.6 rules 1 and 4). ------------------------------------- */

describe('monthBounds', () => {
  it('ends on the real last day, including February in a leap year', () => {
    expect(monthBounds('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    // Derived by stepping a month forward and a day back, so no leap branch.
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(monthBounds('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' })
  })

  it('round-trips with monthOf', () => {
    for (const month of ['2026-01', '2026-04', '2026-11', '2027-02']) {
      const { start, end } = monthBounds(month)
      expect(monthOf(start)).toBe(month)
      expect(monthOf(end)).toBe(month)
    }
  })
})

describe('datesBetween', () => {
  it('is inclusive of both ends and ascending', () => {
    expect(datesBetween('2026-09-01', '2026-09-04')).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ])
  })

  it('returns the single date when the ends are equal', () => {
    expect(datesBetween('2026-09-04', '2026-09-04')).toEqual(['2026-09-04'])
  })

  it('returns nothing when the range is backwards, rather than looping', () => {
    expect(datesBetween('2026-09-04', '2026-09-01')).toEqual([])
  })

  it('spans a month and covers every day of it', () => {
    const { start, end } = monthBounds('2026-09')
    expect(datesBetween(start, end)).toHaveLength(30)
  })

  it('crosses a year boundary', () => {
    expect(datesBetween('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ])
  })
})

describe('workingDaysBetween', () => {
  it('excludes Sundays, which are the weekly off on these sites', () => {
    // 2026-09-06 and 2026-09-13 are Sundays.
    expect(isWorkingDay('2026-09-06')).toBe(false)
    expect(isWorkingDay('2026-09-13')).toBe(false)
    expect(workingDaysBetween('2026-09-07', '2026-09-11')).toBe(5)
    expect(workingDaysBetween('2026-09-07', '2026-09-13')).toBe(6)
    expect(workingDaysBetween('2026-09-05', '2026-09-07')).toBe(2)
  })

  it('counts a single working day as one and a single Sunday as none', () => {
    expect(workingDaysBetween('2026-09-04', '2026-09-04')).toBe(1)
    // A leave range of nothing but Sundays is refused by the service, which
    // depends on this returning zero rather than one.
    expect(workingDaysBetween('2026-09-06', '2026-09-06')).toBe(0)
  })

  it('counts public holidays, because there is no holiday calendar', () => {
    // 2 October is Gandhi Jayanti, a national holiday, and a Friday in 2026.
    // It counts, which over-counts a leave range containing it by one day in
    // the direction that costs the employee. Recorded in DECISIONS.
    expect(workingDaysBetween('2026-10-02', '2026-10-02')).toBe(1)
  })

  it('gives 26 working days for a 30-day month with four Sundays', () => {
    const { start, end } = monthBounds('2026-09')
    expect(workingDaysBetween(start, end)).toBe(26)
  })
})

describe('formatMonth', () => {
  it('reads as a heading, not as a key', () => {
    expect(formatMonth('2026-09')).toBe('September 2026')
    expect(formatMonth('2027-01')).toBe('January 2027')
  })
})

/*
 * The month matrix's column headers (DECISIONS 22). Two properties matter and
 * neither is about formatting.
 */
describe('weekdayShort', () => {
  it('agrees with isWorkingDay about which column is a Sunday', () => {
    // The one assertion that would catch an off-by-one or a timezone slip: the
    // matrix greys a column by weekdayShort and the service refuses a leave day
    // by isWorkingDay, so a disagreement between them is a grid that greys the
    // wrong column while payroll counts a different one.
    const { start, end } = monthBounds('2026-09')
    for (const date of datesBetween(start, end)) {
      expect(weekdayShort(date) === 'Su').toBe(!isWorkingDay(date))
    }
  })

  it('gives the seven labels in week order', () => {
    // 2026-09-06 is a Sunday, so this walk starts on one.
    expect(datesBetween('2026-09-06', '2026-09-12').map(weekdayShort)).toEqual([
      'Su',
      'Mo',
      'Tu',
      'We',
      'Th',
      'Fr',
      'Sa',
    ])
  })

  it('does not shift across a month or a year boundary', () => {
    // 2025-12-31 is a Wednesday and 2026-01-01 a Thursday. A parse at midnight
    // local time rather than noon UTC is the way this goes wrong, and it goes
    // wrong only on a host west of UTC — which is not this one, so the value of
    // the assertion is that it pins the noon parse rather than that it fails here.
    expect(weekdayShort('2025-12-31')).toBe('We')
    expect(weekdayShort('2026-01-01')).toBe('Th')
    expect(weekdayShort('2026-02-28')).toBe('Sa')
    expect(weekdayShort('2024-02-29')).toBe('Th')
  })
})
