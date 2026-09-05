import { randomUUID } from 'node:crypto'
import type { Db, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { nextNumber, sequenceCode } from '../../lib/numbering.js'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { resolveApprovalLimit } from '../../lib/permissions.js'
import { applyPct, formatPaise } from '../../lib/money.js'
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
import { attendanceMonthState, blockerCount, employeeLoginId, exitBlockers, applicableRate, type ExitBlockers } from './queries.js'
import type {
  AttendanceBulkInput,
  ContractorAttendanceInput,
  RateUom,
  SkillLevel,
} from './schemas.js'
import { getSetting } from '../../lib/settings.js'

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

/** A day count that reads as English, since half days make `1 days` reachable. */
function dayCount(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`
}

/**
 * The quota gate, written now and dormant until 8.6 supplies the numbers.
 *
 * `leave_types.annual_quota` is NULL for all seven seeded types, and NULL here
 * means "no policy, so nothing to enforce" -- the same shape as
 * `requires_document`, which is recorded on the request and not refused because
 * there is no upload route to satisfy it with. The difference is that this one
 * only needs data: put a number in `annual_quota` and the refusal below starts
 * firing on the next approval, with no deploy.
 *
 * What "available" means is a reading, not a spec statement. The spec gives
 * `annual_quota` on the type and `opening`/`accrued`/`availed`/`encashed` on the
 * balance, and says nothing about how they relate. Nothing writes `accrued`
 * (there is no accrual job), so a gate that only looked at the balance columns
 * would refuse EVERY request the moment a quota was set, which is a trap
 * disguised as a seam. So the entitlement is whichever of `accrued` and the
 * quota is larger: the quota stands in while the accrual column is zero, and an
 * accrual job that catches up takes over from it without another code change.
 * Mid-year that is generous -- 12 days available in month one rather than one
 * twelfth of them -- which is the same direction as the holiday decision in
 * 16.3, towards the employee. Recorded in DECISIONS 17.1.
 */
function assertWithinQuota(
  bal: {
    typeName: string
    quota: number | null
    opening: number
    accrued: number
    availed: number
    encashed: number
  },
  days: number,
  fy: string
): void {
  if (bal.quota === null) return
  const entitlement = Math.max(bal.accrued, bal.quota)
  const available = bal.opening + entitlement - bal.availed - bal.encashed
  if (days <= available) return
  // Rounded to one place because both columns are DECIMAL(n,1) and 0.5 days are
  // real, so a raw float subtraction can otherwise print 2.9000000000000004.
  const shortfall = Math.round((days - available) * 10) / 10
  throw new UnprocessableError(
    `${bal.typeName} has ${dayCount(Math.round(available * 10) / 10)} available in ${fy} against a quota of ${dayCount(bal.quota)}, and this request needs ${dayCount(days)}. It is short by ${dayCount(shortfall)}.`
  )
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
 * It also moves `leave_balances.availed`, and the quota gate sits on that move.
 * Every seeded `annual_quota` is NULL pending 8.6, so the gate is DORMANT: with
 * no quota there is nothing to refuse against and a negative balance stays a
 * fact for HR to look at. Supplying quota values turns it on with no code
 * change, which is the whole point of writing it now -- see DECISIONS 17.1 for
 * what "available" means and why `annual_quota` stands in for `accrued`.
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
        'leave_types.name as type_name',
        'leave_types.annual_quota',
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

    assertWithinQuota(
      {
        typeName: request.type_name,
        quota: request.annual_quota === null ? null : Number(request.annual_quota),
        opening: Number(existing?.opening ?? 0),
        accrued: Number(existing?.accrued ?? 0),
        availed: Number(existing?.availed ?? 0),
        encashed: Number(existing?.encashed ?? 0),
      },
      days,
      fy
    )

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

    // `existing` was read before the attendance writes, because the quota gate
    // above needs it and a refusal should not depend on a rollback to be correct.
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
        // Recorded on every approval, not just the enforced ones, so the day the
        // quota numbers land is legible in the log rather than inferred.
        annual_quota: request.annual_quota === null ? null : Number(request.annual_quota),
        quota_enforced: request.annual_quota !== null,
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

/* ------------------------------------------------------------------ *
 * Contractor labour and bills (spec 6.6 rules 2 and 3)
 *
 * Nothing below reads or writes `employees`. The two populations of 6.6 are
 * separate tables with separate identity, and a contractor's workers are
 * counted by skill level and never named -- `contractor_attendance` has a
 * headcount column and no person column, which is the spec expressing that.
 *
 * Money: every figure is BIGINT paise. `contractor_bills` stores the resulting
 * paise for retention and TDS and has no column for the percentage that
 * produced them, so `generateContractorBill` writes the rate it used into the
 * audit log. That is the only record of it.
 * ------------------------------------------------------------------ */

export interface ContractorInput {
  code: string
  name: string
  vendorId: number | null
  contactPhone: string | null
  pan: string | null
  gstin: string | null
  tradeSpecialisation: string | null
  licenceNo: string | null
  licenceValidUntil: string | null
  esiRegistered: boolean
  pfRegistered: boolean
  wcPolicyNo: string | null
  wcPolicyValidUntil: string | null
  rating: number | null
  status: 'active' | 'on_hold' | 'blacklisted'
}

/** TINYINT(1) columns take 1/0, not a JS boolean: the generated type is number. */
function flag(v: boolean): number {
  return v ? 1 : 0
}

export async function createContractor(db: Db, actor: Actor, input: ContractorInput): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const clash = await trx
      .selectFrom('labour_contractors')
      .select(['id', 'name'])
      .where('code', '=', input.code)
      .executeTakeFirst()
    if (clash) {
      throw new ConflictError(`Code ${input.code} already belongs to ${clash.name}.`)
    }

    const result = await trx
      .insertInto('labour_contractors')
      .values({
        code: input.code,
        name: input.name,
        vendor_id: input.vendorId,
        contact_phone: input.contactPhone,
        pan: input.pan,
        gstin: input.gstin,
        trade_specialisation: input.tradeSpecialisation,
        licence_no: input.licenceNo,
        licence_valid_until: input.licenceValidUntil,
        esi_registered: flag(input.esiRegistered),
        pf_registered: flag(input.pfRegistered),
        wc_policy_no: input.wcPolicyNo,
        wc_policy_valid_until: input.wcPolicyValidUntil,
        rating: input.rating,
        status: input.status,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const id = Number(result.insertId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.contractor_create',
      entityType: 'labour_contractor',
      entityId: id,
      after: { code: input.code, name: input.name, status: input.status, vendor_id: input.vendorId },
      ip: actor.ip,
    })

    return id
  })
}

/**
 * Editing the master.
 *
 * The code is editable, unlike an employee code, because a contractor code is
 * not printed on anything statutory and a typo in one is worth fixing. The
 * unique key is re-checked against other rows for that reason.
 */
export async function updateContractor(
  db: Db,
  actor: Actor,
  contractorId: number,
  input: ContractorInput
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('labour_contractors')
      .select(['id', 'code', 'name', 'status', 'licence_valid_until', 'wc_policy_valid_until'])
      .where('id', '=', contractorId)
      .executeTakeFirst()
    if (!before) throw new NotFoundError('That contractor does not exist.')

    const clash = await trx
      .selectFrom('labour_contractors')
      .select(['id', 'name'])
      .where('code', '=', input.code)
      .where('id', '!=', contractorId)
      .executeTakeFirst()
    if (clash) {
      throw new ConflictError(`Code ${input.code} already belongs to ${clash.name}.`)
    }

    await trx
      .updateTable('labour_contractors')
      .set({
        code: input.code,
        name: input.name,
        vendor_id: input.vendorId,
        contact_phone: input.contactPhone,
        pan: input.pan,
        gstin: input.gstin,
        trade_specialisation: input.tradeSpecialisation,
        licence_no: input.licenceNo,
        licence_valid_until: input.licenceValidUntil,
        esi_registered: flag(input.esiRegistered),
        pf_registered: flag(input.pfRegistered),
        wc_policy_no: input.wcPolicyNo,
        wc_policy_valid_until: input.wcPolicyValidUntil,
        rating: input.rating,
        status: input.status,
      })
      .where('id', '=', contractorId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.contractor_update',
      entityType: 'labour_contractor',
      entityId: contractorId,
      before: {
        code: before.code,
        name: before.name,
        status: before.status,
        licence_valid_until: before.licence_valid_until === null ? null : String(before.licence_valid_until),
        wc_policy_valid_until:
          before.wc_policy_valid_until === null ? null : String(before.wc_policy_valid_until),
      },
      after: {
        code: input.code,
        name: input.name,
        status: input.status,
        licence_valid_until: input.licenceValidUntil,
        wc_policy_valid_until: input.wcPolicyValidUntil,
      },
      ip: actor.ip,
    })
  })
}

export interface ContractorRateInput {
  projectId: number | null
  workType: string
  uom: RateUom
  skillLevel: SkillLevel | null
  rate: number
  effectiveFrom: string
  effectiveTo: string | null
}

/**
 * Adding a line to the rate card.
 *
 * A rate is superseded, not edited: the amount on a bill has to stay explicable
 * from the card as it stood on the day worked, so the previous open line for the
 * same scope is closed the day before the new one starts rather than overwritten.
 * "Same scope" is (project_id, work_type, uom, skill_level) -- a rate for one
 * project does not close the company-wide one, because `applicableRate` reads
 * the project-specific line in preference and both have to remain readable.
 *
 * An exact restatement (same scope, same effective_from) is a conflict rather
 * than a second line, because the two would be indistinguishable to the rate
 * lookup and it would pick one by id.
 */
export async function addContractorRate(
  db: Db,
  actor: Actor,
  contractorId: number,
  input: ContractorRateInput
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const contractor = await trx
      .selectFrom('labour_contractors')
      .select(['id', 'code', 'status'])
      .where('id', '=', contractorId)
      .executeTakeFirst()
    if (!contractor) throw new NotFoundError('That contractor does not exist.')

    if (input.projectId !== null) {
      const project = await trx
        .selectFrom('projects')
        .select(['id'])
        .where('id', '=', input.projectId)
        .executeTakeFirst()
      if (!project) throw new UnprocessableError('That project no longer exists.')
    }

    const existing = await trx
      .selectFrom('contractor_rates')
      .select(['id', 'effective_from', 'effective_to', 'rate_paise'])
      .where('contractor_id', '=', contractorId)
      .where('work_type', '=', input.workType)
      .where('uom', '=', input.uom)
      .where((eb) =>
        input.skillLevel === null
          ? eb('skill_level', 'is', null)
          : eb('skill_level', '=', input.skillLevel)
      )
      .where((eb) =>
        input.projectId === null ? eb('project_id', 'is', null) : eb('project_id', '=', input.projectId)
      )
      .forUpdate()
      .execute()

    const duplicate = existing.find((r) => String(r.effective_from) === input.effectiveFrom)
    if (duplicate) {
      throw new ConflictError(
        `A ${input.workType} rate for that scope already starts on ${input.effectiveFrom}. Edit the period rather than adding a second line for the same day.`
      )
    }

    // Close the open line this one supersedes. Only a line that starts earlier
    // is closed: a rate backdated behind an existing one is a correction to
    // history and closing the later line would silently delete the current rate.
    const superseded = existing
      .filter((r) => r.effective_to === null && String(r.effective_from) < input.effectiveFrom)
      .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0]
    if (superseded) {
      await trx
        .updateTable('contractor_rates')
        .set({ effective_to: addDays(input.effectiveFrom, -1) })
        .where('id', '=', Number(superseded.id))
        .execute()
    }

    const result = await trx
      .insertInto('contractor_rates')
      .values({
        contractor_id: contractorId,
        project_id: input.projectId,
        work_type: input.workType,
        uom: input.uom,
        skill_level: input.skillLevel,
        rate_paise: input.rate,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const id = Number(result.insertId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.contractor_rate_add',
      entityType: 'contractor_rate',
      entityId: id,
      after: {
        contractor_id: contractorId,
        project_id: input.projectId,
        work_type: input.workType,
        uom: input.uom,
        skill_level: input.skillLevel,
        rate_paise: input.rate,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo,
        superseded_rate_id: superseded ? Number(superseded.id) : null,
      },
      ip: actor.ip,
    })

    return id
  })
}

export interface ContractorAttendanceResult {
  inserted: number
  updated: number
  headcount: number
  grossPaise: number
  complianceOverride: string[]
  ambiguousRates: string[]
}

/**
 * The compliance gate of rule 3, as a list of reasons rather than a boolean.
 *
 * Read against the day worked, not against today. Rule 3 says the check is on a
 * date that "has passed", and for a licence that expired last week both
 * readings agree; they differ only when a day from BEFORE the expiry is entered
 * late, and refusing that would refuse to record labour that was on site while
 * the cover was live. Cost that happened is recorded. DECISIONS 18.4 carries
 * this reading and the fact that a NULL date does not block, because a column
 * that was never filled has not "passed".
 */
function complianceFailures(
  contractor: {
    status: 'active' | 'on_hold' | 'blacklisted'
    licence_no: string | null
    licence_valid_until: unknown
    wc_policy_no: string | null
    wc_policy_valid_until: unknown
  },
  onDate: string
): string[] {
  const reasons: string[] = []
  const licence = contractor.licence_valid_until === null ? null : String(contractor.licence_valid_until)
  const policy = contractor.wc_policy_valid_until === null ? null : String(contractor.wc_policy_valid_until)

  if (licence !== null && licence < onDate) {
    reasons.push(`the labour licence expired on ${licence}`)
  }
  if (policy !== null && policy < onDate) {
    reasons.push(`the workmen's compensation policy expired on ${policy}`)
  }
  if (contractor.status === 'on_hold') {
    reasons.push('the contractor is on hold')
  }
  return reasons
}

