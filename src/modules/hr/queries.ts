import type { Db, Queryable } from '../../db/kysely.js'
import { monthBounds } from '../../lib/dates.js'

/**
 * HR reads (spec 6.6).
 *
 * The load-bearing rule here is 6.6 rule 5: pay is a separate table and a
 * separate permission, and `hr.employee_view` renders a profile with no pay
 * figures at all *because the query does not select from that table*. There is
 * no `canViewPay` flag threaded through a join and no filtering of a result set
 * after the fact -- `findEmployee` cannot return a salary, and
 * `compensationHistory` is called only from the route fragment behind
 * `hr.payroll_view`. That is what lets ops_manager see the team without seeing
 * what the team is paid.
 *
 * The same separation is why `aadhaar_last4` is selected only by the detail
 * read and never by the list: a list page is the thing that gets left open on
 * a shared site laptop.
 */

export interface EmployeeListRow {
  id: number
  employee_code: string
  full_name: string
  status: string
  employment_type: string
  date_of_joining: string
  personal_phone: string | null
  department_name: string | null
  designation_name: string | null
}

export async function listEmployees(
  db: Db,
  opts: { status?: string; departmentId?: number; q?: string } = {}
): Promise<EmployeeListRow[]> {
  let query = db
    .selectFrom('employees')
    .leftJoin('departments', 'departments.id', 'employees.department_id')
    .leftJoin('designations', 'designations.id', 'employees.designation_id')
    .select([
      'employees.id',
      'employees.employee_code',
      'employees.full_name',
      'employees.status',
      'employees.employment_type',
      'employees.date_of_joining',
      'employees.personal_phone',
      'departments.name as department_name',
      'designations.name as designation_name',
    ])
    .orderBy('employees.employee_code')

  if (opts.status) query = query.where('employees.status', '=', opts.status as 'active')
  if (opts.departmentId) query = query.where('employees.department_id', '=', opts.departmentId)
  if (opts.q) query = query.where('employees.full_name', 'like', `%${opts.q}%`)

  return (await query.execute()) as unknown as EmployeeListRow[]
}

export async function findEmployee(db: Queryable, id: number) {
  return db
    .selectFrom('employees')
    .leftJoin('departments', 'departments.id', 'employees.department_id')
    .leftJoin('designations', 'designations.id', 'employees.designation_id')
    .leftJoin('locations', 'locations.id', 'employees.base_location_id')
    .leftJoin('employees as boss', 'boss.id', 'employees.reporting_to_employee_id')
    // Either direction of the login link (see employeeLoginId). Two matching
    // rows would need two different accounts claiming the same employee, and
    // executeTakeFirst returns one row regardless, so the widened predicate
    // cannot break the page -- whereas the narrow one showed "no login" for
    // every account 6.1 created.
    .leftJoin('users', (join) =>
      join.on((eb) =>
        eb.or([
          eb('users.id', '=', eb.ref('employees.user_id')),
          eb('users.employee_id', '=', eb.ref('employees.id')),
        ])
      )
    )
    .select([
      'employees.id',
      'employees.employee_code',
      'employees.user_id',
      'employees.full_name',
      'employees.father_or_spouse_name',
      'employees.date_of_birth',
      'employees.gender',
      'employees.blood_group',
      'employees.personal_phone',
      'employees.personal_email',
      'employees.emergency_contact_name',
      'employees.emergency_contact_phone',
      'employees.permanent_address',
      'employees.current_address',
      'employees.department_id',
      'employees.designation_id',
      'employees.reporting_to_employee_id',
      'employees.employment_type',
      'employees.date_of_joining',
      'employees.probation_until',
      'employees.date_of_exit',
      'employees.exit_type',
      'employees.exit_reason',
      'employees.base_location_id',
      'employees.pan',
      'employees.aadhaar_last4',
      'employees.uan',
      'employees.pf_number',
      'employees.esi_number',
      'employees.bank_account_name',
      'employees.bank_account_no',
      'employees.bank_ifsc',
      'employees.status',
      'departments.name as department_name',
      'designations.name as designation_name',
      'locations.name as base_location_name',
      'boss.full_name as reports_to_name',
      'users.email as login_email',
      'users.status as login_status',
    ])
    .where('employees.id', '=', id)
    .executeTakeFirst()
}

/**
 * Pay history. Called only from the fragment behind hr.payroll_view.
 *
 * Ordered newest first because the question being asked of this screen is
 * almost always "what is he on now", and the row that answers it is the one
 * with effective_to NULL.
 */
export async function compensationHistory(db: Queryable, employeeId: number) {
  return db
    .selectFrom('employee_compensation')
    .leftJoin('users as approver', 'approver.id', 'employee_compensation.approved_by')
    .select([
      'employee_compensation.id',
      'employee_compensation.effective_from',
      'employee_compensation.effective_to',
      'employee_compensation.ctc_annual_paise',
      'employee_compensation.basic_paise',
      'employee_compensation.hra_paise',
      'employee_compensation.conveyance_paise',
      'employee_compensation.special_allowance_paise',
      'employee_compensation.site_allowance_paise',
      'employee_compensation.employer_pf_paise',
      'employee_compensation.employer_esi_paise',
      'employee_compensation.revision_reason',
      'approver.full_name as approved_by_name',
    ])
    .where('employee_compensation.employee_id', '=', employeeId)
    .orderBy('employee_compensation.effective_from', 'desc')
    .execute()
}

