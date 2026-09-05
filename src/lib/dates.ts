/**
 * Asia/Kolkata dates and the Indian financial year (spec: src/lib/dates.ts).
 *
 * Every date in this application is a local business date in Bengaluru, not
 * an instant. A DPR is filed "on the 3rd", attendance is marked "for the
 * 3rd", and a milestone falls due "on the 3rd". None of those change meaning
 * when the server's clock is UTC, so every helper here converts to
 * Asia/Kolkata before reading the calendar fields.
 *
 * India has no daylight saving and a fixed +05:30 offset, so the conversion
 * is a constant shift rather than a lookup. The Intl formatter is still used
 * for the conversion because a hardcoded offset is the kind of thing that
 * survives until the one time it is wrong.
 */

export const TIMEZONE = 'Asia/Kolkata'

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** Today in Bengaluru as 'YYYY-MM-DD'. */
export function today(now: Date = new Date()): string {
  return dateFormatter.format(now)
}

/** Yesterday in Bengaluru. Used by the missing-DPR alert. */
export function yesterday(now: Date = new Date()): string {
  return addDays(today(now), -1)
}

/** Current Bengaluru wall time as 'YYYY-MM-DD HH:MM:SS', the DATETIME format. */
export function nowSqlDateTime(now: Date = new Date()): string {
  const parts = dateTimeFormatter.formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** A SQL DATETIME a fixed number of seconds from now, for expiry columns. */
export function sqlDateTimeIn(seconds: number, now: Date = new Date()): string {
  return nowSqlDateTime(new Date(now.getTime() + seconds * 1000))
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  // Constructed at UTC noon so a +/- 5:30 shift can never roll the date.
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0))
  dt.setUTCMonth(dt.getUTCMonth() + months)
  return dt.toISOString().slice(0, 10)
}

export function addYears(isoDate: string, years: number): string {
  return addMonths(isoDate, years * 12)
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T12:00:00Z`)
  const b = Date.parse(`${toIso}T12:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/**
 * The Indian financial year label for a date, as '2026-27'. The year runs
 * 1 April to 31 March, which is what document_numbering.fy_reset means and
 * what every statutory return in this business is filed against.
 */
export function financialYear(isoDate: string = today()): string {
  const [y, m] = isoDate.split('-').map(Number)
  const startYear = m! >= 4 ? y! : y! - 1
  const endShort = String((startYear + 1) % 100).padStart(2, '0')
  return `${startYear}-${endShort}`
}

export function currentFinancialYear(now: Date = new Date()): string {
  return financialYear(today(now))
}

export function financialYearBounds(fy: string): { start: string; end: string } {
  const startYear = Number(fy.slice(0, 4))
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` }
}

/** The accounting period key (financial_year, month) a date falls in. */
export function periodOf(isoDate: string): { financialYear: string; month: number } {
  const month = Number(isoDate.slice(5, 7))
  return { financialYear: financialYear(isoDate), month }
}

/**
 * Sunday is the weekly off on Indian construction sites, so the missing-DPR
 * check skips it. Public holidays are not encoded: there is no holiday
 * calendar table in the spec and inventing the company's holiday list would
 * be inventing a business rule.
 */
export function isWorkingDay(isoDate: string): boolean {
  const dt = new Date(`${isoDate}T12:00:00Z`)
  return dt.getUTCDay() !== 0
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

/**
 * Two letters for the day of the week, for a column header in the month matrix.
 *
 * Not `toLocaleDateString`: that reads the server's locale, and a header that
 * says 'Mi' because the host is German is a header nobody here can use. The
 * noon-UTC parse is `isWorkingDay`'s, so the two never disagree about which
 * column is a Sunday.
 */
export function weekdayShort(isoDate: string): string {
  const dt = new Date(`${isoDate}T12:00:00Z`)
  return WEEKDAYS[dt.getUTCDay()] ?? ''
}

export function previousWorkingDay(isoDate: string): string {
  let d = addDays(isoDate, -1)
  while (!isWorkingDay(d)) d = addDays(d, -1)
  return d
}

/** Every date from `fromIso` to `toIso` inclusive, ascending. */
export function datesBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = []
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * Working days in an inclusive range, which is how a leave request is counted.
 *
 * Sundays do not count, because `isWorkingDay` already says a Sunday is the
 * weekly off on these sites and a leave applicant who is off on Sunday anyway
 * should not spend a day of entitlement on it. Public holidays DO count, for
 * the reason isWorkingDay gives: there is no holiday calendar table and
 * inventing the company's holiday list would be inventing a business rule.
 * That makes the figure a slight over-count in a month with a festival in it,
 * in the direction that costs the employee, which is why it is flagged in
 * DECISIONS rather than left as an implementation detail.
 */
export function workingDaysBetween(fromIso: string, toIso: string): number {
  return datesBetween(fromIso, toIso).filter(isWorkingDay).length
}

/**
 * First and last date of a 'YYYY-MM' month.
 *
 * Derived by stepping a month forward and a day back rather than from a table
 * of month lengths, so February 2028 is right without a leap-year branch.
 */
export function monthBounds(month: string): { start: string; end: string } {
  const start = `${month}-01`
  return { start, end: addDays(addMonths(start, 1), -1) }
}

/** '2026-09' to 'September 2026', for a month heading. */
export function formatMonth(month: string): string {
  const { start } = monthBounds(month)
  return new Date(`${start}T12:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** The 'YYYY-MM' a date falls in. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** '2026-09-02' to '2 Sep 2026', the format the dashboards display. */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return ''
  const d = isoDate.slice(0, 10)
  const [y, m, day] = d.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const mi = Number(m) - 1
  if (!months[mi]) return d
  return `${Number(day)} ${months[mi]} ${y}`
}

export function formatDateTime(sqlDateTime: string | null | undefined): string {
  if (!sqlDateTime) return ''
  const s = String(sqlDateTime)
  const datePart = s.slice(0, 10)
  const timePart = s.slice(11, 16)
  return timePart ? `${formatDate(datePart)}, ${timePart}` : formatDate(datePart)
}

/** Relative age for a list column: "3 days ago". */
export function relativeDays(isoDate: string, from: string = today()): string {
  const diff = daysBetween(isoDate, from)
  if (diff === 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff > 1) return `${diff} days ago`
  if (diff === -1) return 'tomorrow'
  return `in ${Math.abs(diff)} days`
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m! < 1 || m! > 12 || d! < 1 || d! > 31) return false
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12))
  return dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d!
}
