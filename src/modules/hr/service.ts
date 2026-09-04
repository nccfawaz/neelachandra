import { randomUUID } from 'node:crypto'
import type { Db, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { sequenceCode } from '../../lib/numbering.js'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import {
  addDays,
  datesBetween,
  daysBetween,
  financialYear,
  formatMonth,
  isWorkingDay,
  monthBounds,
  monthOf,
  nowSqlDateTime,
  today,
  workingDaysBetween,
} from '../../lib/dates.js'
import { attendanceMonthState, blockerCount, employeeLoginId, exitBlockers, type ExitBlockers } from './queries.js'
import type { AttendanceBulkInput } from './schemas.js'

/**
 * HR policy (spec 6.6).
 *
 * The rules here rather than in the routes are the ones that must hold whichever
 * screen calls them: a compensation revision closes the period it supersedes, an
 * exit clears what the person is holding before it completes, and the two
 * populations of 6.6 never mix -- nothing in this file writes a
 * `labour_contractors` row from an employee form or the reverse.
 *
 * What is deliberately absent: any function that accepts a full Aadhaar number.
 * The column is four characters and the schema refuses more (6.6 rule 6), so
 * there is no code path here that could hold one long enough to log it.
 */

export interface Actor {
  userId: number
  ip: string | null
}

export interface EmployeeInput {
  fullName: string
  fatherOrSpouseName: string | null
  dateOfBirth: string | null
  gender: string | null
  bloodGroup: string | null
  personalPhone: string | null
  personalEmail: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  permanentAddress: string | null
  currentAddress: string | null
  departmentId: number | null
  designationId: number | null
  reportingToEmployeeId: number | null
  employmentType: 'permanent' | 'probation' | 'contract' | 'intern' | 'consultant'
  dateOfJoining: string
  probationUntil: string | null
  baseLocationId: number | null
  pan: string | null
  aadhaarLast4: string | null
  uan: string | null
  pfNumber: string | null
  esiNumber: string | null
  bankAccountName: string | null
  bankAccountNo: string | null
  bankIfsc: string | null
}

/**
 * What goes in the audit trail for an employee write.
 *
 * Not the whole row. `aadhaar_last4` and the bank columns are excluded on
 * purpose: `audit_log` is readable by anyone with `audit.view`, which is a
 * wider grant than `hr.employee_view`, and copying identity and account
 * numbers into it would route around the permission that protects the profile.
 * The audit records that the row changed and which employee it was, which is
 * what an audit is for.
 */
function auditableEmployee(input: EmployeeInput): Record<string, unknown> {
  return {
    full_name: input.fullName,
    employment_type: input.employmentType,
    date_of_joining: input.dateOfJoining,
    department_id: input.departmentId,
    designation_id: input.designationId,
    reporting_to_employee_id: input.reportingToEmployeeId,
    base_location_id: input.baseLocationId,
  }
}

function employeeRow(input: EmployeeInput) {
  return {
    full_name: input.fullName,
    father_or_spouse_name: input.fatherOrSpouseName,
    date_of_birth: input.dateOfBirth,
    gender: input.gender as 'male' | 'female' | 'other' | null,
    blood_group: input.bloodGroup,
    personal_phone: input.personalPhone,
    personal_email: input.personalEmail,
    emergency_contact_name: input.emergencyContactName,
    emergency_contact_phone: input.emergencyContactPhone,
    permanent_address: input.permanentAddress,
    current_address: input.currentAddress,
    department_id: input.departmentId,
    designation_id: input.designationId,
    reporting_to_employee_id: input.reportingToEmployeeId,
    employment_type: input.employmentType,
    date_of_joining: input.dateOfJoining,
    probation_until: input.probationUntil,
    base_location_id: input.baseLocationId,
    pan: input.pan,
    aadhaar_last4: input.aadhaarLast4,
    uan: input.uan,
    pf_number: input.pfNumber,
    esi_number: input.esiNumber,
    bank_account_name: input.bankAccountName,
    bank_account_no: input.bankAccountNo,
    bank_ifsc: input.bankIfsc,
  }
}

/**
 * A reporting line cannot be a cycle.
 *
 * Walked rather than checked one level deep, because A reports to B reports to
 * A is the same mistake as A reports to A and produces an org chart renderer
 * that recurses until the stack ends.
 */
async function assertNoReportingCycle(
  trx: Trx,
  employeeId: number,
  managerId: number | null
): Promise<void> {
  if (managerId === null) return
  if (managerId === employeeId) throw new UnprocessableError('An employee cannot report to themselves.')

  const seen = new Set<number>([employeeId])
  let cursor: number | null = managerId
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new UnprocessableError('That reporting line loops back on itself.')
    }
    seen.add(cursor)
    const row: { reporting_to_employee_id: number | null } | undefined = await trx
      .selectFrom('employees')
      .select('reporting_to_employee_id')
      .where('id', '=', cursor)
      .executeTakeFirst()
    cursor = row?.reporting_to_employee_id ?? null
  }
}

