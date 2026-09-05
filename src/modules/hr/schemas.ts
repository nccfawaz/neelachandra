import { z } from 'zod'

/**
 * HR input contracts (spec 6.6).
 *
 * Zod at every route boundary, as spec 2.6 requires. Two rules from 6.6 are
 * enforced here rather than in the service because they are properties of the
 * input itself:
 *
 *   Rule 6, full Aadhaar is not stored. The column is `aadhaar_last4 CHAR(4)`
 *   and this schema refuses anything that is not exactly four digits. A
 *   twelve-digit paste is rejected, not truncated: truncating would accept a
 *   full Aadhaar into the request body and from there into whatever logs the
 *   request, which is the thing the Aadhaar Act restricts. The scanned
 *   document goes to `files` behind an access-checked route instead.
 *
 *   Rupees in the form, paise in the column. The conversion happens at this
 *   boundary so nothing downstream ever holds a rupee float (spec 2.4).
 */

/** An empty text input arrives as '', which is not the same as absent. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))

export const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Enter a date as YYYY-MM-DD.')

export const requiredDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.')

/** Rupees in, paise stored. Required variant: a CTC of nothing is not a CTC. */
const rupeesToPaiseRequired = z
  .string()
  .trim()
  .min(1, 'Enter the annual CTC.')
  .transform((v) => {
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN
  })
  .refine((n) => Number.isFinite(n) && n > 0, 'Enter the annual CTC in rupees.')

const rupeesToPaiseOptional = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (v === '' || v === undefined) return null
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? Math.round(n * 100) : null
  })

const optionalId = z
  .string()
  .optional()
  .transform((v) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isInteger(n) && n > 0 ? n : null
  })

export const EMPLOYMENT_TYPES = ['permanent', 'probation', 'contract', 'intern', 'consultant'] as const
export const EMPLOYEE_STATUSES = ['active', 'on_notice', 'on_leave', 'suspended', 'exited'] as const
export const EXIT_TYPES = ['resigned', 'terminated', 'retired', 'contract_ended', 'absconded'] as const
export const GENDERS = ['male', 'female', 'other'] as const

export const DOC_TYPES = [
  'aadhaar',
  'pan',
  'passport',
  'driving_licence',
  'educational',
  'experience',
  'offer_letter',
  'appointment_letter',
  'police_verification',
  'medical_fitness',
  'safety_training',
  'trade_certificate',
  'other',
] as const

/**
 * Exactly the last four digits, or nothing (6.6 rule 6).
 *
 * The refusal message says what the field is for, because a user who typed
 * twelve digits was not being careless -- the label on every other form in
 * India asks for the whole number.
 */
const aadhaarLast4 = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))
  .refine(
    (v) => v === null || /^\d{4}$/.test(v),
    'Enter only the last four digits of the Aadhaar number. The full number is deliberately not stored; attach the scanned document instead.'
  )

const pan = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))
  .refine((v) => v === null || /^[A-Z]{5}\d{4}[A-Z]$/.test(v), 'A PAN looks like ABCDE1234F.')

const ifsc = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))
  .refine((v) => v === null || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), 'An IFSC looks like HDFC0001234.')

const phone = (message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))
    .refine((v) => v === null || /^[0-9+\-\s()]{6,20}$/.test(v), message)