/**
 * A day's contractor headcount (6.6 rule 2, first half).
 *
 * Three things happen here that do not happen on the employee side.
 *
 * The rate is snapshotted. `contractor_attendance.rate_paise` is a column and
 * not a join, so the amount survives a later change to the rate card. The rate
 * is resolved for the day worked, which is why re-entering a day re-resolves it:
 * the answer only moves if the card for that day itself changed, and then it
 * should.
 *
 * The compliance gate refuses before anything is written, overridably. A
 * blacklisted contractor is the one refusal with no override, because the
 * permission that would override it is the same one that set the blacklist --
 * `hr.labour_contractor_manage` on both -- so an override there would make the
 * status mean nothing.
 *
 * Correcting a row clears its approval. An approved row is billable, and a
 * headcount that changed after someone approved it has not been approved at the
 * figure it now carries. A row already carried onto a bill cannot be corrected
 * at all: the bill is the record and a credit note is finance's, not HR's.
 */
export async function recordContractorAttendance(
  db: Db,
  actor: Actor,
  input: ContractorAttendanceInput,
  opts: { canManageContractors: boolean }
): Promise<ContractorAttendanceResult> {
  if (input.attendanceDate > today()) {
    throw new UnprocessableError('That date has not happened yet. Attendance is recorded for a day that has passed.')
  }

  return db.transaction().execute(async (trx) => {
    const contractor = await trx
      .selectFrom('labour_contractors')
      .select([
        'id',
        'code',
        'name',
        'status',
        'licence_no',
        'licence_valid_until',
        'wc_policy_no',
        'wc_policy_valid_until',
      ])
      .where('id', '=', input.contractorId)
      .executeTakeFirst()
    if (!contractor) throw new UnprocessableError('That contractor no longer exists.')

    if (contractor.status === 'blacklisted') {
      throw new UnprocessableError(
        `${contractor.name} is blacklisted, so no labour can be recorded against them. Change the status on the contractor record first -- there is no override for this one.`
      )
    }

    const project = await trx
      .selectFrom('projects')
      .select(['id', 'code'])
      .where('id', '=', input.projectId)
      .executeTakeFirst()
    if (!project) throw new UnprocessableError('That project no longer exists.')

    const failures = complianceFailures(contractor, input.attendanceDate)
    if (failures.length > 0) {
      if (!input.overrideCompliance) {
        throw new UnprocessableError(
          `${contractor.name} cannot be given labour on ${input.attendanceDate}: ${failures.join(' and ')}. Someone holding hr.labour_contractor_manage can override this, and the override is recorded.`
        )
      }
      if (!opts.canManageContractors) {
        throw new ForbiddenError(
          `Overriding a compliance failure needs hr.labour_contractor_manage. Unresolved: ${failures.join(' and ')}.`
        )
      }
    }

    const priorRows = await trx
      .selectFrom('contractor_attendance')
      .select(['id', 'skill_level', 'headcount', 'amount_paise', 'approved_at', 'bill_id'])
      .where('contractor_id', '=', input.contractorId)
      .where('project_id', '=', input.projectId)
      .where('attendance_date', '=', input.attendanceDate)
      .forUpdate()
      .execute()
    const priorBySkill = new Map(priorRows.map((r) => [String(r.skill_level), r]))

    let inserted = 0
    let updated = 0
    let headcount = 0
    let grossPaise = 0
    const ambiguousRates: string[] = []

    for (const row of input.rows) {
      const readable = row.skillLevel.replace(/_/g, ' ')
      const prior = priorBySkill.get(row.skillLevel)

      if (prior && prior.bill_id !== null) {
        // The bill number, not the id: whoever hits this has to go and find the
        // bill, and a bill is identified by `bill_no` everywhere a person looks
        // at one. One extra SELECT on a path that ends in a refusal anyway.
        const billed = await trx
          .selectFrom('contractor_bills')
          .select('bill_no')
          .where('id', '=', Number(prior.bill_id))
          .executeTakeFirst()
        throw new ConflictError(
          `The ${readable} row for ${input.attendanceDate} is already on bill ${billed?.bill_no ?? `#${Number(prior.bill_id)}`} and cannot be changed. Correcting a billed day is a finance adjustment.`
        )
      }

      const rate = await applicableRate(trx, {
        contractorId: input.contractorId,
        projectId: input.projectId,
        skillLevel: row.skillLevel,
        onDate: input.attendanceDate,
      })
      if (!rate) {
        throw new UnprocessableError(
          `${contractor.name} has no per-day ${readable} rate effective on ${input.attendanceDate}. Add it to the rate card before recording the day.`
        )
      }
      if (rate.ambiguous) ambiguousRates.push(`${readable}: rate ${rate.id} (${rate.workType})`)

      const amount = rate.ratePaise * row.headcount
      headcount += row.headcount
      grossPaise += amount

      if (prior) {
        await trx
          .updateTable('contractor_attendance')
          .set({
            headcount: row.headcount,
            overtime_hours: row.overtimeHours,
            rate_paise: rate.ratePaise,
            amount_paise: amount,
            recorded_by: actor.userId,
            approved_by: null,
            approved_at: null,
          })
          .where('id', '=', Number(prior.id))
          .execute()
        updated += 1
      } else {
        await trx
          .insertInto('contractor_attendance')
          .values({
            contractor_id: input.contractorId,
            project_id: input.projectId,
            attendance_date: input.attendanceDate,
            skill_level: row.skillLevel,
            headcount: row.headcount,
            overtime_hours: row.overtimeHours,
            rate_paise: rate.ratePaise,
            amount_paise: amount,
            recorded_by: actor.userId,
          })
          .execute()
        inserted += 1
      }
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.contractor_attendance_record',
      entityType: 'contractor_attendance',
      entityId: null,
      after: {
        contractor_id: input.contractorId,
        contractor_code: contractor.code,
        project_id: input.projectId,
        attendance_date: input.attendanceDate,
        inserted,
        updated,
        headcount,
        gross_paise: grossPaise,
        rows: input.rows.map((r) => `${r.skillLevel}:${r.headcount}`),
        // The override and the ambiguity are the two facts that cannot be
        // reconstructed from the rows afterwards, so they are recorded here.
        compliance_override: failures.length > 0 ? failures : undefined,
        ambiguous_rates: ambiguousRates.length > 0 ? ambiguousRates : undefined,
      },
      ip: actor.ip,
    })

    return {
      inserted,
      updated,
      headcount,
      grossPaise,
      complianceOverride: failures,
      ambiguousRates,
    }
  })
}