/* Employees -------------------------------------------------------------- */

/**
 * Creates an employee and gives it a code (EMP0007).
 *
 * The code comes from `sequenceCode` against the new row's id, not from
 * `nextNumber`: 6.2's document numbering is a statutory-looking series per
 * financial year, and an employee master record is not a document. Same
 * reasoning and same shape as `createVendor` in inventory, including the
 * throwaway unique code, because `employee_code` is NOT NULL UNIQUE and the id
 * does not exist until the insert returns.
 */
export async function createEmployee(db: Db, actor: Actor, input: EmployeeInput): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('employees')
      .values({
        employee_code: `TMP-${randomUUID().slice(0, 12)}`,
        ...employeeRow(input),
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .executeTakeFirst()

    const employeeId = Number(row.insertId ?? 0)
    await assertNoReportingCycle(trx, employeeId, input.reportingToEmployeeId)

    const code = sequenceCode('EMP', employeeId)
    await trx.updateTable('employees').set({ employee_code: code }).where('id', '=', employeeId).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.employee_create',
      entityType: 'employee',
      entityId: employeeId,
      after: { employee_code: code, ...auditableEmployee(input) },
      ip: actor.ip,
    })
    return employeeId
  })
}

export async function updateEmployee(
  db: Db,
  actor: Actor,
  employeeId: number,
  input: EmployeeInput
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('employees')
      .select([
        'id',
        'employee_code',
        'full_name',
        'employment_type',
        'date_of_joining',
        'department_id',
        'designation_id',
        'reporting_to_employee_id',
        'base_location_id',
        'status',
      ])
      .where('id', '=', employeeId)
      .executeTakeFirst()
    if (!before) throw new NotFoundError('Employee not found')

    await assertNoReportingCycle(trx, employeeId, input.reportingToEmployeeId)

    await trx
      .updateTable('employees')
      .set({ ...employeeRow(input), updated_by: actor.userId })
      .where('id', '=', employeeId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.employee_update',
      entityType: 'employee',
      entityId: employeeId,
      before: {
        full_name: before.full_name,
        employment_type: before.employment_type,
        date_of_joining: before.date_of_joining,
        department_id: before.department_id,
        designation_id: before.designation_id,
        reporting_to_employee_id: before.reporting_to_employee_id,
        base_location_id: before.base_location_id,
      },
      after: auditableEmployee(input),
      ip: actor.ip,
    })
  })
}

/* Compensation (6.6 rule 5) ---------------------------------------------- */

export interface CompensationInput {
  effectiveFrom: string
  ctcAnnualPaise: number
  basicPaise: number | null
  hraPaise: number | null
  conveyancePaise: number | null
  specialAllowancePaise: number | null
  siteAllowancePaise: number | null
  employerPfPaise: number | null
  employerEsiPaise: number | null
  revisionReason: string | null
}

/**
 * A revision, not an edit (6.6 rule 5, and the route is PUT for the same reason).
 *
 * The open row is closed the day before the new one starts, so the history is a
 * set of adjacent non-overlapping periods and "what was he on in August" has one
 * answer. An effective date on or before the current open row's start is refused
 * rather than silently reordered: backdating a revision over a period that has
 * already been paid is a payroll correction, and it needs a person to decide
 * what happens to the payment that was already made.
 */
export async function reviseCompensation(
  db: Db,
  actor: Actor,
  employeeId: number,
  input: CompensationInput
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const employee = await trx
      .selectFrom('employees')
      .select(['id', 'employee_code', 'status'])
      .where('id', '=', employeeId)
      .executeTakeFirst()
    if (!employee) throw new NotFoundError('Employee not found')
    if (employee.status === 'exited') {
      throw new UnprocessableError('That employee has exited. Reopen the record before revising pay.')
    }

    const open = await trx
      .selectFrom('employee_compensation')
      .select(['id', 'effective_from', 'ctc_annual_paise'])
      .where('employee_id', '=', employeeId)
      .orderBy('effective_from', 'desc')
      .limit(1)
      .executeTakeFirst()

    if (open && String(open.effective_from) >= input.effectiveFrom) {
      throw new ConflictError(
        `A compensation period already starts on ${String(open.effective_from)}. A revision must take effect after it.`
      )
    }

    if (open) {
      await trx
        .updateTable('employee_compensation')
        .set({ effective_to: addDays(input.effectiveFrom, -1) })
        .where('id', '=', open.id)
        .execute()
    }

    const inserted = await trx
      .insertInto('employee_compensation')
      .values({
        employee_id: employeeId,
        effective_from: input.effectiveFrom,
        effective_to: null,
        ctc_annual_paise: input.ctcAnnualPaise,
        basic_paise: input.basicPaise,
        hra_paise: input.hraPaise,
        conveyance_paise: input.conveyancePaise,
        special_allowance_paise: input.specialAllowancePaise,
        site_allowance_paise: input.siteAllowancePaise,
        employer_pf_paise: input.employerPfPaise,
        employer_esi_paise: input.employerEsiPaise,
        revision_reason: input.revisionReason,
        approved_by: actor.userId,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const compensationId = Number(inserted.insertId ?? 0)

    // The figures are the point of this audit entry, unlike the employee writes
    // above: hr.payroll_view is the narrower grant and a pay revision with no
    // record of what changed is the one an owner will ask about.
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.compensation_revise',
      entityType: 'employee_compensation',
      entityId: compensationId,
      before: open ? { effective_from: open.effective_from, ctc_annual_paise: open.ctc_annual_paise } : null,
      after: {
        employee_id: employeeId,
        effective_from: input.effectiveFrom,
        ctc_annual_paise: input.ctcAnnualPaise,
        revision_reason: input.revisionReason,
      },
      ip: actor.ip,
    })
    return compensationId
  })
}