export const employeeSchema = z
  .object({
    fullName: z.string().trim().min(3, 'Enter the full name.').max(140),
    fatherOrSpouseName: optionalText(140),
    dateOfBirth: optionalDate,
    gender: z
      .string()
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : v))
      .refine(
        (v) => v === null || (GENDERS as readonly string[]).includes(v),
        'Choose a valid entry for gender.'
      ),
    bloodGroup: optionalText(5),
    personalPhone: phone('Enter a valid phone number.'),
    personalEmail: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : v))
      .refine((v) => v === null || z.string().email().safeParse(v).success, 'Enter a valid email address.'),
    emergencyContactName: optionalText(120),
    emergencyContactPhone: phone('Enter a valid emergency contact number.'),
    permanentAddress: optionalText(2000),
    currentAddress: optionalText(2000),
    departmentId: optionalId,
    designationId: optionalId,
    reportingToEmployeeId: optionalId,
    employmentType: z.enum(EMPLOYMENT_TYPES),
    dateOfJoining: requiredDate,
    probationUntil: optionalDate,
    baseLocationId: optionalId,
    pan,
    aadhaarLast4: aadhaarLast4,
    uan: optionalText(12),
    pfNumber: optionalText(30),
    esiNumber: optionalText(20),
    bankAccountName: optionalText(140),
    bankAccountNo: optionalText(30),
    bankIfsc: ifsc,
  })
  .refine(
    (v) => v.probationUntil === null || v.probationUntil >= v.dateOfJoining,
    { message: 'Probation cannot end before the date of joining.', path: ['probationUntil'] }
  )
  .refine(
    (v) => v.dateOfBirth === null || v.dateOfBirth < v.dateOfJoining,
    { message: 'The date of birth must fall before the date of joining.', path: ['dateOfBirth'] }
  )

/**
 * A compensation revision (6.6 rule 5).
 *
 * effective_from is required and the service closes the previous row the day
 * before it, so the history is a continuous set of non-overlapping periods
 * rather than a set of rows a reader has to guess the order of.
 */
export const compensationSchema = z
  .object({
    effectiveFrom: requiredDate,
    ctcAnnualPaise: rupeesToPaiseRequired,
    basicPaise: rupeesToPaiseOptional,
    hraPaise: rupeesToPaiseOptional,
    conveyancePaise: rupeesToPaiseOptional,
    specialAllowancePaise: rupeesToPaiseOptional,
    siteAllowancePaise: rupeesToPaiseOptional,
    employerPfPaise: rupeesToPaiseOptional,
    employerEsiPaise: rupeesToPaiseOptional,
    revisionReason: optionalText(160),
  })
  .refine(
    (v) => {
      const parts = [
        v.basicPaise,
        v.hraPaise,
        v.conveyancePaise,
        v.specialAllowancePaise,
        v.siteAllowancePaise,
      ].filter((n): n is number => n !== null)
      if (parts.length === 0) return true
      // Monthly components against an annual CTC: the components are a monthly
      // gross, so twelve of them cannot exceed the annual figure. Caught here
      // because a CTC that disagrees with its own breakdown is a payroll
      // dispute later, and nothing downstream re-checks it.
      return parts.reduce((a, b) => a + b, 0) * 12 <= v.ctcAnnualPaise
    },
    { message: 'The monthly components multiplied by twelve exceed the annual CTC.', path: ['ctcAnnualPaise'] }
  )

/**
 * A document row.
 *
 * The Aadhaar refine closes a hole rule 6 leaves open: `document_no` is
 * VARCHAR(60), so the column that refuses a full Aadhaar on the employee row
 * accepts one here, on a document row for the same person. Rule 6 is about the
 * number not being in the database, not about which table it is in.
 */
export const documentSchema = z
  .object({
    docType: z.enum(DOC_TYPES),
    documentNo: optionalText(60),
    issuedOn: optionalDate,
    expiresOn: optionalDate,
    fileId: z.coerce.number().int().positive('Attach the scanned document.'),
  })
  .refine((v) => v.docType !== 'aadhaar' || v.documentNo === null || /^\d{4}$/.test(v.documentNo), {
    message:
      'For an Aadhaar document record only the last four digits, or leave the number blank. The full number is deliberately not stored.',
    path: ['documentNo'],
  })
  .refine((v) => v.expiresOn === null || v.issuedOn === null || v.expiresOn >= v.issuedOn, {
    message: 'A document cannot expire before it was issued.',
    path: ['expiresOn'],
  })