export async function employeeDocuments(db: Queryable, employeeId: number) {
  return db
    .selectFrom('employee_documents')
    .leftJoin('files', 'files.id', 'employee_documents.file_id')
    .leftJoin('users as verifier', 'verifier.id', 'employee_documents.verified_by')
    .select([
      'employee_documents.id',
      'employee_documents.doc_type',
      'employee_documents.document_no',
      'employee_documents.issued_on',
      'employee_documents.expires_on',
      'employee_documents.file_id',
      'employee_documents.verified_on',
      'files.original_name as file_name',
      'verifier.full_name as verified_by_name',
    ])
    .where('employee_documents.employee_id', '=', employeeId)
    .orderBy('employee_documents.doc_type')
    .execute()
}

/* Options for the form selects ------------------------------------------- */

export async function departmentOptions(db: Queryable) {
  return db
    .selectFrom('departments')
    .select(['id', 'code', 'name'])
    .where('is_active', '=', 1)
    .orderBy('name')
    .execute()
}

export async function designationOptions(db: Queryable) {
  return db
    .selectFrom('designations')
    .select(['id', 'code', 'name', 'department_id'])
    .where('is_active', '=', 1)
    .orderBy('name')
    .execute()
}

export async function locationOptions(db: Queryable) {
  return db.selectFrom('locations').select(['id', 'name']).orderBy('name').execute()
}

/** Anyone still on the books can be a reporting manager; an exited person cannot. */
export async function managerOptions(db: Queryable, excludeId?: number) {
  let query = db
    .selectFrom('employees')
    .select(['id', 'employee_code', 'full_name'])
    .where('status', '!=', 'exited')
    .orderBy('full_name')
  if (excludeId) query = query.where('id', '!=', excludeId)
  return query.execute()
}

/* The exit checklist (6.6 rule 7) ---------------------------------------- */

/**
 * The login attached to an employee, whichever direction the link was made in.
 *
 * The schema carries both halves: `employees.user_id` (006) and
 * `users.employee_id` (001). 6.1's `createUser` writes the second one and
 * nothing in the codebase writes the first, so a reader that consults only
 * `employees.user_id` finds no login for any account created through the admin
 * screen -- which is all of them. That is not a cosmetic gap: it is the
 * difference between `runExit` revoking a departing employee's sessions and
 * silently revoking nothing, and between the exit checklist listing their open
 * project assignments and reporting a clean clearance.
 *
 * Resolved by reading rather than by adding a writer, because which of the two
 * columns is canonical is a schema question the spec does not settle. Flagged
 * in DECISIONS.md.
 */
export async function employeeLoginId(
  db: Queryable,
  employeeId: number,
  userId: number | null | undefined
): Promise<number | null> {
  if (userId) return Number(userId)
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('employee_id', '=', employeeId)
    .executeTakeFirst()
  return row ? Number(row.id) : null
}

export interface ExitBlockers {
  assignments: { project_code: string; project_name: string; assignment_role: string }[]
  materialIssues: { issue_no: string; issued_on: string; project_code: string }[]
  equipment: { code: string; name: string; project_code: string | null }[]
  expensesRaised: { expense_no: string; status: string; total_paise: number }[]
  advancesOutstanding: { expense_no: string; status: string; net_payable_paise: number; paid_paise: number }[]
}

/**
 * What is still in this person's hands.
 *
 * Two of these five join on a name rather than an id, because that is how the
 * schema records them: `material_issues.received_by_name` and
 * `equipment_deployments.operator_name` are free text written at a site gate,
 * not foreign keys. So the match is by exact full name and it is *advisory* --
 * a store issue recorded as "Ramesh" against an employee named "Ramesh Kumar"
 * will not appear here. The checklist is a prompt for the person running the
 * exit, not a proof of clearance, and 6.6 rule 7 lets them override with a
 * reason for exactly this reason. Flagged in DECISIONS.md rather than solved by
 * inventing a foreign key the spec does not have.
 *
 * `advancesOutstanding` is the prose case in rule 7 -- "three open advances" --
 * which is an expense with the employee as *payee*, not one they raised. The
 * enumerated list in the spec says "unapproved expenses they raised"; both are
 * returned because both are money that follows the person out of the door.
 */