export interface ContractorPeriodInput {
  contractorId: number
  projectId: number
  from: string
  to: string
}

/**
 * Approving a period's contractor attendance.
 *
 * Not in the 6.6 route table, and that is a gap in the spec rather than a
 * design choice here: rule 2 bills only rows whose `approved_at` is set and no
 * route in the table can set it. The permission is `hr.attendance_approve`, the
 * one rule 4 already uses to close an employee month, because it is the same
 * act on the other population.
 *
 * There is deliberately no self-approval refusal, matching
 * `approveAttendanceMonth`. The money control on this chain is the bill
 * approval, which does refuse it.
 *
 * Rows already carried onto a bill are left alone. Their approval is what let
 * them be billed, and restamping it would move the date on which the figure
 * that is now on a bill was agreed.
 */
export async function approveContractorAttendance(
  db: Db,
  actor: Actor,
  input: ContractorPeriodInput
): Promise<{ approved: number; alreadyApproved: number; grossPaise: number }> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('contractor_attendance')
      .select(['id', 'approved_at', 'amount_paise', 'bill_id'])
      .where('contractor_id', '=', input.contractorId)
      .where('project_id', '=', input.projectId)
      .where('attendance_date', '>=', input.from)
      .where('attendance_date', '<=', input.to)
      .forUpdate()
      .execute()

    if (rows.length === 0) {
      throw new UnprocessableError(
        `No contractor attendance is recorded for that project between ${input.from} and ${input.to}, so there is nothing to approve.`
      )
    }

    const pending = rows.filter((r) => r.approved_at === null)
    if (pending.length === 0) {
      throw new ConflictError(
        `All ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} in that period are already approved.`
      )
    }

    const ids = pending.map((r) => Number(r.id))
    await trx
      .updateTable('contractor_attendance')
      .set({ approved_by: actor.userId, approved_at: nowSqlDateTime() })
      .where('id', 'in', ids)
      .execute()

    const grossPaise = pending.reduce((sum, r) => sum + Number(r.amount_paise), 0)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.contractor_attendance_approve',
      entityType: 'contractor_attendance',
      entityId: null,
      after: {
        contractor_id: input.contractorId,
        project_id: input.projectId,
        from: input.from,
        to: input.to,
        approved: ids.length,
        already_approved: rows.length - pending.length,
        gross_paise: grossPaise,
      },
      ip: actor.ip,
    })

    return { approved: ids.length, alreadyApproved: rows.length - pending.length, grossPaise }
  })
}