/**
 * The exit checklist (6.6 rule 7).
 *
 * `override` carries the reason a blocked exit was completed anyway. It is not
 * a boolean: an exit forced through with keys outstanding is exactly the case
 * somebody needs to read six months later.
 */
export const exitSchema = z.object({
  dateOfExit: requiredDate,
  exitType: z.enum(EXIT_TYPES),
  exitReason: optionalText(255),
  override: optionalText(500),
})

/** Turns the first Zod issue into one sentence for the banner. */
export function firstError(err: z.ZodError): string {
  const issue = err.issues[0]
  return issue ? issue.message : 'That submission was not valid.'
}

/* Attendance (6.6 rules 1 and 4) ----------------------------------------- */

export const ATTENDANCE_STATUSES = [
  'present',
  'absent',
  'half_day',
  'weekly_off',
  'holiday',
  'paid_leave',
  'unpaid_leave',
  'on_duty_travel',
  'comp_off',
] as const

export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'] as const

export const monthInput = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month as YYYY-MM.')

/**
 * A repeated form field, normalised.
 *
 * `parseBody({ all: true })` hands back a string when a field appears once and
 * an array when it appears more than once, so a grid submitted for a single
 * employee has a different shape from the same grid submitted for two. Every
 * row field goes through this so the zip below does not have to care.
 */
const repeated = z.preprocess(
  (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]),
  z.array(z.string())
)

/** 'HH:MM' from a time input, widened to the TIME column's 'HH:MM:SS'. */
function toSqlTime(v: string): string | null {
  const t = v.trim()
  if (t === '') return null
  return /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : /^\d{2}:\d{2}:\d{2}$/.test(t) ? t : null
}

export interface AttendanceRowInput {
  employeeId: number
  status: (typeof ATTENDANCE_STATUSES)[number]
  inTime: string | null
  outTime: string | null
  overtimeHours: number
  remarks: string | null
}

export interface AttendanceBulkInput {
  attendanceDate: string
  projectId: number | null
  rows: AttendanceRowInput[]
}

/**
 * One post for a whole day across a project (spec 6.6, the bulk row).
 *
 * The grid renders every employee on the books and posts them all, so a blank
 * status means "not marked today" and is dropped here rather than refused --
 * otherwise marking four of ten people requires deleting six rows from the
 * form. A row with a status but a junk employee id is a different thing and
 * fails.
 *
 * `overtime_hours` is DECIMAL(4,1): 999.9 is the column's ceiling, and 24 is
 * the day's, so the refusal is at 24.
 */
export const attendanceBulkSchema = z
  .object({
    attendanceDate: requiredDate,
    projectId: optionalId,
    employeeId: repeated,
    status: repeated,
    inTime: repeated,
    outTime: repeated,
    overtimeHours: repeated,
    remarks: repeated,
  })
  .transform((v, ctx) => {
    const rows: AttendanceRowInput[] = []
    for (let i = 0; i < v.employeeId.length; i += 1) {
      const status = (v.status[i] ?? '').trim()
      if (status === '') continue

      const employeeId = Number.parseInt(v.employeeId[i] ?? '', 10)
      if (!Number.isInteger(employeeId) || employeeId < 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'That attendance grid posted an unreadable employee.' })
        return z.NEVER
      }
      if (!(ATTENDANCE_STATUSES as readonly string[]).includes(status)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${status}' is not an attendance status.` })
        return z.NEVER
      }

      const otRaw = (v.overtimeHours[i] ?? '').trim()
      const overtimeHours = otRaw === '' ? 0 : Number(otRaw)
      if (!Number.isFinite(overtimeHours) || overtimeHours < 0 || overtimeHours > 24) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Overtime is a number of hours between 0 and 24.' })
        return z.NEVER
      }

      const inTime = toSqlTime(v.inTime[i] ?? '')
      const outTime = toSqlTime(v.outTime[i] ?? '')
      if ((v.inTime[i] ?? '').trim() !== '' && inTime === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a time as HH:MM.' })
        return z.NEVER
      }
      if ((v.outTime[i] ?? '').trim() !== '' && outTime === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a time as HH:MM.' })
        return z.NEVER
      }
      if (inTime !== null && outTime !== null && outTime <= inTime) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The out time has to fall after the in time.' })
        return z.NEVER
      }

      const remarks = (v.remarks[i] ?? '').trim()
      rows.push({
        employeeId,
        status: status as AttendanceRowInput['status'],
        inTime,
        outTime,
        overtimeHours: Math.round(overtimeHours * 10) / 10,
        remarks: remarks === '' ? null : remarks.slice(0, 255),
      })
    }

    if (rows.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Nothing was marked. Set a status on at least one person.' })
      return z.NEVER
    }

    const seen = new Set<number>()
    for (const row of rows) {
      if (seen.has(row.employeeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'That grid marks the same employee twice for one day.',
        })
        return z.NEVER
      }
      seen.add(row.employeeId)
    }

    return { attendanceDate: v.attendanceDate, projectId: v.projectId, rows } satisfies AttendanceBulkInput
  })