export async function exitBlockers(db: Queryable, employeeId: number): Promise<ExitBlockers> {
  const employee = await db
    .selectFrom('employees')
    .select(['id', 'user_id', 'full_name'])
    .where('id', '=', employeeId)
    .executeTakeFirst()
  if (!employee) {
    return { assignments: [], materialIssues: [], equipment: [], expensesRaised: [], advancesOutstanding: [] }
  }

  const userId = await employeeLoginId(db, employeeId, employee.user_id)
  const name = employee.full_name

  const assignments = userId
    ? await db
        .selectFrom('project_assignments')
        .innerJoin('projects', 'projects.id', 'project_assignments.project_id')
        .select([
          'projects.code as project_code',
          'projects.name as project_name',
          'project_assignments.assignment_role',
        ])
        .where('project_assignments.user_id', '=', userId)
        .where('project_assignments.to_date', 'is', null)
        .orderBy('projects.code')
        .execute()
    : []

  const materialIssues = await db
    .selectFrom('material_issues')
    .innerJoin('projects', 'projects.id', 'material_issues.project_id')
    .select(['material_issues.issue_no', 'material_issues.issued_on', 'projects.code as project_code'])
    .where('material_issues.received_by_name', '=', name)
    .where('material_issues.status', '=', 'posted')
    .orderBy('material_issues.issued_on', 'desc')
    .execute()

  const equipment = await db
    .selectFrom('equipment_deployments')
    .innerJoin('equipment', 'equipment.id', 'equipment_deployments.equipment_id')
    .leftJoin('projects', 'projects.id', 'equipment_deployments.project_id')
    .select(['equipment.code', 'equipment.name', 'projects.code as project_code'])
    .where('equipment_deployments.operator_name', '=', name)
    .where('equipment_deployments.to_date', 'is', null)
    .orderBy('equipment.code')
    .execute()

  const expensesRaised = userId
    ? await db
        .selectFrom('expenses')
        .select(['expense_no', 'status', 'total_paise'])
        .where('created_by', '=', userId)
        .where('status', 'in', ['draft', 'pending_approval'])
        .orderBy('expense_no')
        .execute()
    : []

  const advancesOutstanding = await db
    .selectFrom('expenses')
    .select(['expense_no', 'status', 'net_payable_paise', 'paid_paise'])
    .where('employee_id', '=', employeeId)
    .where('payee_type', '=', 'employee')
    .where('status', 'in', ['draft', 'pending_approval', 'approved', 'part_paid'])
    .orderBy('expense_no')
    .execute()

  return {
    assignments: assignments as ExitBlockers['assignments'],
    materialIssues: materialIssues as unknown as ExitBlockers['materialIssues'],
    equipment: equipment as ExitBlockers['equipment'],
    expensesRaised: expensesRaised as ExitBlockers['expensesRaised'],
    advancesOutstanding: advancesOutstanding as ExitBlockers['advancesOutstanding'],
  }
}

export function blockerCount(b: ExitBlockers): number {
  return (
    b.assignments.length +
    b.materialIssues.length +
    b.equipment.length +
    b.expensesRaised.length +
    b.advancesOutstanding.length
  )
}

/* Attendance (6.6 rules 1 and 4) ----------------------------------------- */

/**
 * The people a month's grid has a row for.
 *
 * Not "active employees": someone who joined on the 20th or left on the 8th
 * belongs in that month's muster roll for the part of it they were employed,
 * and a roster that dropped them would lose their days from 6.8's staff cost.
 * The join and exit dates come back with the row so the grid can grey out the
 * cells outside them.
 */
export interface RosterRow {
  id: number
  employee_code: string
  full_name: string
  father_or_spouse_name: string | null
  gender: string | null
  date_of_joining: string
  date_of_exit: string | null
  status: string
  department_name: string | null
  designation_name: string | null
}

export async function attendanceRoster(
  db: Queryable,
  month: string,
  opts: { employeeId?: number } = {}
): Promise<RosterRow[]> {
  const { start, end } = monthBounds(month)
  let query = db
    .selectFrom('employees')
    .leftJoin('departments', 'departments.id', 'employees.department_id')
    .leftJoin('designations', 'designations.id', 'employees.designation_id')
    .select([
      'employees.id',
      'employees.employee_code',
      'employees.full_name',
      // Carried for the muster roll, which is a statutory form: Form XVI wants
      // the father's or husband's name, the sex and the designation beside the
      // daily marks. The month grid ignores these columns.
      'employees.father_or_spouse_name',
      'employees.gender',
      'employees.date_of_joining',
      'employees.date_of_exit',
      'employees.status',
      'departments.name as department_name',
      'designations.name as designation_name',
    ])
    .where('employees.date_of_joining', '<=', end)
    .where((eb) =>
      eb.or([eb('employees.date_of_exit', 'is', null), eb('employees.date_of_exit', '>=', start)])
    )
    .orderBy('employees.employee_code')
  if (opts.employeeId) query = query.where('employees.id', '=', opts.employeeId)
  return (await query.execute()) as unknown as RosterRow[]
}

export interface AttendanceCell {
  id: number
  employee_id: number
  attendance_date: string
  project_id: number | null
  status: string
  in_time: string | null
  out_time: string | null
  overtime_hours: number
  approved_at: string | null
  remarks: string | null
  project_code: string | null
}

export async function attendanceMonth(
  db: Queryable,
  month: string,
  opts: { employeeId?: number; projectId?: number } = {}
): Promise<AttendanceCell[]> {
  const { start, end } = monthBounds(month)
  let query = db
    .selectFrom('attendance')
    .leftJoin('projects', 'projects.id', 'attendance.project_id')
    .select([
      'attendance.id',
      'attendance.employee_id',
      'attendance.attendance_date',
      'attendance.project_id',
      'attendance.status',
      'attendance.in_time',
      'attendance.out_time',
      'attendance.overtime_hours',
      'attendance.approved_at',
      'attendance.remarks',
      'projects.code as project_code',
    ])
    .where('attendance.attendance_date', '>=', start)
    .where('attendance.attendance_date', '<=', end)
    .orderBy('attendance.attendance_date')
  if (opts.employeeId) query = query.where('attendance.employee_id', '=', opts.employeeId)
  if (opts.projectId) query = query.where('attendance.project_id', '=', opts.projectId)
  return (await query.execute()) as unknown as AttendanceCell[]
}

/**
 * One day's rows, for the entry grid's prefill.
 *
 * Deliberately not filtered by project, unlike the month grid: the entry grid
 * prefills from this, and a day charged to another project showing as unmarked
 * would invite a supervisor to enter it twice and move the cost.
 */