/* Documents -------------------------------------------------------------- */

export interface DocumentInput {
  docType: string
  documentNo: string | null
  issuedOn: string | null
  expiresOn: string | null
  fileId: number
}

export async function addEmployeeDocument(
  db: Db,
  actor: Actor,
  employeeId: number,
  input: DocumentInput
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const employee = await trx
      .selectFrom('employees')
      .select(['id'])
      .where('id', '=', employeeId)
      .executeTakeFirst()
    if (!employee) throw new NotFoundError('Employee not found')

    const file = await trx.selectFrom('files').select(['id']).where('id', '=', input.fileId).executeTakeFirst()
    if (!file) throw new UnprocessableError('That attachment no longer exists.')

    const inserted = await trx
      .insertInto('employee_documents')
      .values({
        employee_id: employeeId,
        doc_type: input.docType as 'aadhaar',
        document_no: input.documentNo,
        issued_on: input.issuedOn,
        expires_on: input.expiresOn,
        file_id: input.fileId,
      })
      .executeTakeFirst()

    const documentId = Number(inserted.insertId ?? 0)

    // document_no is not audited. For doc_type 'aadhaar' it would be the number
    // 6.6 rule 6 exists to keep out of the database, and there is no version of
    // this audit entry that is useful enough to justify a per-type exception.
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.document_add',
      entityType: 'employee_document',
      entityId: documentId,
      after: {
        employee_id: employeeId,
        doc_type: input.docType,
        expires_on: input.expiresOn,
        file_id: input.fileId,
      },
      ip: actor.ip,
    })
    return documentId
  })
}

/* Exit (6.6 rule 7) ------------------------------------------------------ */

export interface ExitInput {
  dateOfExit: string
  exitType: 'resigned' | 'terminated' | 'retired' | 'contract_ended' | 'absconded'
  exitReason: string | null
  override: string | null
}

export interface ExitResult {
  blockers: ExitBlockers
  overridden: boolean
}

/**
 * The exit checklist, in one transaction (6.6 rule 7).
 *
 * Order matters. The blockers are read inside the transaction, so a store issue
 * posted while the form was open is still seen. The refusal is
 * UnprocessableError rather than Conflict because the request is well formed and
 * the state of the world is what is wrong with it.
 *
 * The linked login is deactivated and its sessions revoked in the same
 * transaction as the status change, never as a follow-up: an employee row marked
 * exited while a live session still holds their cookie is the failure this is
 * built to prevent. Sessions are revoked rather than deleted so 6.1's session
 * table still shows that a session existed and when it ended.
 */
export async function runExit(
  db: Db,
  actor: Actor,
  employeeId: number,
  input: ExitInput
): Promise<ExitResult> {
  return db.transaction().execute(async (trx) => {
    const employee = await trx
      .selectFrom('employees')
      .select(['id', 'employee_code', 'full_name', 'user_id', 'status', 'date_of_joining'])
      .where('id', '=', employeeId)
      .executeTakeFirst()
    if (!employee) throw new NotFoundError('Employee not found')
    if (employee.status === 'exited') throw new ConflictError('That employee has already exited.')
    if (input.dateOfExit < String(employee.date_of_joining)) {
      throw new UnprocessableError('The date of exit cannot fall before the date of joining.')
    }

    const blockers = await exitBlockers(trx, employeeId)
    const outstanding = blockerCount(blockers)
    if (outstanding > 0 && !input.override) {
      const subject = outstanding === 1 ? '1 item still sits' : `${outstanding} items still sit`
      throw new UnprocessableError(
        `${subject} with this employee. Clear ${outstanding === 1 ? 'it' : 'them'}, or record a reason to complete the exit anyway.`
      )
    }

    await trx
      .updateTable('employees')
      .set({
        date_of_exit: input.dateOfExit,
        exit_type: input.exitType,
        exit_reason: input.exitReason,
        status: 'exited',
        updated_by: actor.userId,
      })
      .where('id', '=', employeeId)
      .execute()

    // Resolved rather than read off this row: nothing writes employees.user_id,
    // so `if (employee.user_id)` deactivated no login at all for an account
    // created through 6.1's user screen. See employeeLoginId.
    const loginId = await employeeLoginId(trx, employeeId, employee.user_id)
    if (loginId !== null) {
      await trx.updateTable('users').set({ status: 'inactive' }).where('id', '=', loginId).execute()
      await trx
        .updateTable('user_sessions')
        .set({ revoked_at: nowSqlDateTime() })
        .where('user_id', '=', loginId)
        .where('revoked_at', 'is', null)
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.employee_exit',
      entityType: 'employee',
      entityId: employeeId,
      before: { status: employee.status },
      after: {
        status: 'exited',
        date_of_exit: input.dateOfExit,
        exit_type: input.exitType,
        exit_reason: input.exitReason,
        login_deactivated: loginId !== null,
        blockers_outstanding: outstanding,
        override_reason: outstanding > 0 ? input.override : null,
      },
      ip: actor.ip,
    })

    return { blockers, overridden: outstanding > 0 }
  })
}