export interface ContractorBillGenerateInput {
  contractorId: number
  projectId: number
  from: string
  to: string
  retentionPct: number | null
  tdsPct: number | null
  advanceRecovered: number
  penalty: number
}

export interface ContractorBillResult {
  billId: number
  billNo: string
  rows: number
  days: number
  grossPaise: number
  retentionPaise: number
  tdsPaise: number
  netPayablePaise: number
  retentionBp: number
  tdsBp: number
  noPan: boolean
}

/**
 * Generating a bill (6.6 rule 2).
 *
 * Rule 2 is quoted in DECISIONS 18.5: the gross is summed from approved
 * attendance and is never typed. Everything typed on the form is a deduction
 * applied afterwards.
 *
 * Two refusals are worth the words:
 *
 * Unapproved rows inside the period stop the bill instead of being skipped. A
 * bill that silently omits four days keeps `bill_id` NULL on them, and nothing
 * would ever surface them again -- the next period's bill does not cover those
 * dates. The refusal names the count, and the fix is one click away on the same
 * screen.
 *
 * A negative net payable is refused rather than stored. `net_payable_paise` is
 * BIGINT and would hold it, but a bill that says the contractor owes us is a
 * debit note, and 6.8 has no reading for a negative expense.
 *
 * The percentages: `retention_paise` and `tds_paise` are stored, the rates that
 * produced them are not -- there is no column. They go in the audit entry, which
 * is the only record of how the figure was reached. Section 206AA's 20% for a
 * contractor with no PAN is NOT applied; `noPan` is returned so the screen can
 * warn, and DECISIONS records it as unimplemented rather than invented.
 */
