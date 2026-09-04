import { randomUUID } from 'node:crypto'
import type { Db, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { sequenceCode } from '../../lib/numbering.js'
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { addDays, nowSqlDateTime } from '../../lib/dates.js'
import { blockerCount, employeeLoginId, exitBlockers, type ExitBlockers } from './queries.js'

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