/* Attendance (6.6 rules 1 and 4) ----------------------------------------- */

/**
 * The month lock, in one place (6.6 rule 4).
 *
 * Rule 4 says approved months "reject updates unless `finance.period_close` is
 * held". Two things follow that are easy to get wrong:
 *
 *   - It has to block INSERTS too, not just updates. A month closed with
 *     twenty days entered and the twenty-first added afterwards changes the
 *     same payroll figure that rule 4 exists to freeze, and an insert is how
 *     that happens in practice.
 *   - The lock is derived from `attendance.approved_at`, because there is no
 *     `attendance_periods` table. `accounting_periods` is finance's own lock and
 *     its `finance.period_close` is rule 4's *override*, so using it as the lock
 *     would make one permission both the gate and the key.
 */
async function assertMonthOpen(trx: Trx, month: string, canOverride: boolean): Promise<void> {
  if (canOverride) return
  const state = await attendanceMonthState(trx, month)
  if (state.locked) {
    throw new UnprocessableError(
      `${formatMonth(month)} is closed: ${state.approved} of its ${state.total} attendance rows are approved. Reopening a closed month needs finance.period_close, because a payroll figure that changes after the payment is made is the thing this lock prevents.`
    )
  }
}

export interface AttendanceBulkResult {
  inserted: number
  updated: number
}

/**
 * One post for a whole day across a project (spec 6.6, rule 1).
 *
 * Every refusal here is about a row that would corrupt 6.8's cost allocation
 * rather than about the shape of the request, so they are all 422 and they all
 * name the person: a supervisor marking ten people needs to know which one was
 * rejected.
 *
 * The approved-leave check is the one that is not obvious. `approveLeave` writes
 * the `paid_leave` and `unpaid_leave` rows itself and adds the days to
 * `leave_balances.availed`, so a supervisor overwriting one of those days with
 * `present` would leave the balance saying a day was taken and the attendance
 * saying it was worked. Marking over an approved leave is refused and the
 * request number is in the message, because withdrawing the request is the
 * correct way to undo it.
 */