/**
 * Closing a month (6.6 rule 4).
 *
 * The month is the whole unit and there is no project scope, because a lock
 * that covered one project's rows and not another's would leave the same month
 * both closed and open, and rule 4 speaks of "`attendance` rows for that
 * period".
 */
export const attendanceApproveSchema = z.object({
  month: monthInput,
})

/* Leave (spec 6.6 route table, and 561 for self-approval) ----------------- */

/** An unchecked checkbox is absent from the body, not 'off'. */
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === 'on' || v === '1' || v === 'true')

/**
 * A leave request.
 *
 * `employeeId` is optional and defaults to the requester's own employee record.
 * When it is present and different, the service demands `hr.leave_approve`:
 * "any employee with a login raises their own" leaves no route for the site
 * staff who have no login at all, and HR entering it for them is the only way
 * those days reach `attendance` and therefore 6.8's staff cost.
 *
 * `halfDay` is restricted to a single date. Half of a five-day range is not a
 * thing the `days DECIMAL(4,1)` column can express usefully, and the two-way
 * split people actually take is a half day on one date.
 */
export const leaveRequestSchema = z
  .object({
    employeeId: optionalId,
    leaveTypeId: z.coerce.number().int().positive('Choose a leave type.'),
    fromDate: requiredDate,
    toDate: requiredDate,
    halfDay: checkbox,
    reason: optionalText(255),
    handoverToEmployeeId: optionalId,
    fileId: optionalId,
  })
  .refine((v) => v.toDate >= v.fromDate, {
    message: 'The last day cannot fall before the first.',
    path: ['toDate'],
  })
  .refine((v) => !v.halfDay || v.fromDate === v.toDate, {
    message: 'A half day is a single date. Clear the half-day box or make both dates the same.',
    path: ['halfDay'],
  })

/**
 * The approver's decision, one route for both outcomes.
 *
 * A rejection with no reason is the thing an employee escalates, so the reason
 * is required for that branch and refused at this boundary rather than left to
 * a nullable column.
 */
export const leaveDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    rejectReason: optionalText(255),
  })
  .refine((v) => v.decision !== 'reject' || v.rejectReason !== null, {
    message: 'Give the reason for the rejection. The employee sees it.',
    path: ['rejectReason'],
  })

/* Contractor labour and bills (spec 6.6 rules 2 and 3) -------------------- */

/**
 * The second population of 6.6, and it never mixes with the first.
 *
 * Nothing in this half of the file names an employee column. A contractor's
 * workers are a headcount per skill per day, not people the company holds
 * identity documents for, and that is the whole reason `contractor_attendance`
 * has a `headcount SMALLINT` where `attendance` has an `employee_id`.
 */

export const SKILL_LEVELS = [
  'skilled',
  'semi_skilled',
  'unskilled',
  'mason',
  'carpenter',
  'barbender',
  'plumber',
  'electrician',
  'painter',
  'helper',
] as const

