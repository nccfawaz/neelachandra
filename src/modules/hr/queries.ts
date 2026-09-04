import type { Db, Queryable } from '../../db/kysely.js'

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