export async function recordAttendanceBulk(
  db: Db,
  actor: Actor,
  input: AttendanceBulkInput,
  opts: { canOverridePeriod: boolean }
): Promise<AttendanceBulkResult> {
  if (input.attendanceDate > today()) {
    throw new UnprocessableError('That date has not happened yet. Attendance is recorded for a day that has passed.')
  }

  return db.transaction().execute(async (trx) => {
    const month = monthOf(input.attendanceDate)
    await assertMonthOpen(trx, month, opts.canOverridePeriod)

    if (input.projectId !== null) {
      const project = await trx
        .selectFrom('projects')
        .select(['id', 'code'])
        .where('id', '=', input.projectId)
        .executeTakeFirst()
      if (!project) throw new UnprocessableError('That project no longer exists.')
    }

    const ids = input.rows.map((r) => r.employeeId)
    const employees = await trx
      .selectFrom('employees')
      .select(['id', 'employee_code', 'full_name', 'date_of_joining', 'date_of_exit'])
      .where('id', 'in', ids)
      .execute()
    const employeeById = new Map(employees.map((e) => [Number(e.id), e]))

    const priorRows = await trx
      .selectFrom('attendance')
      .select(['id', 'employee_id', 'status', 'approved_at'])
      .where('attendance_date', '=', input.attendanceDate)
      .where('employee_id', 'in', ids)
      .execute()
    const priorByEmployee = new Map(priorRows.map((r) => [Number(r.employee_id), r]))

    const approvedLeave = await trx
      .selectFrom('leave_requests')
      .select(['id', 'employee_id', 'from_date', 'to_date'])
      .where('status', '=', 'approved')
      .where('employee_id', 'in', ids)
      .where('from_date', '<=', input.attendanceDate)
      .where('to_date', '>=', input.attendanceDate)
      .execute()
    const leaveByEmployee = new Map(approvedLeave.map((r) => [Number(r.employee_id), r]))

    const LEAVE_STATUSES = ['paid_leave', 'unpaid_leave', 'half_day']
    let inserted = 0
    let updated = 0

    for (const row of input.rows) {
      const employee = employeeById.get(row.employeeId)
      if (!employee) throw new UnprocessableError('One of those employees no longer exists.')

      if (input.attendanceDate < String(employee.date_of_joining)) {
        throw new UnprocessableError(
          `${employee.full_name} joined on ${String(employee.date_of_joining)} and cannot be marked before that.`
        )
      }
      if (employee.date_of_exit !== null && input.attendanceDate > String(employee.date_of_exit)) {
        throw new UnprocessableError(
          `${employee.full_name} left on ${String(employee.date_of_exit)} and cannot be marked after that.`
        )
      }

      const leave = leaveByEmployee.get(row.employeeId)
      if (leave && !LEAVE_STATUSES.includes(row.status)) {
        throw new UnprocessableError(
          `${employee.full_name} has approved leave covering ${input.attendanceDate} (request ${leave.id}). Withdraw the request before marking that day differently, so the leave balance and the attendance do not disagree.`
        )
      }

      const prior = priorByEmployee.get(row.employeeId)
      if (prior && prior.approved_at !== null && !opts.canOverridePeriod) {
        throw new UnprocessableError(
          `${employee.full_name}'s attendance for ${input.attendanceDate} is already approved. Changing it needs finance.period_close.`
        )
      }

      if (prior) {
        await trx
          .updateTable('attendance')
          .set({
            project_id: input.projectId,
            status: row.status,
            in_time: row.inTime,
            out_time: row.outTime,
            overtime_hours: row.overtimeHours,
            remarks: row.remarks,
            marked_by: actor.userId,
            marked_at: nowSqlDateTime(),
          })
          .where('id', '=', Number(prior.id))
          .execute()
        updated += 1
      } else {
        await trx
          .insertInto('attendance')
          .values({
            employee_id: row.employeeId,
            attendance_date: input.attendanceDate,
            project_id: input.projectId,
            status: row.status,
            in_time: row.inTime,
            out_time: row.outTime,
            overtime_hours: row.overtimeHours,
            remarks: row.remarks,
            marked_by: actor.userId,
          })
          .execute()
        inserted += 1
      }
    }

    // One entry for the post, not one per person. The interesting facts are the
    // day, the project it was charged to and who marked it; a row-by-row audit
    // of a ten-person grid buries those in ten near-identical entries.
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.attendance_bulk',
      entityType: 'attendance',
      entityId: null,
      after: {
        attendance_date: input.attendanceDate,
        project_id: input.projectId,
        inserted,
        updated,
        statuses: input.rows.map((r) => `${r.employeeId}:${r.status}`),
        period_override: opts.canOverridePeriod ? true : undefined,
      },
      ip: actor.ip,
    })

    return { inserted, updated }
  })
}

/**
 * Closing a month (6.6 rule 4).
 *
 * Whole month, every employee, no project scope. A close that covered one
 * project would leave the month simultaneously locked and open, and the derived
 * lock in `assertMonthOpen` could not express that without a second table.
 *
 * Already-approved rows are left alone rather than restamped, so `approved_at`
 * keeps saying when the month was first closed.
 */
export async function approveAttendanceMonth(
  db: Db,
  actor: Actor,
  month: string
): Promise<{ approved: number; alreadyApproved: number }> {
  return db.transaction().execute(async (trx) => {
    const state = await attendanceMonthState(trx, month)
    if (state.total === 0) {
      throw new UnprocessableError(`No attendance is recorded for ${formatMonth(month)}, so there is nothing to close.`)
    }
    const pending = state.total - state.approved
    if (pending === 0) {
      throw new ConflictError(`${formatMonth(month)} is already closed.`)
    }

    const { start, end } = monthBounds(month)
    await trx
      .updateTable('attendance')
      .set({ approved_by: actor.userId, approved_at: nowSqlDateTime() })
      .where('attendance_date', '>=', start)
      .where('attendance_date', '<=', end)
      .where('approved_at', 'is', null)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.attendance_approve',
      entityType: 'attendance',
      entityId: null,
      after: { month, approved: pending, already_approved: state.approved },
      ip: actor.ip,
    })

    return { approved: pending, alreadyApproved: state.approved }
  })
}

/* Leave ------------------------------------------------------------------- */

export interface LeaveRequestInput {
  employeeId: number | null
  leaveTypeId: number
  fromDate: string
  toDate: string
  halfDay: boolean
  reason: string | null
  handoverToEmployeeId: number | null
  fileId: number | null
}