export async function attendanceOn(db: Queryable, date: string): Promise<AttendanceCell[]> {
  return (await db
    .selectFrom('attendance')
    .leftJoin('projects', 'projects.id', 'attendance.project_id')
    .select([
      'attendance.id',
      'attendance.employee_id',
      'attendance.attendance_date',
      'attendance.project_id',
      'attendance.status',
      'attendance.in_time',
      'attendance.out_time',
      'attendance.overtime_hours',
      'attendance.approved_at',
      'attendance.remarks',
      'projects.code as project_code',
    ])
    .where('attendance.attendance_date', '=', date)
    .execute()) as unknown as AttendanceCell[]
}

/**
 * Whether a month is closed, and how far the entry has got.
 *
 * The lock is DERIVED, not stored. There is no `attendance_periods` table and
 * `accounting_periods` belongs to finance -- whose `finance.period_close` is
 * the override in rule 4, so reusing it as the lock would make the override its
 * own key. So a month is closed once any row in it carries `approved_at`, which
 * is what `POST /api/hr/attendance/approve` stamps. Recorded in DECISIONS.
 */
export interface MonthState {
  month: string
  total: number
  approved: number
  locked: boolean
}

export async function attendanceMonthState(db: Queryable, month: string): Promise<MonthState> {
  const { start, end } = monthBounds(month)
  const row = await db
    .selectFrom('attendance')
    .select((eb) => [
      eb.fn.countAll<number>().as('total'),
      eb.fn.count<number>('attendance.approved_at').as('approved'),
    ])
    .where('attendance.attendance_date', '>=', start)
    .where('attendance.attendance_date', '<=', end)
    .executeTakeFirst()
  const total = Number(row?.total ?? 0)
  const approved = Number(row?.approved ?? 0)
  return { month, total, approved, locked: approved > 0 }
}

/** Projects a day's attendance can be charged to. NULL is overhead (rule 1). */
export async function projectOptions(db: Queryable) {
  return db
    .selectFrom('projects')
    .select(['id', 'code', 'name'])
    .where('status', 'in', ['mobilising', 'in_progress', 'on_hold', 'snagging'])
    .orderBy('code')
    .execute()
}

/* Leave ------------------------------------------------------------------- */

export async function leaveTypeOptions(db: Queryable) {
  return db
    .selectFrom('leave_types')
    .select([
      'id',
      'code',
      'name',
      'annual_quota',
      'is_paid',
      'requires_document',
      'min_notice_days',
    ])
    .where('is_active', '=', 1)
    .orderBy('code')
    .execute()
}

/**
 * Approved leave covering one date, by employee.
 *
 * The entry grid uses it to render "on EL (request 4)" instead of a status
 * select. `recordAttendanceBulk` refuses that row anyway, but a supervisor who
 * sees the reason before submitting does not have to work out which of ten
 * people the 422 was about.
 */
export interface ApprovedLeaveDay {
  employee_id: number
  request_id: number
  type_code: string
  days: number
}

export async function approvedLeaveOn(db: Queryable, date: string): Promise<ApprovedLeaveDay[]> {
  const rows = await db
    .selectFrom('leave_requests')
    .innerJoin('leave_types', 'leave_types.id', 'leave_requests.leave_type_id')
    .select([
      'leave_requests.employee_id',
      'leave_requests.id as request_id',
      'leave_types.code as type_code',
      'leave_requests.days',
    ])
    .where('leave_requests.status', '=', 'approved')
    .where('leave_requests.from_date', '<=', date)
    .where('leave_requests.to_date', '>=', date)
    .execute()
  return rows.map((r) => ({
    employee_id: Number(r.employee_id),
    request_id: Number(r.request_id),
    type_code: r.type_code,
    days: Number(r.days),
  }))
}

export interface LeaveRequestRow {
  id: number
  employee_id: number
  employee_code: string
  employee_name: string
  leave_type_id: number
  type_code: string
  type_name: string
  is_paid: number
  requires_document: number
  from_date: string
  to_date: string
  days: number
  reason: string | null
  status: string
  approved_at: string | null
  reject_reason: string | null
  file_id: number | null
  handover_name: string | null
  decided_by_name: string | null
}

/**
 * The leave list.
 *
 * `employeeId` is how "own" is enforced (spec 6.6 route table): the route passes
 * it for a requester who does not hold `hr.leave_approve`, and omits it for one
 * who does. The filter is in the query rather than applied to the result, so
 * there is no shape of this function that reads out another employee's leave for
 * a caller who should not see it.
 */
export async function listLeaveRequests(
  db: Queryable,
  opts: { employeeId?: number; status?: string; pendingFor?: number } = {}
): Promise<LeaveRequestRow[]> {
  let query = db
    .selectFrom('leave_requests')
    .innerJoin('employees', 'employees.id', 'leave_requests.employee_id')
    .innerJoin('leave_types', 'leave_types.id', 'leave_requests.leave_type_id')
    .leftJoin('employees as handover', 'handover.id', 'leave_requests.handover_to_employee_id')
    .leftJoin('users as decider', 'decider.id', 'leave_requests.approved_by')
    .select([
      'leave_requests.id',
      'leave_requests.employee_id',
      'employees.employee_code',
      'employees.full_name as employee_name',
      'leave_requests.leave_type_id',
      'leave_types.code as type_code',
      'leave_types.name as type_name',
      'leave_types.is_paid',
      'leave_types.requires_document',
      'leave_requests.from_date',
      'leave_requests.to_date',
      'leave_requests.days',
      'leave_requests.reason',
      'leave_requests.status',
      'leave_requests.approved_at',
      'leave_requests.reject_reason',
      'leave_requests.file_id',
      'handover.full_name as handover_name',
      'decider.full_name as decided_by_name',
    ])
    .orderBy('leave_requests.from_date', 'desc')
    .orderBy('leave_requests.id', 'desc')

  if (opts.employeeId) query = query.where('leave_requests.employee_id', '=', opts.employeeId)
  if (opts.status) query = query.where('leave_requests.status', '=', opts.status as 'pending')
  // The approver's queue. Excluded by employee rather than by user because the
  // request is filed against an employee record, which is the same reason the
  // dashboard widget filters it that way.
  if (opts.pendingFor) query = query.where('leave_requests.employee_id', '!=', opts.pendingFor)

  return (await query.execute()) as unknown as LeaveRequestRow[]
}