export const RATE_UOMS = ['per_day', 'per_sqft', 'per_cum', 'per_kg', 'lumpsum'] as const

export type SkillLevel = (typeof SKILL_LEVELS)[number]
export type RateUom = (typeof RATE_UOMS)[number]

export const CONTRACTOR_STATUSES = ['active', 'on_hold', 'blacklisted'] as const

export const CONTRACTOR_BILL_STATUSES = [
  'draft',
  'submitted',
  'verified',
  'approved',
  'paid',
  'disputed',
] as const

/**
 * The contractor master.
 *
 * `code` is entered rather than generated: labour contractors are already known
 * on site by a short name, and 6.6 gives no numbering series for them the way
 * 6.3 gives one for projects.
 *
 * The compliance dates are optional because a contractor who has not produced a
 * licence yet is still a row somebody has to record before the first day is
 * marked. What the absence means is settled in the service: rule 3 refuses a
 * date that HAS PASSED, and a NULL has not passed, so an unrecorded licence
 * does not block. That is the spec's wording, and DECISIONS records it as a hole
 * rather than tightening beyond it here.
 */
export const contractorSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Give the contractor a short code.')
    .max(20, 'The code column holds 20 characters.')
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(3, 'Give the contractor a name.').max(180),
  vendorId: optionalId,
  contactPhone: optionalText(20),
  pan: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v.toUpperCase()))
    .refine((v) => v === null || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), 'A PAN is 10 characters, for example ABCDE1234F.'),
  gstin: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v.toUpperCase()))
    .refine(
      (v) => v === null || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(v),
      'A GSTIN is 15 characters, for example 29ABCDE1234F1Z5.'
    ),
  tradeSpecialisation: optionalText(160),
  licenceNo: optionalText(60),
  licenceValidUntil: optionalDate,
  esiRegistered: checkbox,
  pfRegistered: checkbox,
  wcPolicyNo: optionalText(60),
  wcPolicyValidUntil: optionalDate,
  rating: z
    .string()
    .trim()
    .optional()
    .transform((v) => {
      if (v === '' || v === undefined) return null
      const n = Number.parseInt(v, 10)
      return Number.isInteger(n) ? n : Number.NaN
    })
    .refine((v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 5), 'Rate from 1 to 5, or leave it blank.'),
  status: z.enum(CONTRACTOR_STATUSES).default('active'),
})

/** Rupees in, paise stored, for a figure that must be present and positive. */
const rupeesRequired = (message: string) =>
  z
    .string()
    .trim()
    .min(1, message)
    .transform((v) => {
      const n = Number(v.replace(/,/g, ''))
      return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN
    })
    .refine((n) => Number.isFinite(n) && n > 0, message)

/** Rupees in, paise stored, for a figure that is usually nothing. */
const rupeesOptional = (message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => {
      if (v === '' || v === undefined) return 0
      const n = Number(v.replace(/,/g, ''))
      return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN
    })
    .refine((n) => Number.isFinite(n) && n >= 0, message)

/**
 * A percentage held as basis points, which is how this codebase carries one
 * outside a DECIMAL(5,2) column (migration 011, spec 4.3).
 *
 * The form shows a percent and this converts, so 2.5 arrives as 250. Two decimal
 * places is the ceiling because that is what the finance columns hold, and a
 * third would be silently rounded in the column instead of refused here.
 */
const percentToBasisPoints = (message: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => {
      if (v === '' || v === undefined) return null
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > 100) return Number.NaN
      return Math.round(n * 100)
    })
    .refine((n) => n === null || Number.isFinite(n), message)