export async function generateContractorBill(
  db: Db,
  actor: Actor,
  input: ContractorBillGenerateInput
): Promise<ContractorBillResult> {
  const defaultRetentionBp = Number(await getSetting(db, 'finance.retention_default_pct', 500))
  const defaultTdsBp = Number(await getSetting(db, 'finance.tds_default_pct', 200))

  return db.transaction().execute(async (trx) => {
    const contractor = await trx
      .selectFrom('labour_contractors')
      .select(['id', 'code', 'name', 'pan', 'status'])
      .where('id', '=', input.contractorId)
      .executeTakeFirst()
    if (!contractor) throw new UnprocessableError('That contractor no longer exists.')

    const project = await trx
      .selectFrom('projects')
      .select(['id', 'code'])
      .where('id', '=', input.projectId)
      .executeTakeFirst()
    if (!project) throw new UnprocessableError('That project no longer exists.')

    // FOR UPDATE, then re-check bill_id: two operators generating the same
    // period at once would otherwise both read the rows as unbilled and the
    // second bill would double-count them.
    const rows = await trx
      .selectFrom('contractor_attendance')
      .select(['id', 'attendance_date', 'skill_level', 'headcount', 'amount_paise', 'approved_at', 'bill_id'])
      .where('contractor_id', '=', input.contractorId)
      .where('project_id', '=', input.projectId)
      .where('attendance_date', '>=', input.from)
      .where('attendance_date', '<=', input.to)
      .forUpdate()
      .execute()

    const unbilled = rows.filter((r) => r.bill_id === null)
    const pending = unbilled.filter((r) => r.approved_at === null)
    if (pending.length > 0) {
      const earliest = pending
        .map((r) => String(r.attendance_date))
        .sort((a, b) => a.localeCompare(b))[0]
      throw new UnprocessableError(
        `${pending.length} ${pending.length === 1 ? 'row is' : 'rows are'} not approved yet, the earliest on ${earliest}. Rule 2 bills approved attendance only, and a bill that quietly left them out would never pick them up again. Approve or remove them first.`
      )
    }

    const billable = unbilled.filter((r) => r.approved_at !== null)
    if (billable.length === 0) {
      throw new UnprocessableError(
        `There is no approved unbilled attendance for ${contractor.name} on ${project.code} between ${input.from} and ${input.to}.`
      )
    }

    const grossPaise = billable.reduce((sum, r) => sum + Number(r.amount_paise), 0)
    const retentionBp = input.retentionPct ?? defaultRetentionBp
    const tdsBp = input.tdsPct ?? defaultTdsBp
    const retentionPaise = applyPct(grossPaise, retentionBp / 100)
    const tdsPaise = applyPct(grossPaise, tdsBp / 100)
    const netPayablePaise =
      grossPaise - input.advanceRecovered - retentionPaise - tdsPaise - input.penalty

    if (netPayablePaise < 0) {
      throw new UnprocessableError(
        `The deductions come to more than the bill: ${formatPaise(grossPaise)} gross against ${formatPaise(input.advanceRecovered + retentionPaise + tdsPaise + input.penalty)} of advance, retention, TDS and penalty. A bill cannot be negative -- recover the balance on the next one.`
      )
    }

    // The financial year comes from the first day of the period, not from today,
    // so a March bill raised in April keeps its own year's series. Same rule as
    // the leave year.
    const billNo = await nextNumber(trx, 'contractor_bill', input.from)

    const result = await trx
      .insertInto('contractor_bills')
      .values({
        bill_no: billNo,
        contractor_id: input.contractorId,
        project_id: input.projectId,
        period_from: input.from,
        period_to: input.to,
        gross_paise: grossPaise,
        advance_recovered_paise: input.advanceRecovered,
        retention_paise: retentionPaise,
        tds_paise: tdsPaise,
        penalty_paise: input.penalty,
        net_payable_paise: netPayablePaise,
        status: 'draft',
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const billId = Number(result.insertId)

    const ids = billable.map((r) => Number(r.id))
    const stamped = await trx
      .updateTable('contractor_attendance')
      .set({ bill_id: billId })
      .where('id', 'in', ids)
      .where('bill_id', 'is', null)
      .executeTakeFirst()

    if (Number(stamped.numUpdatedRows) !== ids.length) {
      throw new ConflictError(
        'Some of those attendance rows were billed while this bill was being generated. Nothing has been saved -- reload and try again.'
      )
    }

    const days = new Set(billable.map((r) => String(r.attendance_date))).size

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.contractor_bill_generate',
      entityType: 'contractor_bill',
      entityId: billId,
      after: {
        bill_no: billNo,
        contractor_id: input.contractorId,
        contractor_code: contractor.code,
        project_id: input.projectId,
        period_from: input.from,
        period_to: input.to,
        attendance_rows: ids.length,
        days,
        gross_paise: grossPaise,
        advance_recovered_paise: input.advanceRecovered,
        retention_paise: retentionPaise,
        tds_paise: tdsPaise,
        penalty_paise: input.penalty,
        net_payable_paise: netPayablePaise,
        // The only record of the rates: the table stores the resulting paise
        // and has no column for the percentage.
        retention_bp: retentionBp,
        retention_source: input.retentionPct === null ? 'settings' : 'entered',
        tds_bp: tdsBp,
        tds_source: input.tdsPct === null ? 'settings' : 'entered',
        contractor_has_pan: contractor.pan !== null,
        status: 'draft',
      },
      ip: actor.ip,
    })

    return {
      billId,
      billNo,
      rows: ids.length,
      days,
      grossPaise,
      retentionPaise,
      tdsPaise,
      netPayablePaise,
      retentionBp,
      tdsBp,
      noPan: contractor.pan === null,
    }
  })
}