export async function findLeaveRequest(db: Queryable, id: number) {
  return db
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
      'leave_requests.file_id',
      'leave_types.code as type_code',
      'leave_types.name as type_name',
      'leave_types.is_paid',
      'leave_types.requires_document',
      'employees.employee_code',
      'employees.full_name as employee_name',
    ])
    .where('leave_requests.id', '=', id)
    .executeTakeFirst()
}

export interface LeaveBalanceRow {
  leave_type_id: number
  type_code: string
  type_name: string
  annual_quota: number | null
  opening: number
  accrued: number
  availed: number
  encashed: number
  balance: number
}

/**
 * Balances for one employee in one financial year.
 *
 * Left joined from `leave_types`, so a type the employee has never taken shows
 * as zeroes rather than as a missing row -- `leave_balances` rows are created on
 * first use, and a screen that only listed existing rows would show a new
 * joiner an empty table.
 */
export async function leaveBalances(
  db: Queryable,
  employeeId: number,
  financialYear: string
): Promise<LeaveBalanceRow[]> {
  const rows = await db
    .selectFrom('leave_types')
    .leftJoin('leave_balances', (join) =>
      join
        .onRef('leave_balances.leave_type_id', '=', 'leave_types.id')
        .on('leave_balances.employee_id', '=', employeeId)
        .on('leave_balances.financial_year', '=', financialYear)
    )
    .select([
      'leave_types.id as leave_type_id',
      'leave_types.code as type_code',
      'leave_types.name as type_name',
      'leave_types.annual_quota',
      'leave_balances.opening',
      'leave_balances.accrued',
      'leave_balances.availed',
      'leave_balances.encashed',
      'leave_balances.balance',
    ])
    .where('leave_types.is_active', '=', 1)
    .orderBy('leave_types.code')
    .execute()

  return rows.map((r) => ({
    leave_type_id: Number(r.leave_type_id),
    type_code: r.type_code,
    type_name: r.type_name,
    annual_quota: r.annual_quota === null ? null : Number(r.annual_quota),
    opening: Number(r.opening ?? 0),
    accrued: Number(r.accrued ?? 0),
    availed: Number(r.availed ?? 0),
    encashed: Number(r.encashed ?? 0),
    balance: Number(r.balance ?? 0),
  }))
}

/* The module dashboard --------------------------------------------------- */

export async function hrDashboard(db: Db) {
  const headcount = await db
    .selectFrom('employees')
    .select((eb) => [eb.fn.countAll<number>().as('n'), 'status'])
    .groupBy('status')
    .execute()

  const unapprovedAttendance = await db
    .selectFrom('attendance')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('approved_at', 'is', null)
    .executeTakeFirst()

  const expiringDocuments = await db
    .selectFrom('employee_documents')
    .innerJoin('employees', 'employees.id', 'employee_documents.employee_id')
    .select([
      'employees.employee_code',
      'employees.full_name',
      'employee_documents.doc_type',
      'employee_documents.expires_on',
    ])
    .where('employee_documents.expires_on', 'is not', null)
    .where('employees.status', '!=', 'exited')
    .orderBy('employee_documents.expires_on')
    .limit(20)
    .execute()

  const openPositions = await db
    .selectFrom('job_openings')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('status', '=', 'open')
    .executeTakeFirst()

  return {
    headcount: headcount as unknown as { n: number; status: string }[],
    unapprovedAttendance: Number(unapprovedAttendance?.n ?? 0),
    expiringDocuments: expiringDocuments as unknown as {
      employee_code: string
      full_name: string
      doc_type: string
      expires_on: string
    }[],
    openPositions: Number(openPositions?.n ?? 0),
  }
}

/* Contractor labour (spec 6.6 rules 2 and 3) ------------------------------ */

/**
 * The second population of 6.6.
 *
 * Nothing below joins `employees`. A contractor's workers are a headcount per
 * skill per day and the company holds no identity for them, which is why
 * `contractor_attendance` has a `headcount` where `attendance` has an
 * `employee_id`. Keeping the two apart in the reads as well as in the tables is
 * what stops a headcount from ever being counted as a person on the muster roll.
 */

export interface ContractorListRow {
  id: number
  code: string
  name: string
  status: string
  trade_specialisation: string | null
  contact_phone: string | null
  licence_valid_until: string | null
  wc_policy_valid_until: string | null
  esi_registered: number
  pf_registered: number
  rating: number | null
  vendor_name: string | null
}