/**
 * Raising a leave request.
 *
 * Three judgements are recorded here rather than left to the caller:
 *
 *   `days` counts working days, Sundays excluded, because a Sunday inside a
 *   range is already the weekly off and charging entitlement for it would
 *   overstate what the person took. Public holidays are NOT excluded: there is
 *   no holiday calendar table and inventing the company's holiday list would be
 *   inventing a business rule. Flagged in DECISIONS.
 *
 *   `min_notice_days` is enforced on a self-raised request and waived for one
 *   raised by a holder of `hr.leave_approve`. Maternity leave carries 30 days'
 *   notice in the seed, and a system that cannot record a notification given at
 *   20 days is a system HR keeps outside the system. The waiver is audited.
 *
 *   `leave_types.requires_document` is NOT enforced, because there is no upload
 *   route (DECISIONS 15.1) and three of the seven seeded types need one --
 *   including SL, the most common. Enforcing it would make those three types
 *   unrequestable. The flag is surfaced on the screen instead.
 */
export async function requestLeave(
  db: Db,
  actor: Actor,
  input: LeaveRequestInput,
  opts: { selfEmployeeId: number | null; canRaiseForOthers: boolean }
): Promise<number> {
  const onBehalf = input.employeeId !== null && input.employeeId !== opts.selfEmployeeId
  if (onBehalf && !opts.canRaiseForOthers) {
    throw new ForbiddenError('You can raise leave for yourself. Raising it for someone else needs hr.leave_approve.')
  }

  const employeeId = input.employeeId ?? opts.selfEmployeeId
  if (employeeId === null) {
    throw new UnprocessableError(
      'Your login is not linked to an employee record, so there is no one to book this leave against. Ask HR to link them.'
    )
  }

  return db.transaction().execute(async (trx) => {
    const employee = await trx
      .selectFrom('employees')
      .select(['id', 'employee_code', 'full_name', 'status', 'date_of_joining', 'date_of_exit'])
      .where('id', '=', employeeId)
      .executeTakeFirst()
    if (!employee) throw new NotFoundError('Employee not found')
    if (employee.status === 'exited') {
      throw new UnprocessableError('That employee has exited. Leave cannot be booked against an exited record.')
    }
    if (input.fromDate < String(employee.date_of_joining)) {
      throw new UnprocessableError(
        `Leave cannot start before the date of joining, ${String(employee.date_of_joining)}.`
      )
    }

    const type = await trx
      .selectFrom('leave_types')
      .select(['id', 'code', 'name', 'is_paid', 'min_notice_days', 'requires_document', 'is_active'])
      .where('id', '=', input.leaveTypeId)
      .executeTakeFirst()
    if (!type) throw new UnprocessableError('That leave type no longer exists.')
    if (Number(type.is_active) !== 1) throw new UnprocessableError(`${type.name} is no longer in use.`)

    const days = input.halfDay ? 0.5 : workingDaysBetween(input.fromDate, input.toDate)
    if (days <= 0) {
      throw new UnprocessableError(
        'That range contains no working days. A Sunday is already the weekly off, so there is nothing to book.'
      )
    }

    const notice = Number(type.min_notice_days)
    const givenNotice = daysBetween(today(), input.fromDate)
    if (!onBehalf && notice > 0 && givenNotice < notice) {
      throw new UnprocessableError(
        `${type.name} needs ${notice} days' notice and this gives ${givenNotice}. Someone holding hr.leave_approve can record it for you if the notice cannot be met.`
      )
    }

    const clash = await trx
      .selectFrom('leave_requests')
      .select(['id', 'from_date', 'to_date', 'status'])
      .where('employee_id', '=', employeeId)
      .where('status', 'in', ['pending', 'approved'])
      .where('from_date', '<=', input.toDate)
      .where('to_date', '>=', input.fromDate)
      .executeTakeFirst()
    if (clash) {
      throw new ConflictError(
        `Request ${clash.id} already covers ${String(clash.from_date)} to ${String(clash.to_date)} and is ${clash.status}. Withdraw it before raising another over the same days.`
      )
    }

    if (input.handoverToEmployeeId !== null) {
      if (input.handoverToEmployeeId === employeeId) {
        throw new UnprocessableError('The handover cannot be to the person going on leave.')
      }
      const handover = await trx
        .selectFrom('employees')
        .select(['id', 'status'])
        .where('id', '=', input.handoverToEmployeeId)
        .executeTakeFirst()
      if (!handover) throw new UnprocessableError('That handover employee no longer exists.')
      if (handover.status === 'exited') throw new UnprocessableError('That handover employee has exited.')
    }

    if (input.fileId !== null) {
      const file = await trx.selectFrom('files').select(['id']).where('id', '=', input.fileId).executeTakeFirst()
      if (!file) throw new UnprocessableError('That attachment no longer exists.')
    }

    const insertedRow = await trx
      .insertInto('leave_requests')
      .values({
        employee_id: employeeId,
        leave_type_id: input.leaveTypeId,
        from_date: input.fromDate,
        to_date: input.toDate,
        days,
        reason: input.reason,
        handover_to_employee_id: input.handoverToEmployeeId,
        status: 'pending',
        file_id: input.fileId,
      })
      .executeTakeFirst()

    const requestId = Number(insertedRow.insertId ?? 0)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.leave_request',
      entityType: 'leave_request',
      entityId: requestId,
      after: {
        employee_id: employeeId,
        leave_type: type.code,
        from_date: input.fromDate,
        to_date: input.toDate,
        days,
        raised_on_behalf: onBehalf,
        notice_days_given: givenNotice,
        notice_days_required: notice,
        notice_waived: onBehalf && notice > 0 && givenNotice < notice,
        document_required_and_absent: Number(type.requires_document) === 1 && input.fileId === null,
      },
      ip: actor.ip,
    })

    return requestId
  })
}