export interface ContractorBillApprovalResult {
  billNo: string
  grossPaise: number
  netPayablePaise: number
  limitRoleKey: string
}

/**
 * Approving a bill (6.6 route table, "+ limit").
 *
 * This is the last step HR takes. 6.8 rule 1 says approving the bill creates the
 * `expenses` row; that posting is 6.8's and is deliberately not written here.
 * What this function guarantees is that the row it leaves behind carries the
 * identity finance will key on:
 *
 *     expenses.source_type = 'contractor_bill'
 *     expenses.source_table = 'contractor_bills'
 *     expenses.source_id    = contractor_bills.id
 *     contractor_bills.expense_id -> expenses.id   (FK added in 009)
 *
 * `contractor_bills.id` is that identity. It is immutable, it is what the FK
 * from `expenses` points back at, and `bill_no` (UNIQUE, from `nextNumber`) is
 * the human-facing form of it. DECISIONS 18.8 records that 6.8 rule 1 describes
 * `(source_table, source_id)` as a UNIQUE index while 009 declares it as a plain
 * KEY, so today the database would not in fact refuse a double posting.
 *
 * The limit is resolved against document_type 'expense'. `approval_limits`
 * (002_rbac.sql) has a four-member ENUM with no `contractor_bill`, so the
 * alternative was a migration inventing one; the bill becomes an expense and
 * that is the ceiling it should be measured against. The figure checked is the
 * GROSS, not the net payable: the gross is the cost committed to the project,
 * while the net is what leaves the bank and belongs to `payment_release`.
 */