export async function listContractors(
  db: Queryable,
  opts: { status?: string; search?: string } = {}
): Promise<ContractorListRow[]> {
  let query = db
    .selectFrom('labour_contractors')
    .leftJoin('vendors', 'vendors.id', 'labour_contractors.vendor_id')
    .select([
      'labour_contractors.id',
      'labour_contractors.code',
      'labour_contractors.name',
      'labour_contractors.status',
      'labour_contractors.trade_specialisation',
      'labour_contractors.contact_phone',
      'labour_contractors.licence_valid_until',
      'labour_contractors.wc_policy_valid_until',
      'labour_contractors.esi_registered',
      'labour_contractors.pf_registered',
      'labour_contractors.rating',
      'vendors.name as vendor_name',
    ])
    .orderBy('labour_contractors.code')
  if (opts.status) query = query.where('labour_contractors.status', '=', opts.status as 'active')
  if (opts.search) {
    const like = `%${opts.search}%`
    query = query.where((eb) =>
      eb.or([eb('labour_contractors.name', 'like', like), eb('labour_contractors.code', 'like', like)])
    )
  }
  return (await query.execute()) as unknown as ContractorListRow[]
}

export async function findContractor(db: Queryable, id: number) {
  return db
    .selectFrom('labour_contractors')
    .leftJoin('vendors', 'vendors.id', 'labour_contractors.vendor_id')
    .select([
      'labour_contractors.id',
      'labour_contractors.code',
      'labour_contractors.name',
      'labour_contractors.vendor_id',
      'labour_contractors.contact_phone',
      'labour_contractors.pan',
      'labour_contractors.gstin',
      'labour_contractors.trade_specialisation',
      'labour_contractors.licence_no',
      'labour_contractors.licence_valid_until',
      'labour_contractors.esi_registered',
      'labour_contractors.pf_registered',
      'labour_contractors.wc_policy_no',
      'labour_contractors.wc_policy_valid_until',
      'labour_contractors.rating',
      'labour_contractors.status',
      'labour_contractors.created_at',
      'vendors.name as vendor_name',
    ])
    .where('labour_contractors.id', '=', id)
    .executeTakeFirst()
}

/** Active contractors for a select. Blacklisted ones are left out on purpose. */
export async function contractorOptions(db: Queryable) {
  return db
    .selectFrom('labour_contractors')
    .select(['id', 'code', 'name', 'status'])
    .where('status', '!=', 'blacklisted')
    .orderBy('code')
    .execute()
}

/**
 * Vendors a contractor can be linked to, for the optional `vendor_id`.
 *
 * Subcontractors and service vendors only: a labour contractor who is also on
 * the vendor master is one of those two, and offering the cement supplier in
 * that select invites a link that means nothing to 6.4.
 */
export async function contractorVendorOptions(db: Queryable) {
  return db
    .selectFrom('vendors')
    .select(['id', 'code', 'name'])
    .where('status', '=', 'active')
    .where('vendor_type', 'in', ['subcontractor', 'service'])
    .orderBy('name')
    .execute()
}

export interface ContractorRateRow {
  id: number
  project_id: number | null
  work_type: string
  uom: string
  skill_level: string | null
  rate_paise: number
  effective_from: string
  effective_to: string | null
  project_code: string | null
}

export async function contractorRates(db: Queryable, contractorId: number): Promise<ContractorRateRow[]> {
  const rows = await db
    .selectFrom('contractor_rates')
    .leftJoin('projects', 'projects.id', 'contractor_rates.project_id')
    .select([
      'contractor_rates.id',
      'contractor_rates.project_id',
      'contractor_rates.work_type',
      'contractor_rates.uom',
      'contractor_rates.skill_level',
      'contractor_rates.rate_paise',
      'contractor_rates.effective_from',
      'contractor_rates.effective_to',
      'projects.code as project_code',
    ])
    .where('contractor_rates.contractor_id', '=', contractorId)
    .orderBy('contractor_rates.effective_from', 'desc')
    .orderBy('contractor_rates.id', 'desc')
    .execute()
  return rows.map((r) => ({ ...r, rate_paise: Number(r.rate_paise) })) as unknown as ContractorRateRow[]
}

/**
 * The rate a row is priced at, resolved to exactly one rate card line.
 *
 * `contractor_attendance.rate_paise` is a snapshot rather than a join, so this
 * runs once at entry and the figure never moves afterwards. The ordering is the
 * whole content of the function:
 *
 *   1. The UOM asked for. `per_day` is the default because a headcount is what a
 *      day rate multiplies; 013 gave the table a `quantity`, so the other four
 *      members are now reachable and the caller says which one it wants.
 *   2. `work_type`, when the caller names one. A day rate is picked by skill
 *      level, but a per-sqft rate is for plastering or for tiling and a
 *      contractor may hold both, so skill level cannot choose between them.
 *   3. A rate for THIS project beats a company-wide one, which is what a
 *      nullable `contractor_rates.project_id` is for.
 *   4. A rate naming THIS skill level beats one that leaves it NULL. Measured
 *      work is often quoted per unit regardless of who does it, and
 *      `contractor_rates.skill_level` is nullable for that case, while
 *      `contractor_attendance.skill_level` is NOT NULL and always says who.
 *   5. Then the latest `effective_from` that has begun, then the highest id.
 *
 * Rule 3 sits above rule 4 deliberately: scope is the distinction the spec builds
 * into the schema, and it was the existing behaviour for day rates before
 * measured work existed. Rule 5 is deterministic but not unambiguous, and the
 * caller is told so through `ambiguous` rather than being refused, because a
 * refusal would stop a site gate at 8am over a data condition nobody there can
 * fix. The service records the chosen `rate_id` in the audit log for that reason.
 */