export interface LeaveDecisionInput {
  decision: 'approve' | 'reject'
  rejectReason: string | null
}

export interface LeaveDecisionResult {
  decision: 'approve' | 'reject'
  employeeName: string
  days: number
  attendanceRowsWritten: number
  financialYear: string | null
  balanceAfter: number | null
}

/**
 * Approving or rejecting a request, and the two writes an approval implies.
 *
 * Self-approval is refused by EMPLOYEE, not by user id (spec 561 names
 * `approveLeaveRequest()` alongside `approvePurchaseOrder()`). The request is
 * filed against an employee record, so an HR officer whose login is linked to
 * employee 4 cannot approve employee 4's leave even though the row carries no
 * user id at all. The dashboard widget already filters its queue the same way.
 *
 * An approval writes `attendance` rows across the range, which is not
 * bookkeeping tidiness: `paid_leave` and `unpaid_leave` have no other writer in
 * the codebase, and 6.8 rule 10 costs staff time by joining `attendance` to
 * `employee_compensation`, so approved paid leave that never reached
 * `attendance` is leave the company paid for and never charged to anything.
 * Sundays are skipped for the same reason they do not count towards `days`.
 *
 * It also moves `leave_balances.availed`. The balance is TRACKED, not enforced:
 * every seeded `annual_quota` is NULL pending 8.6, so there is no quota to
 * refuse against and a negative balance is a fact for HR to look at rather than
 * a validation failure.
 */