export async function approveContractorBill(
  db: Db,
  actor: Actor,
  billId: number,
  roleKeys: readonly string[]
): Promise<ContractorBillApprovalResult> {
  return db.transaction().execute(async (trx) => {
    const bill = await trx
      .selectFrom('contractor_bills')
      .select([
        'id', 'bill_no', 'status', 'gross_paise', 'net_payable_paise',
        'created_by', 'approved_by', 'contractor_id', 'project_id',
      ])
      .where('id', '=', billId)
      .forUpdate()
      .executeTakeFirst()
    if (!bill) throw new NotFoundError('That contractor bill does not exist.')

    // Only `draft` is reachable today -- `generateContractorBill` writes it and
    // nothing writes `submitted` or `verified`. They are accepted because they
    // are upstream of approval in the ENUM's order and a later slice that adds a
    // verification step should not have to change this check.
    if (bill.status !== 'draft' && bill.status !== 'submitted' && bill.status !== 'verified') {
      throw new ConflictError(
        `Bill ${bill.bill_no} is ${bill.status}. Only a bill that has not been approved yet can be approved.`
      )
    }
    if (Number(bill.created_by) === actor.userId) {
      throw new UnprocessableError(
        `You generated bill ${bill.bill_no}, so you cannot approve it. Someone else holding the approval permission has to.`
      )
    }

    const gross = Number(bill.gross_paise)
    const limit = await resolveApprovalLimit(trx, roleKeys, 'expense', today())
    if (limit === null) {
      throw new UnprocessableError(
        'No expense approval limit is set for your role, so no amount can be approved yet. An administrator sets these under Roles and approval limits.'
      )
    }
    if (gross > limit.maxValue) {
      throw new UnprocessableError(
        `${formatPaise(gross)} is above your approval limit of ${formatPaise(limit.maxValue)}. This needs someone with a higher limit.`
      )
    }
    if (limit.requiresSecondApprovalAbove !== null && gross > limit.requiresSecondApprovalAbove) {
      // `contractor_bills` has one `approved_by` column and no
      // `second_approved_by`, unlike `purchase_orders`. A single signature
      // written as `approved` where two are required is the failure the second
      // signature exists to prevent, so this refuses rather than approving.
      // Flagged in DECISIONS 18.9 as a schema gap; unreachable until 8.2 fills
      // `approval_limits`.
      throw new UnprocessableError(
        `${formatPaise(gross)} is above the ${formatPaise(limit.requiresSecondApprovalAbove)} single-approval threshold for your role, and contractor_bills has no column for a second approval. This bill cannot be approved until that is added.`
      )
    }

    await trx
      .updateTable('contractor_bills')
      .set({ status: 'approved', approved_by: actor.userId, approved_at: nowSqlDateTime() })
      .where('id', '=', billId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'hr.contractor_bill_approve',
      entityType: 'contractor_bill',
      entityId: billId,
      before: { status: bill.status, approved_by: null },
      after: {
        status: 'approved',
        approved_by: actor.userId,
        bill_no: bill.bill_no,
        gross_paise: gross,
        net_payable_paise: Number(bill.net_payable_paise),
        limit_role_key: limit.roleKey,
        limit_document_type: 'expense',
        // The identity 6.8 will post against. Nothing is written to `expenses`
        // in this slice; `expense_id` stays NULL until 6.8 lands.
        finance_source_type: 'contractor_bill',
        finance_source_table: 'contractor_bills',
        finance_source_id: billId,
        expense_id: null,
      },
      ip: actor.ip,
    })

    return {
      billNo: bill.bill_no,
      grossPaise: gross,
      netPayablePaise: Number(bill.net_payable_paise),
      limitRoleKey: limit.roleKey,
    }
  })
}