export async function applicableRate(
  db: Queryable,
  opts: {
    contractorId: number
    projectId: number
    skillLevel: string
    onDate: string
    uom?: string
    // Empty or absent means "do not filter by work type", which is what a day row
    // wants: skill level picks a day rate. Migration 016 made
    // `contractor_attendance.work_type` NOT NULL DEFAULT '', so callers now pass ''
    // for a day row where they used to pass null. Both still mean the same here.
    workType?: string | null
  }
) {
  const uom = opts.uom ?? 'per_day'
  let query = db
    .selectFrom('contractor_rates')
    .select(['id', 'project_id', 'work_type', 'uom', 'skill_level', 'rate_paise', 'effective_from', 'effective_to'])
    .where('contractor_id', '=', opts.contractorId)
    .where('uom', '=', uom as 'per_day')
    .where('effective_from', '<=', opts.onDate)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', opts.onDate)]))
    .where((eb) => eb.or([eb('project_id', 'is', null), eb('project_id', '=', opts.projectId)]))
    .where((eb) =>
      eb.or([eb('skill_level', 'is', null), eb('skill_level', '=', opts.skillLevel as 'skilled')])
    )
  const workType = (opts.workType ?? '').trim()
  if (workType !== '') {
    query = query.where('work_type', '=', workType)
  }
  const rows = await query.execute()
  if (rows.length === 0) return undefined

  const ranked = [...rows].sort((a, b) => {
    const scope = (r: typeof a) => (r.project_id === null ? 0 : 1)
    const skill = (r: typeof a) => (r.skill_level === null ? 0 : 1)
    if (scope(a) !== scope(b)) return scope(b) - scope(a)
    if (skill(a) !== skill(b)) return skill(b) - skill(a)
    if (a.effective_from !== b.effective_from) return String(a.effective_from) < String(b.effective_from) ? 1 : -1
    return Number(b.id) - Number(a.id)
  })
  const best = ranked[0]!
  const runnerUp = ranked[1]
  return {
    id: Number(best.id),
    projectId: best.project_id === null ? null : Number(best.project_id),
    workType: best.work_type,
    uom: String(best.uom),
    ratePaise: Number(best.rate_paise),
    // A project rate sitting above a company-wide one is not ambiguous: rule 3
    // decides it, and nor is a skill-specific one above a NULL-skill one. A tie
    // on scope, skill and start date is, and the entry screen says so rather
    // than presenting one figure as the only one.
    ambiguous:
      runnerUp !== undefined &&
      (runnerUp.project_id === null) === (best.project_id === null) &&
      (runnerUp.skill_level === null) === (best.skill_level === null) &&
      String(runnerUp.effective_from) === String(best.effective_from),
  }
}

export interface ContractorAttendanceRow {
  id: number
  contractor_id: number
  project_id: number
  attendance_date: string
  skill_level: string
  uom: string
  // '' on a day row since 016, never null.
  work_type: string
  headcount: number
  quantity: number | null
  overtime_hours: number
  rate_paise: number
  amount_paise: number
  approved_at: string | null
  bill_id: number | null
  contractor_code: string | null
  contractor_name: string | null
  project_code: string | null
  bill_no: string | null
}

/**
 * Contractor attendance over a range, for the approval sweep, the day's prefill
 * and a bill's own lines.
 *
 * `billId` and `unbilledOnly` are separate options rather than one nullable
 * filter, because they answer different questions: a bill page asks for the rows
 * it consumed, and the generator asks for the rows nothing has consumed.
 */
export async function contractorAttendance(
  db: Queryable,
  opts: {
    contractorId?: number
    projectId?: number
    from?: string
    to?: string
    billId?: number
    unbilledOnly?: boolean
    approvedOnly?: boolean
  }
): Promise<ContractorAttendanceRow[]> {
  let query = db
    .selectFrom('contractor_attendance')
    .innerJoin('labour_contractors', 'labour_contractors.id', 'contractor_attendance.contractor_id')
    .leftJoin('projects', 'projects.id', 'contractor_attendance.project_id')
    .leftJoin('contractor_bills', 'contractor_bills.id', 'contractor_attendance.bill_id')
    .select([
      'contractor_attendance.id',
      'contractor_attendance.contractor_id',
      'contractor_attendance.project_id',
      'contractor_attendance.attendance_date',
      'contractor_attendance.skill_level',
      'contractor_attendance.uom',
      'contractor_attendance.work_type',
      'contractor_attendance.headcount',
      'contractor_attendance.quantity',
      'contractor_attendance.overtime_hours',
      'contractor_attendance.rate_paise',
      'contractor_attendance.amount_paise',
      'contractor_attendance.approved_at',
      'contractor_attendance.bill_id',
      'labour_contractors.code as contractor_code',
      'labour_contractors.name as contractor_name',
      'projects.code as project_code',
      'contractor_bills.bill_no',
    ])
    .orderBy('contractor_attendance.attendance_date')
    .orderBy('contractor_attendance.skill_level')
  if (opts.contractorId) query = query.where('contractor_attendance.contractor_id', '=', opts.contractorId)
  if (opts.projectId) query = query.where('contractor_attendance.project_id', '=', opts.projectId)
  if (opts.from) query = query.where('contractor_attendance.attendance_date', '>=', opts.from)
  if (opts.to) query = query.where('contractor_attendance.attendance_date', '<=', opts.to)
  if (opts.billId) query = query.where('contractor_attendance.bill_id', '=', opts.billId)
  if (opts.unbilledOnly) query = query.where('contractor_attendance.bill_id', 'is', null)
  if (opts.approvedOnly) query = query.where('contractor_attendance.approved_at', 'is not', null)

  const rows = await query.execute()
  return rows.map((r) => ({
    ...r,
    headcount: Number(r.headcount),
    // DECIMAL arrives as a string, and NULL has to stay NULL: Number(null) is 0,
    // which would read as "no work measured" rather than "not measured work".
    quantity: r.quantity === null ? null : Number(r.quantity),
    overtime_hours: Number(r.overtime_hours),
    rate_paise: Number(r.rate_paise),
    amount_paise: Number(r.amount_paise),
  })) as unknown as ContractorAttendanceRow[]
}