/**
 * A rate card line.
 *
 * `effectiveFrom` is required and `effectiveTo` is not: a rate runs until it is
 * superseded, and the service closes the previous line rather than asking the
 * user to date both ends of it.
 *
 * `uom` matters more than it looks. `contractor_attendance` records a headcount
 * and no quantity, so only a `per_day` rate can be priced from a day's
 * attendance. The other four members are recorded here because the column has
 * them and a piece-rate agreement is real, but the service refuses to snapshot
 * one onto an attendance row -- see DECISIONS, this is a structural gap in 6.6
 * rather than a validation choice.
 */
export const contractorRateSchema = z
  .object({
    projectId: optionalId,
    workType: z.string().trim().min(2, 'Name the work this rate is for.').max(120),
    uom: z.enum(RATE_UOMS),
    skillLevel: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : v))
      .pipe(
        z
          .enum(SKILL_LEVELS, { errorMap: () => ({ message: 'That is not one of the skill levels.' }) })
          .nullable()
      ),
    rate: rupeesRequired('Enter the rate in rupees.'),
    effectiveFrom: requiredDate,
    effectiveTo: optionalDate,
  })
  .refine((v) => v.effectiveTo === null || v.effectiveTo >= v.effectiveFrom, {
    message: 'The rate cannot end before it starts.',
    path: ['effectiveTo'],
  })
  .refine((v) => v.uom !== 'per_day' || v.skillLevel !== null, {
    message: 'A per-day rate is priced against a skill level, so choose one.',
    path: ['skillLevel'],
  })

export interface ContractorAttendanceRowInput {
  skillLevel: (typeof SKILL_LEVELS)[number]
  headcount: number
  overtimeHours: number
}

export interface ContractorAttendanceInput {
  contractorId: number
  projectId: number
  attendanceDate: string
  rows: ContractorAttendanceRowInput[]
  overrideCompliance: boolean
}

/**
 * A day's contractor headcount, one row per skill level.
 *
 * The same `repeated` shape as the employee grid and for the same reason: one
 * skill row posts scalars and two post arrays. A blank headcount is dropped
 * rather than refused, because the entry screen renders a row per skill level
 * the contractor has a rate for and a site gate marks two of them.
 *
 * A headcount of 0 IS refused. Blank means "no masons today" and needs no row;
 * a typed zero beside three overtime hours is a contradiction, and the row it
 * would write is one the UNIQUE key then blocks the real figure from taking.
 *
 * `overtimeHours` is the row's total, not per worker: it sits beside a headcount,
 * so a per-worker figure would have to be multiplied by something to mean
 * anything. The ceiling follows from that reading -- twelve extra hours per
 * person is already a very long day. Nothing prices this figure yet; DECISIONS
 * records that overtime is recorded and unpriced until 8.6 gives a multiplier.
 *
 * `projectId` is required, unlike the employee grid's, because
 * `contractor_attendance.project_id` is NOT NULL: contractor labour is always
 * charged to a site, never to overhead.
 */