export async function decideLeave(
  db: Db,
  actor: Actor,
  requestId: number,
  input: LeaveDecisionInput,
  opts: { approverEmployeeId: number | null; canOverridePeriod: boolean }
): Promise<LeaveDecisionResult> {
  return db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom('leave_requests')
      .innerJoin('leave_types', 'leave_types.id', 'leave_requests.leave_type_id')
      .innerJoin('employees', 'employees.id', 'leave_requests.employee_id')
      .select([
        'leave_requests.id',
        'leave_requests.employee_id',
        'leave_requests.leave_type_id',
        'leave_requests.from_date',
        'leave_requests.to_date',
        'leave_requests.days',
        'leave_requests.status',
        'leave_types.code as type_code',
        'leave_types.is_paid',
        'employees.full_name as employee_name',
      ])
      .where('leave_requests.id', '=', requestId)
      .executeTakeFirst()
    if (!request) throw new NotFoundError('Leave request not found')
    if (request.status !== 'pending') {
      throw new ConflictError(`That request is already ${request.status}.`)
    }
    if (opts.approverEmployeeId !== null && Number(request.employee_id) === opts.approverEmployeeId) {
      throw new ForbiddenError(
        'This is your own leave, so you cannot approve it. Someone else holding hr.leave_approve has to.'
      )
    }

    const decidedAt = nowSqlDateTime()
    const days = Number(request.days)
    const from = String(request.from_date)
    const to = String(request.to_date)

    if (input.decision === 'reject') {
      // `approved_by` is the only decision-maker column the table has, so a
      // rejection stamps it too. `status` is what says which way it went.
      await trx
        .updateTable('leave_requests')
        .set({
          status: 'rejected',
          reject_reason: input.rejectReason,
          approved_by: actor.userId,
          approved_at: decidedAt,
        })
        .where('id', '=', requestId)
        .execute()

      await writeAudit(trx, {
        userId: actor.userId,
        action: 'hr.leave_reject',
        entityType: 'leave_request',
        entityId: requestId,
        before: { status: 'pending' },
        after: { status: 'rejected', reject_reason: input.rejectReason, employee_id: request.employee_id },
        ip: actor.ip,
      })

      return {
        decision: 'reject' as const,
        employeeName: request.employee_name,
        days,
        attendanceRowsWritten: 0,
        financialYear: null,
        balanceAfter: null,
      }
    }

    const workingDates = datesBetween(from, to).filter(isWorkingDay)
    const months = [...new Set(workingDates.map(monthOf))]
    for (const month of months) {
      await assertMonthOpen(trx, month, opts.canOverridePeriod)
    }

    // A half day is one date and the enum has a member for it, so it is written
    // as `half_day` rather than as a full day of paid_leave that the muster roll
    // would then count as a whole day absent.
    const isHalf = days < 1 && from === to
    const leaveStatus = isHalf ? 'half_day' : Number(request.is_paid) === 1 ? 'paid_leave' : 'unpaid_leave'

    const priorRows = await trx
      .selectFrom('attendance')
      .select(['id', 'attendance_date', 'approved_at'])
      .where('employee_id', '=', Number(request.employee_id))
      .where('attendance_date', 'in', workingDates)
      .execute()
    const priorByDate = new Map(priorRows.map((r) => [String(r.attendance_date), r]))

    let attendanceRowsWritten = 0
    for (const date of workingDates) {
      const prior = priorByDate.get(date)
      if (prior) {
        // project_id is cleared: a day on leave was not worked on a site, so
        // charging it to that project would put leave cost in a project budget.
        await trx
          .updateTable('attendance')
          .set({
            status: leaveStatus,
            project_id: null,
            in_time: null,
            out_time: null,
            overtime_hours: 0,
            marked_by: actor.userId,
            marked_at: decidedAt,
            remarks: `Leave request ${requestId}`,
          })
          .where('id', '=', Number(prior.id))
          .execute()
      } else {
        await trx
          .insertInto('attendance')
          .values({
            employee_id: Number(request.employee_id),
            attendance_date: date,
            project_id: null,
            status: leaveStatus,
            overtime_hours: 0,
            marked_by: actor.userId,
            remarks: `Leave request ${requestId}`,
          })
          .execute()
      }
      attendanceRowsWritten += 1
    }

    await trx
      .updateTable('leave_requests')
      .set({ status: 'approved', approved_by: actor.userId, approved_at: decidedAt })
      .where('id', '=', requestId)
      .execute()

    // The whole request lands in the financial year its first day falls in, even
    // when the range crosses 31 March. Splitting it would need a rule for which
    // year a March-to-April absence draws down, and 8.6 has not answered the
    // simpler quota question yet. Flagged in DECISIONS.
    const fy = financialYear(from)
    const existing = await trx
      .selectFrom('leave_balances')
      .select(['id', 'opening', 'accrued', 'availed', 'encashed'])
      .where('employee_id', '=', Number(request.employee_id))
      .where('leave_type_id', '=', Number(request.leave_type_id))
      .where('financial_year', '=', fy)
      .executeTakeFirst()

    let balanceAfter: number
    if (existing) {
      const availed = Number(existing.availed) + days
      balanceAfter = Number(existing.opening) + Number(existing.accrued) - availed - Number(existing.encashed)
      await trx
        .updateTable('leave_balances')
        .set({ availed, balance: balanceAfter })
        .where('id', '=', Number(existing.id))
        .execute()
    } else {
      balanceAfter = -days
      await trx
        .insertInto('leave_balances')
        .values({
          employee_id: Number(request.employee_id),
          leave_type_id: Number(request.leave_type_id),
          financial_year: fy,
          opening: 0,
          accrued: 0,
          availed: days,
          encashed: 0,
          balance: balanceAfter,
        })
        .execute()
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.leave_approve',
      entityType: 'leave_request',
      entityId: requestId,
      before: { status: 'pending' },
      after: {
        status: 'approved',
        employee_id: request.employee_id,
        leave_type: request.type_code,
        from_date: from,
        to_date: to,
        days,
        attendance_status_written: leaveStatus,
        attendance_rows_written: attendanceRowsWritten,
        financial_year: fy,
        balance_after: balanceAfter,
        period_override: opts.canOverridePeriod ? true : undefined,
      },
      ip: actor.ip,
    })

    return {
      decision: 'approve' as const,
      employeeName: request.employee_name,
      days,
      attendanceRowsWritten,
      financialYear: fy,
      balanceAfter,
    }
  })
}

/**
 * Taking back your own pending request.
 *
 * Not in the 6.6 route table, but `leave_requests.status` has a `withdrawn`
 * member and nothing else could write it. Restricted to your own row and to a
 * pending one: an approved request has already moved `attendance` and
 * `leave_balances`, so undoing it is a reversal an approver has to make, not a
 * self-service action.
 */
export async function withdrawLeave(
  db: Db,
  actor: Actor,
  requestId: number,
  opts: { selfEmployeeId: number | null }
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom('leave_requests')
      .select(['id', 'employee_id', 'status'])
      .where('id', '=', requestId)
      .executeTakeFirst()
    if (!request) throw new NotFoundError('Leave request not found')
    if (opts.selfEmployeeId === null || Number(request.employee_id) !== opts.selfEmployeeId) {
      throw new ForbiddenError('That is not your leave request.')
    }
    if (request.status !== 'pending') {
      throw new ConflictError(`That request is already ${request.status} and cannot be withdrawn.`)
    }

    await trx.updateTable('leave_requests').set({ status: 'withdrawn' }).where('id', '=', requestId).execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.leave_withdraw',
      entityType: 'leave_request',
      entityId: requestId,
      before: { status: 'pending' },
      after: { status: 'withdrawn' },
      ip: actor.ip,
    })
  })
}