export interface UnbilledSummary {
  rows: number
  days: number
  headcountDays: number
  overtimeHours: number
  grossPaise: number
  unapproved: number
}

/**
 * What a bill for this period would come to, before it is generated.
 *
 * The generate form shows this so the operator sees the gross the rule will
 * compute rather than discovering it after a bill number has been burned.
 * `unapproved` is counted and shown separately because those rows are the usual
 * reason a figure looks too small, and rule 2 excludes them.
 */
export async function unbilledSummary(
  db: Queryable,
  opts: { contractorId: number; projectId: number; from: string; to: string }
): Promise<UnbilledSummary> {
  const rows = await contractorAttendance(db, { ...opts, unbilledOnly: true })
  const approved = rows.filter((r) => r.approved_at !== null)
  return {
    rows: approved.length,
    days: new Set(approved.map((r) => String(r.attendance_date))).size,
    headcountDays: approved.reduce((sum, r) => sum + r.headcount, 0),
    overtimeHours: Math.round(approved.reduce((sum, r) => sum + r.overtime_hours, 0) * 10) / 10,
    grossPaise: approved.reduce((sum, r) => sum + r.amount_paise, 0),
    unapproved: rows.length - approved.length,
  }
}

export interface ContractorBillRow {
  id: number
  bill_no: string
  contractor_id: number
  project_id: number
  period_from: string
  period_to: string
  gross_paise: number
  advance_recovered_paise: number
  retention_paise: number
  tds_paise: number
  penalty_paise: number
  net_payable_paise: number
  status: string
  approved_at: string | null
  expense_id: number | null
  contractor_code: string
  contractor_name: string
  project_code: string
}

/** Every paise column is widened through Number: mysql2 returns BIGINT as text. */
function billRow<T extends Record<string, unknown>>(r: T) {
  return {
    ...r,
    gross_paise: Number(r['gross_paise']),
    advance_recovered_paise: Number(r['advance_recovered_paise']),
    retention_paise: Number(r['retention_paise']),
    tds_paise: Number(r['tds_paise']),
    penalty_paise: Number(r['penalty_paise']),
    net_payable_paise: Number(r['net_payable_paise']),
  }
}

const BILL_COLUMNS = [
  'contractor_bills.id',
  'contractor_bills.bill_no',
  'contractor_bills.contractor_id',
  'contractor_bills.project_id',
  'contractor_bills.period_from',
  'contractor_bills.period_to',
  'contractor_bills.gross_paise',
  'contractor_bills.advance_recovered_paise',
  'contractor_bills.retention_paise',
  'contractor_bills.tds_paise',
  'contractor_bills.penalty_paise',
  'contractor_bills.net_payable_paise',
  'contractor_bills.status',
  'contractor_bills.approved_at',
  'contractor_bills.expense_id',
  'labour_contractors.code as contractor_code',
  'labour_contractors.name as contractor_name',
  'projects.code as project_code',
] as const

export async function listContractorBills(
  db: Queryable,
  opts: { contractorId?: number; projectId?: number; status?: string } = {}
): Promise<ContractorBillRow[]> {
  let query = db
    .selectFrom('contractor_bills')
    .innerJoin('labour_contractors', 'labour_contractors.id', 'contractor_bills.contractor_id')
    .innerJoin('projects', 'projects.id', 'contractor_bills.project_id')
    .select([...BILL_COLUMNS])
    .orderBy('contractor_bills.id', 'desc')
  if (opts.contractorId) query = query.where('contractor_bills.contractor_id', '=', opts.contractorId)
  if (opts.projectId) query = query.where('contractor_bills.project_id', '=', opts.projectId)
  if (opts.status) query = query.where('contractor_bills.status', '=', opts.status as 'draft')
  return (await query.execute()).map(billRow) as unknown as ContractorBillRow[]
}

/**
 * One bill, with the two names the page has to show and the approver's.
 *
 * `expense_id` is selected even though nothing writes it yet: it is the back-link
 * to the `expenses` row 6.8 will create at approval, and a bill page that showed
 * an approved bill without saying whether it had reached finance would be the
 * screen somebody double-posts from.
 */
export async function findContractorBill(db: Queryable, id: number) {
  const row = await db
    .selectFrom('contractor_bills')
    .innerJoin('labour_contractors', 'labour_contractors.id', 'contractor_bills.contractor_id')
    .innerJoin('projects', 'projects.id', 'contractor_bills.project_id')
    .leftJoin('users as approver', 'approver.id', 'contractor_bills.approved_by')
    .leftJoin('users as creator', 'creator.id', 'contractor_bills.created_by')
    .select([
      ...BILL_COLUMNS,
      'projects.name as project_name',
      'labour_contractors.pan as contractor_pan',
      'labour_contractors.gstin as contractor_gstin',
      'contractor_bills.created_at',
      'approver.full_name as approved_by_name',
      'creator.full_name as created_by_name',
    ])
    .where('contractor_bills.id', '=', id)
    .executeTakeFirst()
  return row === undefined ? undefined : billRow(row)
}