export const contractorAttendanceSchema = z
  .object({
    contractorId: z.coerce.number().int().min(1, 'Choose a contractor.'),
    projectId: z.coerce.number().int().min(1, 'Choose the project this labour worked on.'),
    attendanceDate: requiredDate,
    skillLevel: repeated,
    headcount: repeated,
    overtimeHours: repeated,
    overrideCompliance: checkbox,
  })
  .transform((v, ctx) => {
    const rows: ContractorAttendanceRowInput[] = []
    const refuse = (message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message })
      return z.NEVER
    }

    for (let i = 0; i < v.skillLevel.length; i += 1) {
      const headRaw = (v.headcount[i] ?? '').trim()
      if (headRaw === '') continue

      const skill = (v.skillLevel[i] ?? '').trim()
      if (!(SKILL_LEVELS as readonly string[]).includes(skill)) {
        return refuse(`'${skill}' is not one of the skill levels.`)
      }

      const headcount = Number(headRaw)
      if (!Number.isInteger(headcount) || headcount < 1 || headcount > 999) {
        return refuse('A headcount is a whole number of people from 1 to 999. Leave it blank for none.')
      }

      const otRaw = (v.overtimeHours[i] ?? '').trim()
      const overtimeHours = otRaw === '' ? 0 : Number(otRaw)
      if (!Number.isFinite(overtimeHours) || overtimeHours < 0) {
        return refuse('Overtime is a number of hours, or blank for none.')
      }
      if (overtimeHours > headcount * 12) {
        return refuse(
          `${overtimeHours} overtime hours across ${headcount} ${headcount === 1 ? 'person' : 'people'} is more than twelve each. Check the figure.`
        )
      }

      rows.push({
        skillLevel: skill as ContractorAttendanceRowInput['skillLevel'],
        headcount,
        overtimeHours: Math.round(overtimeHours * 10) / 10,
      })
    }

    if (rows.length === 0) {
      return refuse('No headcount was entered. Fill in at least one skill row.')
    }

    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.skillLevel)) {
        return refuse(`That form counts ${row.skillLevel.replace(/_/g, ' ')} twice for one day.`)
      }
      seen.add(row.skillLevel)
    }

    return {
      contractorId: v.contractorId,
      projectId: v.projectId,
      attendanceDate: v.attendanceDate,
      rows,
      overrideCompliance: v.overrideCompliance,
    } satisfies ContractorAttendanceInput
  })

/**
 * A contractor, a project and a date range: the key both the approval sweep and
 * the bill generator work on.
 *
 * Not in the 6.6 route table for the approval, which is a gap rather than a
 * choice -- rule 2 bills only rows with `approved_at IS NOT NULL` and the table
 * gives no route that could set it. Flagged in DECISIONS; the route added for it
 * carries `hr.attendance_approve`, the permission rule 4 already uses for the
 * employee side of the same act.
 */
export const contractorPeriodSchema = z
  .object({
    contractorId: z.coerce.number().int().min(1, 'Choose a contractor.'),
    projectId: z.coerce.number().int().min(1, 'Choose a project.'),
    from: requiredDate,
    to: requiredDate,
  })
  .refine((v) => v.to >= v.from, {
    message: 'The last day of the period cannot fall before the first.',
    path: ['to'],
  })

/**
 * Generating a bill (6.6 rule 2).
 *
 * The gross is never in this form: it is summed from approved attendance inside
 * the transaction, because "generated from approved attendance, never typed" is
 * the rule the whole table exists to serve. What IS in the form is the four
 * figures the rule says are applied afterwards, and each of them is here for a
 * different reason:
 *
 *   retentionPct and tdsPct default from `settings` (`finance.retention_default_pct`,
 *   `finance.tds_default_pct`, both basis points since migration 011) and are
 *   overridable per bill, because `contractor_bills` stores the resulting paise
 *   and has no column for the rate that produced them. The service records the
 *   rate in the audit log for that reason.
 *
 *   advanceRecovered is typed because there is nowhere to read it from. No
 *   migration creates a contractor advance table; 6.8 rule 6 tracks advances to
 *   EMPLOYEES as `expenses` rows with `advance_settlement_of`. Recorded in
 *   DECISIONS as a blocking gap rather than invented as a table.
 *
 *   penalty is typed by nature: a liquidated-damages figure is a judgement.
 */
export const contractorBillGenerateSchema = z
  .object({
    contractorId: z.coerce.number().int().min(1, 'Choose a contractor.'),
    projectId: z.coerce.number().int().min(1, 'Choose a project.'),
    from: requiredDate,
    to: requiredDate,
    retentionPct: percentToBasisPoints('Retention is a percentage between 0 and 100.'),
    tdsPct: percentToBasisPoints('TDS is a percentage between 0 and 100.'),
    advanceRecovered: rupeesOptional('Advance recovery is an amount in rupees, or blank for none.'),
    penalty: rupeesOptional('A penalty is an amount in rupees, or blank for none.'),
  })
  .refine((v) => v.to >= v.from, {
    message: 'The last day of the period cannot fall before the first.',
    path: ['to'],
  })
