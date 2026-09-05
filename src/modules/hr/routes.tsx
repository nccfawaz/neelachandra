import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Child } from 'hono/jsx'
import type { AppEnv } from '../../types.js'
import { currentUser } from '../../types.js'
import { page, banner, okRedirect, errRedirect, queryParam } from '../../dashboard/render.js'
import {
  Alert,
  CsrfInput,
  DataTable,
  DateText,
  DefinitionList,
  FormField,
  KpiCard,
  Money,
  Panel,
  StatusBadge,
  Tabs,
  type Column,
} from '../../dashboard/components/index.js'
import { requirePermission, requireAllPermissions } from '../../middleware/requirePermission.js'
import { PERMISSIONS } from '../../lib/permissions.js'
import { readBody } from '../../middleware/csrf.js'
import { NotFoundError, isAppError } from '../../lib/errors.js'
import { formatPaise } from '../../lib/money.js'
import {
  datesBetween,
  financialYear,
  formatDate,
  formatMonth,
  isValidIsoDate,
  monthBounds,
  monthOf,
  today,
} from '../../lib/dates.js'
import * as q from './queries.js'
import * as svc from './service.js'
import {
  attendanceApproveSchema,
  attendanceBulkSchema,
  compensationSchema,
  contractorAttendanceSchema,
  contractorBillGenerateSchema,
  contractorPeriodSchema,
  contractorRateSchema,
  contractorSchema,
  documentSchema,
  employeeSchema,
  exitSchema,
  firstError,
  leaveDecisionSchema,
  leaveRequestSchema,
  ATTENDANCE_STATUSES,
  CONTRACTOR_BILL_STATUSES,
  CONTRACTOR_STATUSES,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  EXIT_TYPES,
  GENDERS,
  LEAVE_REQUEST_STATUSES,
  RATE_UOMS,
  SKILL_LEVELS,
  uomLabel,
} from './schemas.js'

/**
 * HR routes (spec 6.6).
 *
 * The permission split from 6.6 rule 5 is structural, not cosmetic. The
 * compensation tab is a separate route behind `requireAllPermissions`, and the
 * profile route never calls `compensationHistory`, so a user with
 * `hr.employee_view` alone cannot reach a pay figure by any path through this
 * file -- including by guessing `?tab=compensation`, which 404s rather than
 * rendering an empty tab.
 *
 * State-changing actions sit on `/api/hr/...` and are POST. The spec table
 * gives PUT for a compensation revision and PATCH for an applicant stage; an
 * HTML form can send neither, and CRM and inventory already settled this the
 * same way. The paths and the permissions are the spec's; the verb is POST.
 *
 * Attendance, leave, contractors and recruiting are still the stub screens
 * below. They stay mounted and guarded so the navigation invariant holds: a
 * link the user can see is a link that neither 404s nor 403s.
 */

const hr = new Hono<AppEnv>()

type Ctx = Context<AppEnv>

function actorOf(c: Ctx): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}

function canPay(c: Ctx): boolean {
  return c.get('perms').has(PERMISSIONS.HR_PAYROLL_VIEW)
}

function canManage(c: Ctx): boolean {
  return c.get('perms').has(PERMISSIONS.HR_EMPLOYEE_MANAGE)
}

function idParam(c: Ctx, name = 'employeeId'): number {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('Not found')
  return n
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase())
}

/** A nullable paise column, widened because mysql2 hands BIGINT back as a string. */
function money(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v)
}

const enumOptions = (values: readonly string[], selected: string | null | undefined, blank?: string) => [
  ...(blank ? [{ value: '', label: blank, selected: !selected }] : []),
  ...values.map((v) => ({ value: v, label: titleCase(v), selected: v === selected })),
]

/* Module dashboard ------------------------------------------------------- */

hr.get('/app/hr', requirePermission(PERMISSIONS.HR_EMPLOYEE_VIEW), async (c) => {
  const db = c.get('db')
  const data = await q.hrDashboard(db)
  const active = data.headcount.find((r) => r.status === 'active')
  const onBooks = data.headcount
    .filter((r) => r.status !== 'exited')
    .reduce((sum, r) => sum + Number(r.n), 0)

  const expiring: Column<(typeof data.expiringDocuments)[number]>[] = [
    { header: 'Employee', cell: (r) => `${r.employee_code} ${r.full_name}` },
    { header: 'Document', cell: (r) => titleCase(r.doc_type) },
    {
      header: 'Expires',
      cell: (r) => (
        <>
          <DateText value={r.expires_on} />
          {r.expires_on && r.expires_on < today() ? (
            <div class="ncc-badge ncc-badge-danger">expired</div>
          ) : null}
        </>
      ),
    },
  ]

  return page(
    c,
    { title: 'HR', path: '/app/hr', subtitle: 'Headcount, attendance awaiting approval, and document expiry' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="On the books" value={String(onBooks)} hint="Excludes exited" href="/app/hr/employees" />
        <KpiCard label="Active" value={String(Number(active?.n ?? 0))} hint="status = active" />
        <KpiCard
          label="Attendance unapproved"
          value={String(data.unapprovedAttendance)}
          hint="Rows with no approved_at"
          // Always linked now. The attendance route guards on the OR of
          // hr.employee_view, hr.attendance_record and hr.attendance_approve,
          // and this card is already behind hr.employee_view, so the link cannot
          // 403 from here. It used to be withheld because the route required
          // hr.attendance_record, which the 002 seed gives to a different role.
          href="/app/hr/attendance"
        />
        <KpiCard label="Open positions" value={String(data.openPositions)} hint="status = open" />
      </div>
      <Panel title="Documents with an expiry date">
        <DataTable
          columns={expiring}
          rows={data.expiringDocuments}
          empty="No employee document records an expiry date."
        />
      </Panel>
    </>
  )
})

/* Employee list ---------------------------------------------------------- */

/**
 * The list carries no pay column and no identity numbers.
 *
 * `listEmployees` does not select them, so this is a property of the query
 * rather than of this table definition. A list is the screen left open on a
 * shared laptop at a site office.
 */
hr.get('/app/hr/employees', requirePermission(PERMISSIONS.HR_EMPLOYEE_VIEW), async (c) => {
  const db = c.get('db')
  const status = queryParam(c, 'status')
  const departmentId = Number(queryParam(c, 'departmentId') ?? '') || undefined
  const search = queryParam(c, 'q')

  const [rows, departments] = await Promise.all([
    q.listEmployees(db, { status, departmentId, q: search }),
    q.departmentOptions(db),
  ])

  const columns: Column<q.EmployeeListRow>[] = [
    {
      header: 'Employee',
      cell: (r) => (
        <>
          <a href={`/app/hr/employees/${r.id}`}>
            <strong>{r.full_name}</strong>
          </a>
          <div class="ncc-muted">{r.employee_code}</div>
        </>
      ),
    },
    { header: 'Department', cell: (r) => r.department_name ?? '-' },
    { header: 'Designation', cell: (r) => r.designation_name ?? '-' },
    { header: 'Type', cell: (r) => titleCase(r.employment_type) },
    { header: 'Joined', cell: (r) => <DateText value={r.date_of_joining} /> },
    { header: 'Phone', cell: (r) => r.personal_phone ?? <span class="ncc-muted">-</span> },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  return page(
    c,
    {
      title: 'Employees',
      path: '/app/hr/employees',
      subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'}`,
      actions: canManage(c) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/hr/employees/new">
          New employee
        </a>
      ) : null,
    },
    <>
      {banner(c)}
      <form class="ncc-card ncc-row" method="get" action="/app/hr/employees">
        <FormField label="Status" name="status" options={enumOptions(EMPLOYEE_STATUSES, status, 'Any')} />
        <FormField
          label="Department"
          name="departmentId"
          options={[
            { value: '', label: 'Any', selected: !departmentId },
            ...departments.map((d) => ({
              value: String(d.id),
              label: d.name,
              selected: d.id === departmentId,
            })),
          ]}
        />
        <FormField label="Name contains" name="q" value={search ?? ''} />
        <button class="ncc-btn" type="submit">
          Filter
        </button>
      </form>
      <Panel title="Employees">
        <DataTable columns={columns} rows={rows} empty="No employee matches that filter." />
      </Panel>
    </>
  )
})

/* The employee form, shared by create and edit ---------------------------- */

type EmployeeDetail = NonNullable<Awaited<ReturnType<typeof q.findEmployee>>>

interface FormOptions {
  departments: Awaited<ReturnType<typeof q.departmentOptions>>
  designations: Awaited<ReturnType<typeof q.designationOptions>>
  locations: Awaited<ReturnType<typeof q.locationOptions>>
  managers: Awaited<ReturnType<typeof q.managerOptions>>
}

async function formOptions(db: Parameters<typeof q.departmentOptions>[0], excludeId?: number): Promise<FormOptions> {
  const [departments, designations, locations, managers] = await Promise.all([
    q.departmentOptions(db),
    q.designationOptions(db),
    q.locationOptions(db),
    q.managerOptions(db, excludeId),
  ])
  return { departments, designations, locations, managers }
}

const idOptions = (
  rows: Array<{ id: number; name?: string; full_name?: string; employee_code?: string }>,
  selected: number | null | undefined,
  blank: string
) => [
  { value: '', label: blank, selected: !selected },
  ...rows.map((r) => ({
    value: String(r.id),
    label: r.name ?? `${r.employee_code ?? ''} ${r.full_name ?? ''}`.trim(),
    selected: Number(r.id) === Number(selected ?? -1),
  })),
]

/**
 * One form for both create and edit.
 *
 * The Aadhaar field asks for four digits and says why (6.6 rule 6). Saying it
 * on the form is the cheap half of that rule: the schema refuses a longer
 * value either way, but a user who has just had twelve digits rejected with no
 * explanation types them again.
 */
function EmployeeForm(props: {
  action: string
  csrf: string
  employee?: EmployeeDetail
  options: FormOptions
  submitLabel: string
  cancelHref: string
}) {
  const e = props.employee
  const { departments, designations, locations, managers } = props.options
  return (
    <form class="ncc-card ncc-stack" method="post" action={props.action}>
      <CsrfInput token={props.csrf} />
      <h3 style="margin:0">Identity</h3>
      <FormField label="Full name" name="fullName" required value={e?.full_name} />
      <FormField label="Father or spouse name" name="fatherOrSpouseName" value={e?.father_or_spouse_name} />
      <FormField label="Date of birth" name="dateOfBirth" type="date" value={e?.date_of_birth} />
      <FormField label="Gender" name="gender" options={enumOptions(GENDERS, e?.gender, 'Not recorded')} />
      <FormField label="Blood group" name="bloodGroup" value={e?.blood_group} placeholder="O+" />
      <h3 style="margin:0">Contact</h3>
      <FormField label="Personal phone" name="personalPhone" value={e?.personal_phone} />
      <FormField label="Personal email" name="personalEmail" type="email" value={e?.personal_email} />
      <FormField label="Emergency contact name" name="emergencyContactName" value={e?.emergency_contact_name} />
      <FormField label="Emergency contact phone" name="emergencyContactPhone" value={e?.emergency_contact_phone} />
      <FormField label="Permanent address" name="permanentAddress" rows={2} value={e?.permanent_address} />
      <FormField label="Current address" name="currentAddress" rows={2} value={e?.current_address} />
      <h3 style="margin:0">Employment</h3>
      <FormField
        label="Department"
        name="departmentId"
        options={idOptions(departments, e?.department_id, 'Unassigned')}
      />
      <FormField
        label="Designation"
        name="designationId"
        options={idOptions(designations, e?.designation_id, 'Unassigned')}
      />
      <FormField
        label="Reports to"
        name="reportingToEmployeeId"
        hint="A loop in the reporting line is refused, not saved."
        options={idOptions(managers, e?.reporting_to_employee_id, 'Nobody')}
      />
      <FormField
        label="Employment type"
        name="employmentType"
        required
        options={enumOptions(EMPLOYMENT_TYPES, e?.employment_type ?? 'permanent')}
      />
      <FormField label="Date of joining" name="dateOfJoining" type="date" required value={e?.date_of_joining} />
      <FormField
        label="Probation until"
        name="probationUntil"
        type="date"
        value={e?.probation_until}
        hint="Leave blank for a permanent hire with no probation."
      />
      <FormField label="Base location" name="baseLocationId" options={idOptions(locations, e?.base_location_id, 'Head office')} />
      <h3 style="margin:0">Statutory</h3>
      <FormField label="PAN" name="pan" value={e?.pan} placeholder="ABCDE1234F" />
      <FormField
        label="Aadhaar, last four digits only"
        name="aadhaarLast4"
        value={e?.aadhaar_last4}
        placeholder="1234"
        hint="The full number is deliberately not stored. Attach the scanned document under Documents instead."
      />
      <FormField label="UAN" name="uan" value={e?.uan} />
      <FormField label="PF number" name="pfNumber" value={e?.pf_number} />
      <FormField label="ESI number" name="esiNumber" value={e?.esi_number} />
      <h3 style="margin:0">Bank</h3>
      <FormField label="Account holder name" name="bankAccountName" value={e?.bank_account_name} />
      <FormField label="Account number" name="bankAccountNo" value={e?.bank_account_no} />
      <FormField label="IFSC" name="bankIfsc" value={e?.bank_ifsc} placeholder="HDFC0001234" />
      <div class="ncc-row">
        <button class="ncc-btn ncc-btn-primary" type="submit">
          {props.submitLabel}
        </button>
        <a class="ncc-btn" href={props.cancelHref}>
          Cancel
        </a>
      </div>
    </form>
  )
}

/* Create ----------------------------------------------------------------- */

hr.get('/app/hr/employees/new', requirePermission(PERMISSIONS.HR_EMPLOYEE_MANAGE), async (c) => {
  const options = await formOptions(c.get('db'))
  const session = c.get('session')!
  return page(
    c,
    {
      title: 'New employee',
      path: '/app/hr/employees',
      subtitle: 'The employee code is issued on save',
    },
    <>
      {banner(c)}
      <EmployeeForm
        action="/app/hr/employees"
        csrf={session.csrfToken}
        options={options}
        submitLabel="Create employee"
        cancelHref="/app/hr/employees"
      />
    </>
  )
})

hr.post('/app/hr/employees', requirePermission(PERMISSIONS.HR_EMPLOYEE_MANAGE), async (c) => {
  const parsed = employeeSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/hr/employees/new', firstError(parsed.error))

  const employeeId = await svc.createEmployee(c.get('db'), actorOf(c), parsed.data)
  return okRedirect(c, `/app/hr/employees/${employeeId}`, 'Employee created.')
})

/* Edit ------------------------------------------------------------------- */

hr.get('/app/hr/employees/:employeeId/edit', requirePermission(PERMISSIONS.HR_EMPLOYEE_MANAGE), async (c) => {
  const db = c.get('db')
  const employeeId = idParam(c)
  const employee = await q.findEmployee(db, employeeId)
  if (!employee) throw new NotFoundError('Employee not found')

  const options = await formOptions(db, employeeId)
  const session = c.get('session')!
  return page(
    c,
    {
      title: employee.full_name,
      path: '/app/hr/employees',
      subtitle: `Editing ${employee.employee_code}`,
    },
    <>
      {banner(c)}
      <EmployeeForm
        action={`/app/hr/employees/${employeeId}`}
        csrf={session.csrfToken}
        employee={employee}
        options={options}
        submitLabel="Save changes"
        cancelHref={`/app/hr/employees/${employeeId}`}
      />
    </>
  )
})

hr.post('/app/hr/employees/:employeeId', requirePermission(PERMISSIONS.HR_EMPLOYEE_MANAGE), async (c) => {
  const employeeId = idParam(c)
  const parsed = employeeSchema.safeParse(await readBody(c))
  if (!parsed.success) {
    return errRedirect(c, `/app/hr/employees/${employeeId}/edit`, firstError(parsed.error))
  }

  await svc.updateEmployee(c.get('db'), actorOf(c), employeeId, parsed.data)
  return okRedirect(c, `/app/hr/employees/${employeeId}`, 'Employee updated.')
})

/* Detail ----------------------------------------------------------------- */

const TABS = ['profile', 'compensation', 'documents', 'exit'] as const
type TabName = (typeof TABS)[number]

function tabsFor(employeeId: number, c: Ctx) {
  const base = `/app/hr/employees/${employeeId}`
  const tabs = [{ label: 'Profile', href: `${base}?tab=profile` }]
  if (canPay(c)) tabs.push({ label: 'Compensation', href: `${base}?tab=compensation` })
  tabs.push({ label: 'Documents', href: `${base}?tab=documents` })
  if (canManage(c)) tabs.push({ label: 'Exit', href: `${base}?tab=exit` })
  return tabs
}

hr.get('/app/hr/employees/:employeeId', requirePermission(PERMISSIONS.HR_EMPLOYEE_VIEW), async (c) => {
  const db = c.get('db')
  const employeeId = idParam(c)
  const employee = await q.findEmployee(db, employeeId)
  if (!employee) throw new NotFoundError('Employee not found')

  const requested = (queryParam(c, 'tab') ?? 'profile') as TabName
  const tab: TabName = TABS.includes(requested) ? requested : 'profile'

  // A hand-typed ?tab=compensation is a 404 rather than an empty tab. The
  // difference matters: an empty tab tells the user pay data exists and they
  // cannot see it, and the next thing they do is ask a colleague to read it out.
  if (tab === 'compensation' && !canPay(c)) throw new NotFoundError('Not found')
  if (tab === 'exit' && !canManage(c)) throw new NotFoundError('Not found')

  const body = await renderTab(c, tab, employee)

  return page(
    c,
    {
      title: employee.full_name,
      path: '/app/hr/employees',
      subtitle: `${employee.employee_code}, ${titleCase(employee.employment_type)}${
        employee.designation_name ? `, ${employee.designation_name}` : ''
      }`,
      actions: (
        <>
          <StatusBadge status={employee.status} />
          {canManage(c) && employee.status !== 'exited' ? (
            <a class="ncc-btn" href={`/app/hr/employees/${employeeId}/edit`}>
              Edit
            </a>
          ) : null}
        </>
      ),
    },
    <>
      {banner(c)}
      <Tabs tabs={tabsFor(employeeId, c)} active={`/app/hr/employees/${employeeId}?tab=${tab}`} />
      {body}
    </>
  )
})

async function renderTab(c: Ctx, tab: TabName, employee: EmployeeDetail) {
  const db = c.get('db')
  const employeeId = Number(employee.id)
  const session = c.get('session')!

  switch (tab) {
    case 'profile': {
      return (
        <div class="ncc-stack">
          <Panel title="Employment">
            <DefinitionList
              rows={[
                ['Employee code', employee.employee_code],
                ['Department', employee.department_name ?? '-'],
                ['Designation', employee.designation_name ?? '-'],
                ['Reports to', employee.reports_to_name ?? 'Nobody'],
                ['Base location', employee.base_location_name ?? 'Head office'],
                ['Employment type', titleCase(employee.employment_type)],
                ['Date of joining', <DateText value={employee.date_of_joining} />],
                ['Probation until', <DateText value={employee.probation_until} />],
                ['Status', <StatusBadge status={employee.status} />],
                [
                  'Login',
                  employee.login_email ? (
                    <>
                      {employee.login_email} <StatusBadge status={employee.login_status} />
                    </>
                  ) : (
                    <span class="ncc-muted">No login</span>
                  ),
                ],
              ]}
            />
          </Panel>
          <Panel title="Personal and contact">
            <DefinitionList
              rows={[
                ['Father or spouse', employee.father_or_spouse_name ?? '-'],
                ['Date of birth', <DateText value={employee.date_of_birth} />],
                ['Gender', employee.gender ? titleCase(employee.gender) : '-'],
                ['Blood group', employee.blood_group ?? '-'],
                ['Phone', employee.personal_phone ?? '-'],
                ['Email', employee.personal_email ?? '-'],
                [
                  'Emergency contact',
                  employee.emergency_contact_name
                    ? `${employee.emergency_contact_name}${
                        employee.emergency_contact_phone ? `, ${employee.emergency_contact_phone}` : ''
                      }`
                    : '-',
                ],
                ['Permanent address', employee.permanent_address ?? '-'],
                ['Current address', employee.current_address ?? '-'],
              ]}
            />
          </Panel>
          <Panel title="Statutory and bank">
            <p class="ncc-hint">
              Aadhaar is held as the last four digits only. The full number is not stored anywhere in this system;
              the scanned document sits in the file store under an access-checked route.
            </p>
            <DefinitionList
              rows={[
                ['PAN', employee.pan ?? '-'],
                ['Aadhaar', employee.aadhaar_last4 ? `XXXX XXXX ${employee.aadhaar_last4}` : '-'],
                ['UAN', employee.uan ?? '-'],
                ['PF number', employee.pf_number ?? '-'],
                ['ESI number', employee.esi_number ?? '-'],
                ['Bank account name', employee.bank_account_name ?? '-'],
                ['Bank account number', employee.bank_account_no ?? '-'],
                ['IFSC', employee.bank_ifsc ?? '-'],
              ]}
            />
          </Panel>
          {employee.status === 'exited' ? (
            <Panel title="Exit">
              <DefinitionList
                rows={[
                  ['Date of exit', <DateText value={employee.date_of_exit} />],
                  ['Type', employee.exit_type ? titleCase(employee.exit_type) : '-'],
                  ['Reason', employee.exit_reason ?? '-'],
                ]}
              />
            </Panel>
          ) : null}
        </div>
      )
    }

    case 'compensation': {
      const history = await q.compensationHistory(db, employeeId)
      const columns: Column<(typeof history)[number]>[] = [
        { header: 'From', cell: (r) => <DateText value={r.effective_from} /> },
        {
          header: 'To',
          cell: (r) =>
            r.effective_to ? (
              <DateText value={r.effective_to} />
            ) : (
              <span class="ncc-badge ncc-badge-ok">current</span>
            ),
        },
        { header: 'Annual CTC', numeric: true, cell: (r) => <Money paise={Number(r.ctc_annual_paise)} /> },
        { header: 'Basic', numeric: true, cell: (r) => <Money paise={money(r.basic_paise)} compact /> },
        { header: 'HRA', numeric: true, cell: (r) => <Money paise={money(r.hra_paise)} compact /> },
        {
          header: 'Site allowance',
          numeric: true,
          cell: (r) => <Money paise={money(r.site_allowance_paise)} compact />,
        },
        { header: 'Reason', cell: (r) => r.revision_reason ?? '-' },
        { header: 'Approved by', cell: (r) => r.approved_by_name ?? '-' },
      ]

      return (
        <div class="ncc-stack">
          <Panel title="Compensation history">
            <p class="ncc-hint">
              A revision does not edit the period it replaces. The open row is closed the day before the new one
              starts, so every past month has exactly one answer to what this employee was on.
            </p>
            <DataTable columns={columns} rows={history} empty="No compensation recorded for this employee yet." />
          </Panel>
          {canManage(c) && employee.status !== 'exited' ? (
            <Panel title="Record a revision">
              <form
                class="ncc-stack"
                method="post"
                action={`/api/hr/employees/${employeeId}/compensation`}
              >
                <CsrfInput token={session.csrfToken} />
                <p class="ncc-hint">
                  Amounts in rupees. The components are monthly, the CTC is annual, and twelve times the components
                  cannot exceed the CTC.
                </p>
                <FormField label="Effective from" name="effectiveFrom" type="date" required />
                <FormField label="Annual CTC" name="ctcAnnualPaise" type="number" step="0.01" required />
                <FormField label="Basic, monthly" name="basicPaise" type="number" step="0.01" />
                <FormField label="HRA, monthly" name="hraPaise" type="number" step="0.01" />
                <FormField label="Conveyance, monthly" name="conveyancePaise" type="number" step="0.01" />
                <FormField label="Special allowance, monthly" name="specialAllowancePaise" type="number" step="0.01" />
                <FormField label="Site allowance, monthly" name="siteAllowancePaise" type="number" step="0.01" />
                <FormField label="Employer PF, monthly" name="employerPfPaise" type="number" step="0.01" />
                <FormField label="Employer ESI, monthly" name="employerEsiPaise" type="number" step="0.01" />
                <FormField label="Reason" name="revisionReason" placeholder="Annual increment 2026" />
                <button class="ncc-btn ncc-btn-primary" type="submit">
                  Save revision
                </button>
              </form>
            </Panel>
          ) : null}
        </div>
      )
    }

    case 'documents': {
      const docs = await q.employeeDocuments(db, employeeId)
      const columns: Column<(typeof docs)[number]>[] = [
        { header: 'Type', cell: (r) => <strong>{titleCase(r.doc_type)}</strong> },
        { header: 'Number', cell: (r) => r.document_no ?? <span class="ncc-muted">-</span> },
        { header: 'Issued', cell: (r) => <DateText value={r.issued_on} /> },
        {
          header: 'Expires',
          cell: (r) => (
            <>
              <DateText value={r.expires_on} />
              {r.expires_on && String(r.expires_on) < today() ? (
                <div class="ncc-badge ncc-badge-danger">expired</div>
              ) : null}
            </>
          ),
        },
        { header: 'File', cell: (r) => r.file_name ?? <span class="ncc-muted">-</span> },
        {
          header: 'Verified',
          cell: (r) =>
            r.verified_on ? (
              <>
                <DateText value={r.verified_on} />
                <div class="ncc-muted">{r.verified_by_name ?? ''}</div>
              </>
            ) : (
              <span class="ncc-muted">Not verified</span>
            ),
        },
      ]

      return (
        <div class="ncc-stack">
          <Panel title="Document register">
            <p class="ncc-hint">
              For an Aadhaar row the number field holds the last four digits only, the same rule the profile follows.
              The scan itself lives in the file store, not in this table.
            </p>
            <DataTable columns={columns} rows={docs} empty="No documents recorded for this employee." />
          </Panel>
          {c.get('perms').has(PERMISSIONS.HR_DOCUMENT_MANAGE) ? (
            <Panel title="Attach a document">
              <Alert tone="warn">
                Attaching needs the shared upload route from spec 2.7, which no module has yet: the CSRF guard skips
                multipart bodies and expects the token in a header an HTML form cannot send. The endpoint behind this
                screen is live and takes a stored file id. The picker arrives with that route.
              </Alert>
            </Panel>
          ) : null}
        </div>
      )
    }

    case 'exit': {
      if (employee.status === 'exited') {
        return (
          <Panel title="Exit recorded">
            <DefinitionList
              rows={[
                ['Date of exit', <DateText value={employee.date_of_exit} />],
                ['Type', employee.exit_type ? titleCase(employee.exit_type) : '-'],
                ['Reason', employee.exit_reason ?? '-'],
                [
                  'Login',
                  employee.login_email ? (
                    <>
                      {employee.login_email} <StatusBadge status={employee.login_status} />
                    </>
                  ) : (
                    <span class="ncc-muted">No login</span>
                  ),
                ],
              ]}
            />
            <p class="ncc-hint">
              The exit deactivated the login and revoked its live sessions in the same transaction as the status
              change. What happened, who did it and whether anything was outstanding is in the audit log.
            </p>
          </Panel>
        )
      }

      const blockers = await q.exitBlockers(db, employeeId)
      const outstanding = q.blockerCount(blockers)

      return (
        <div class="ncc-stack">
          <Panel title="Exit checklist">
            {outstanding === 0 ? (
              <Alert tone="ok">Nothing is outstanding against this employee.</Alert>
            ) : (
              <Alert tone="warn">
                {outstanding} item{outstanding === 1 ? '' : 's'} still sit with this employee. Clear them, or record a
                reason below to complete the exit anyway.
              </Alert>
            )}
            <p class="ncc-hint">
              Two of these five checks match on the name written at a site gate rather than on an id, because that is
              what the schema records for material issues and equipment operators. A store issue booked to "Ramesh"
              against an employee named "Ramesh Kumar" will not appear here, so treat the list as a prompt rather than
              a clearance certificate.
            </p>
            <DataTable
              columns={[
                { header: 'Project', cell: (r: (typeof blockers.assignments)[number]) => `${r.project_code} ${r.project_name}` },
                { header: 'Role', cell: (r: (typeof blockers.assignments)[number]) => r.assignment_role },
              ]}
              rows={blockers.assignments}
              caption="Open project assignments"
              empty="No open project assignment."
            />
            <DataTable
              columns={[
                { header: 'Issue', cell: (r: (typeof blockers.materialIssues)[number]) => r.issue_no },
                { header: 'Project', cell: (r: (typeof blockers.materialIssues)[number]) => r.project_code },
                { header: 'Issued', cell: (r: (typeof blockers.materialIssues)[number]) => <DateText value={r.issued_on} /> },
              ]}
              rows={blockers.materialIssues}
              caption="Material issued in this name"
              empty="No material issued in this name."
            />
            <DataTable
              columns={[
                { header: 'Equipment', cell: (r: (typeof blockers.equipment)[number]) => `${r.code} ${r.name}` },
                { header: 'Project', cell: (r: (typeof blockers.equipment)[number]) => r.project_code ?? '-' },
              ]}
              rows={blockers.equipment}
              caption="Equipment deployed to this operator"
              empty="No equipment deployed in this name."
            />
            <DataTable
              columns={[
                { header: 'Expense', cell: (r: (typeof blockers.expensesRaised)[number]) => r.expense_no },
                { header: 'Status', cell: (r: (typeof blockers.expensesRaised)[number]) => <StatusBadge status={r.status} /> },
                {
                  header: 'Total',
                  numeric: true,
                  cell: (r: (typeof blockers.expensesRaised)[number]) => <Money paise={money(r.total_paise)} />,
                },
              ]}
              rows={blockers.expensesRaised}
              caption="Expenses they raised, not yet approved"
              empty="No expense of theirs is waiting."
            />
            <DataTable
              columns={[
                { header: 'Expense', cell: (r: (typeof blockers.advancesOutstanding)[number]) => r.expense_no },
                { header: 'Status', cell: (r: (typeof blockers.advancesOutstanding)[number]) => <StatusBadge status={r.status} /> },
                {
                  header: 'Net payable',
                  numeric: true,
                  cell: (r: (typeof blockers.advancesOutstanding)[number]) => <Money paise={money(r.net_payable_paise)} />,
                },
                {
                  header: 'Paid',
                  numeric: true,
                  cell: (r: (typeof blockers.advancesOutstanding)[number]) => <Money paise={money(r.paid_paise)} />,
                },
              ]}
              rows={blockers.advancesOutstanding}
              caption="Money owed to or by them"
              empty="Nothing outstanding either way."
            />
          </Panel>
          <Panel title="Complete the exit">
            <form class="ncc-stack" method="post" action={`/api/hr/employees/${employeeId}/exit`}>
              <CsrfInput token={session.csrfToken} />
              <p class="ncc-hint">
                This sets the employee to exited, deactivates any linked login and revokes its live sessions, in one
                transaction. There is no screen that undoes it.
              </p>
              <FormField label="Date of exit" name="dateOfExit" type="date" required value={today()} />
              <FormField label="Exit type" name="exitType" required options={enumOptions(EXIT_TYPES, 'resigned')} />
              <FormField label="Reason" name="exitReason" rows={2} />
              <FormField
                label="Reason for completing with items outstanding"
                name="override"
                rows={2}
                hint="Required only while the checklist above is not clear. Recorded in the audit log."
              />
              <button class="ncc-btn ncc-btn-danger" type="submit">
                Complete exit
              </button>
            </form>
          </Panel>
        </div>
      )
    }
  }
}

/* Mutations (spec 6.6 route table) --------------------------------------- */

/**
 * Runs a write and reports the outcome as a banner on the tab the form came
 * from, the same helper CRM uses.
 *
 * It matters most for the exit: a blocked exit throws with a count of what is
 * outstanding, and the person running it needs to read that above the form
 * they just filled in, not on an error page with a back button.
 */
async function guard(c: Ctx, back: string, run: () => Promise<string>) {
  try {
    return okRedirect(c, back, await run())
  } catch (err) {
    if (!isAppError(err)) throw err
    return errRedirect(c, back, err.message)
  }
}

hr.post(
  '/api/hr/employees/:employeeId/compensation',
  requireAllPermissions(PERMISSIONS.HR_PAYROLL_VIEW, PERMISSIONS.HR_EMPLOYEE_MANAGE),
  async (c) => {
    const employeeId = idParam(c)
    const back = `/app/hr/employees/${employeeId}?tab=compensation`
    const parsed = compensationSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

    return guard(c, back, async () => {
      await svc.reviseCompensation(c.get('db'), actorOf(c), employeeId, parsed.data)
      return `Compensation revised with effect from ${parsed.data.effectiveFrom}.`
    })
  }
)

hr.post(
  '/api/hr/employees/:employeeId/documents',
  requirePermission(PERMISSIONS.HR_DOCUMENT_MANAGE),
  async (c) => {
    const employeeId = idParam(c)
    const back = `/app/hr/employees/${employeeId}?tab=documents`
    const parsed = documentSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

    return guard(c, back, async () => {
      await svc.addEmployeeDocument(c.get('db'), actorOf(c), employeeId, parsed.data)
      return `${titleCase(parsed.data.docType)} recorded.`
    })
  }
)

hr.post('/api/hr/employees/:employeeId/exit', requirePermission(PERMISSIONS.HR_EMPLOYEE_MANAGE), async (c) => {
  const employeeId = idParam(c)
  const back = `/app/hr/employees/${employeeId}?tab=exit`
  const parsed = exitSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  // Not the shared guard: a refused exit has to come back to the checklist it
  // was refused by, and a completed one goes to the profile that now says
  // exited.
  try {
    const result = await svc.runExit(c.get('db'), actorOf(c), employeeId, parsed.data)
    return okRedirect(
      c,
      `/app/hr/employees/${employeeId}`,
      result.overridden
        ? 'Exit completed with items still outstanding. The reason is in the audit log.'
        : 'Exit completed. Any linked login is deactivated and its sessions revoked.'
    )
  } catch (err) {
    if (!isAppError(err)) throw err
    return errRedirect(c, back, err.message)
  }
})

/* Attendance (spec 6.6 rules 1 and 4) ------------------------------------- */

/**
 * The one-or-two letter marks a muster roll uses.
 *
 * A 31-column grid cannot carry the word "on_duty_travel" in a cell, and the
 * codes are the ones the paper register already uses, so a supervisor reading
 * the screen is reading a form they know. The legend is rendered under the grid
 * rather than assumed.
 */
const MARKS: Record<string, { code: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }> = {
  present: { code: 'P', tone: 'ok' },
  absent: { code: 'A', tone: 'danger' },
  half_day: { code: '½', tone: 'warn' },
  weekly_off: { code: 'WO', tone: 'muted' },
  holiday: { code: 'H', tone: 'muted' },
  paid_leave: { code: 'PL', tone: 'warn' },
  unpaid_leave: { code: 'LWP', tone: 'danger' },
  on_duty_travel: { code: 'OD', tone: 'ok' },
  comp_off: { code: 'CO', tone: 'muted' },
}

function Mark(props: { status: string | undefined }) {
  if (!props.status) return <span class="ncc-muted">·</span>
  const m = MARKS[props.status]
  if (!m) return <span class="ncc-muted">{props.status}</span>
  return (
    <span class={`ncc-badge ncc-badge-${m.tone}`} title={titleCase(props.status)}>
      {m.code}
    </span>
  )
}

/** A 'YYYY-MM' from the query string, or the current month. */
function monthParam(c: Ctx): string {
  const raw = queryParam(c, 'month') ?? ''
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : monthOf(today())
}

/** A 'YYYY-MM-DD' from the query string, or today. */
function dateParam(c: Ctx, name: string): string {
  const raw = queryParam(c, name) ?? ''
  return isValidIsoDate(raw) ? raw : today()
}

/**
 * The entry grid for one day (spec 6.6 rule 1: one post per day per project).
 *
 * The posted date is a hidden field and the date picker is a separate GET, so
 * the prefill and the date being written can never disagree -- changing the date
 * in place would submit yesterday's marks against today.
 *
 * Three kinds of row carry no inputs at all rather than a disabled select:
 * outside the employment dates, already covered by approved leave, and already
 * approved. `recordAttendanceBulk` refuses all three, and omitting the whole row
 * keeps the parallel arrays aligned -- every remaining row contributes exactly
 * one entry to each of the six.
 */
function AttendanceEntry(props: {
  csrf: string
  date: string
  month: string
  projectId: number | undefined
  locked: boolean
  roster: q.RosterRow[]
  recorded: q.AttendanceCell[]
  leave: q.ApprovedLeaveDay[]
  projects: Array<{ id: number; code: string; name: string }>
}) {
  const recordedBy = new Map(props.recorded.map((r) => [Number(r.employee_id), r]))
  const leaveBy = new Map(props.leave.map((r) => [r.employee_id, r]))
  const future = props.date > today()

  const picker = (
    <form class="ncc-toolbar" method="get" action="/app/hr/attendance">
      <input type="hidden" name="month" value={props.month} />
      {props.projectId ? <input type="hidden" name="projectId" value={String(props.projectId)} /> : null}
      <FormField label="Entry date" name="date" type="date" value={props.date} max={today()} />
      <button class="ncc-btn" type="submit">
        Load that day
      </button>
    </form>
  )

  if (props.locked) {
    return (
      <Panel title="Mark a day">
        {picker}
        <Alert tone="warn">
          {formatMonth(monthOf(props.date))} is closed, so no row in it can be added or changed. That needs{' '}
          <code>finance.period_close</code>.
        </Alert>
      </Panel>
    )
  }
  if (future) {
    return (
      <Panel title="Mark a day">
        {picker}
        <Alert tone="warn">{formatDate(props.date)} has not happened yet. Attendance is recorded for a day that has passed.</Alert>
      </Panel>
    )
  }

  const rows = props.roster.map((r) => {
    const outside =
      props.date < String(r.date_of_joining) ||
      (r.date_of_exit !== null && props.date > String(r.date_of_exit))
    return { employee: r, outside, prior: recordedBy.get(Number(r.id)), leave: leaveBy.get(Number(r.id)) }
  })
  const editable = rows.filter((r) => !r.outside && !r.leave && !(r.prior && r.prior.approved_at !== null))
  const isEditable = new Set(editable)

  const columns: Column<(typeof rows)[number]>[] = [
    {
      header: 'Employee',
      cell: (r) => (
        <>
          <strong>{r.employee.full_name}</strong>
          <div class="ncc-muted">
            {r.employee.employee_code}
            {r.employee.designation_name ? ` · ${r.employee.designation_name}` : ''}
          </div>
        </>
      ),
    },
    {
      header: 'Status',
      cell: (r) => {
        if (r.outside) {
          return (
            <span class="ncc-muted">
              {r.employee.date_of_exit !== null && props.date > String(r.employee.date_of_exit)
                ? `Left ${formatDate(r.employee.date_of_exit)}`
                : `Joins ${formatDate(r.employee.date_of_joining)}`}
            </span>
          )
        }
        if (r.leave) {
          return (
            <>
              <Mark status={r.prior?.status} />{' '}
              <span class="ncc-muted">
                on {r.leave.type_code}, request {r.leave.request_id}
              </span>
            </>
          )
        }
        if (r.prior && r.prior.approved_at !== null) {
          return (
            <>
              <Mark status={r.prior.status} /> <span class="ncc-badge ncc-badge-muted">approved</span>
            </>
          )
        }
        return (
          <>
            <input type="hidden" name="employeeId" value={String(r.employee.id)} />
            <select name="status" aria-label={`Status for ${r.employee.full_name}`}>
              <option value="" selected={!r.prior}>
                not marked
              </option>
              {ATTENDANCE_STATUSES.map((s) => (
                <option value={s} selected={r.prior?.status === s}>
                  {MARKS[s]?.code} {titleCase(s)}
                </option>
              ))}
            </select>
          </>
        )
      },
    },
    {
      header: 'In',
      cell: (r) =>
        isEditable.has(r) ? (
          <input
            type="time"
            name="inTime"
            value={(r.prior?.in_time ?? '').slice(0, 5)}
            aria-label={`In time for ${r.employee.full_name}`}
          />
        ) : null,
    },
    {
      header: 'Out',
      cell: (r) =>
        isEditable.has(r) ? (
          <input
            type="time"
            name="outTime"
            value={(r.prior?.out_time ?? '').slice(0, 5)}
            aria-label={`Out time for ${r.employee.full_name}`}
          />
        ) : null,
    },
    {
      header: 'OT hrs',
      numeric: true,
      cell: (r) =>
        isEditable.has(r) ? (
          <input
            type="number"
            name="overtimeHours"
            step="0.5"
            min="0"
            max="24"
            style="max-width:5.5rem"
            value={r.prior ? String(Number(r.prior.overtime_hours)) : ''}
            aria-label={`Overtime for ${r.employee.full_name}`}
          />
        ) : null,
    },
    {
      header: 'Remarks',
      cell: (r) =>
        isEditable.has(r) ? (
          <input
            type="text"
            name="remarks"
            maxlength={255}
            value={r.prior?.remarks ?? ''}
            aria-label={`Remarks for ${r.employee.full_name}`}
          />
        ) : null,
    },
  ]

  return (
    <Panel title={`Mark ${formatDate(props.date)}`}>
      {picker}
      <form method="post" action="/api/hr/attendance/bulk">
        <CsrfInput token={props.csrf} />
        <input type="hidden" name="attendanceDate" value={props.date} />
        <div class="ncc-toolbar">
          <FormField
            label="Charge the day to"
            name="projectId"
            options={[
              { value: '', label: 'Overhead (no project)', selected: !props.projectId },
              ...props.projects.map((p) => ({
                value: String(p.id),
                label: `${p.code} ${p.name}`,
                selected: Number(p.id) === props.projectId,
              })),
            ]}
            hint="One project for the whole post. A day split across two sites is two posts."
          />
        </div>
        <DataTable
          columns={columns}
          rows={rows}
          empty="Nobody was on the books on this date."
          caption="Leave a status as 'not marked' to skip that person. Only the rows you set are written."
        />
        {editable.length > 0 ? (
          <p style="margin-top:1rem">
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Post {editable.length} row{editable.length === 1 ? '' : 's'}
            </button>
          </p>
        ) : (
          <Alert tone="warn">
            Nothing on this date can be edited from here: every row is outside its employment dates, covered by
            approved leave, or already approved.
          </Alert>
        )}
      </form>
    </Panel>
  )
}

/**
 * The attendance screen: a read grid for the month, and an entry grid for a day.
 *
 * Guarded by an OR rather than by the spec's `hr.employee_view` alone. The 002
 * role seed grants the three permissions to different roles and the sidebar
 * shows this item to holders of `hr.attendance_record` or
 * `hr.attendance_approve`, so a guard on `hr.employee_view` alone would 403 a
 * user who can see the link -- which breaks the repo's navigation invariant.
 * The mismatch itself is a 4.3 matrix question and is in the 8.1 list.
 *
 * The entry date is a query parameter, not a client-side control, so the grid
 * can be prefilled with what is already recorded for that day. Changing the
 * date reloads. That is one round trip per correction and no Alpine: the spec's
 * keyboard-entry matrix is not built, and is reported as not built.
 */
hr.get(
  '/app/hr/attendance',
  requirePermission(
    PERMISSIONS.HR_EMPLOYEE_VIEW,
    PERMISSIONS.HR_ATTENDANCE_RECORD,
    PERMISSIONS.HR_ATTENDANCE_APPROVE
  ),
  async (c) => {
    const db = c.get('db')
    const session = c.get('session')!
    const perms = c.get('perms')
    const canRecord = perms.has(PERMISSIONS.HR_ATTENDANCE_RECORD)
    const canApprove = perms.has(PERMISSIONS.HR_ATTENDANCE_APPROVE)
    const canOverride = perms.has(PERMISSIONS.FINANCE_PERIOD_CLOSE)

    const month = monthParam(c)
    const entryDate = dateParam(c, 'date')
    const entryMonth = monthOf(entryDate)
    const projectId = Number(queryParam(c, 'projectId') ?? '') || undefined

    const [roster, cells, state, projects, entryRoster, entryCells, entryLeave] = await Promise.all([
      q.attendanceRoster(db, month),
      q.attendanceMonth(db, month, { projectId }),
      q.attendanceMonthState(db, month),
      q.projectOptions(db),
      entryMonth === month ? Promise.resolve(null) : q.attendanceRoster(db, entryMonth),
      canRecord ? q.attendanceOn(db, entryDate) : Promise.resolve([]),
      canRecord ? q.approvedLeaveOn(db, entryDate) : Promise.resolve([]),
    ])
    const entryState =
      entryMonth === month ? state : await q.attendanceMonthState(db, entryMonth)

    const bounds = monthBounds(month)
    const days = datesBetween(bounds.start, bounds.end)
    const byKey = new Map(cells.map((r) => [`${r.employee_id}|${r.attendance_date}`, r]))

    const gridColumns: Column<q.RosterRow>[] = [
      {
        header: 'Employee',
        cell: (r) => (
          <>
            <a href={`/app/hr/employees/${r.id}`}>{r.full_name}</a>
            <div class="ncc-muted">{r.employee_code}</div>
          </>
        ),
      },
      ...days.map(
        (date): Column<q.RosterRow> => ({
          header: date.slice(8),
          cell: (r) => {
            const outside =
              date < String(r.date_of_joining) ||
              (r.date_of_exit !== null && date > String(r.date_of_exit))
            if (outside) return <span class="ncc-muted" title="Not employed on this date">—</span>
            const cell = byKey.get(`${r.id}|${date}`)
            return (
              <span title={cell?.project_code ? `Charged to ${cell.project_code}` : undefined}>
                <Mark status={cell?.status} />
              </span>
            )
          },
        })
      ),
    ]

    const marked = roster.reduce(
      (sum, r) => sum + days.filter((d) => byKey.has(`${r.id}|${d}`)).length,
      0
    )

    return page(
      c,
      {
        title: 'Attendance',
        path: '/app/hr/attendance',
        subtitle: `${formatMonth(month)} — ${roster.length} on the roster, ${marked} day${marked === 1 ? '' : 's'} marked`,
      },
      <>
        {banner(c)}
        <div class="ncc-kpi-row">
          <KpiCard label="Rows this month" value={String(state.total)} hint={formatMonth(month)} />
          <KpiCard label="Approved" value={String(state.approved)} hint="Carry approved_at" />
          <KpiCard
            label="Awaiting approval"
            value={String(state.total - state.approved)}
            hint={state.locked ? 'Month is closed' : 'Month is open'}
          />
          <KpiCard label="On the roster" value={String(roster.length)} hint="Employed at any point in the month" />
        </div>

        {state.locked ? (
          <Alert tone="warn">
            {formatMonth(month)} is closed: {state.approved} of {state.total} rows are approved. Entry and
            corrections for this month need <code>finance.period_close</code>, because rule 4 exists to stop a
            payroll figure changing after the payment is made.
            {canOverride ? ' You hold it, so your posts will go through and be audited as an override.' : ''}
          </Alert>
        ) : null}

        <form class="ncc-toolbar" method="get" action="/app/hr/attendance">
          <FormField label="Month" name="month" type="month" value={month} />
          <FormField
            label="Project"
            name="projectId"
            options={[
              { value: '', label: 'All projects and overhead', selected: !projectId },
              ...projects.map((p) => ({
                value: String(p.id),
                label: `${p.code} ${p.name}`,
                selected: Number(p.id) === projectId,
              })),
            ]}
          />
          <input type="hidden" name="date" value={entryDate} />
          <button class="ncc-btn" type="submit">
            Show
          </button>
          <a class="ncc-btn" href={`/app/hr/reports/muster?month=${month}`}>
            Muster roll
          </a>
        </form>

        <Panel title={`Month grid — ${formatMonth(month)}`}>
          <DataTable
            columns={gridColumns}
            rows={roster}
            empty="Nobody was on the books in this month."
            caption={
              projectId
                ? 'Filtered to one project, so a day charged elsewhere shows as unmarked.'
                : undefined
            }
          />
          <p class="ncc-hint">
            P present · A absent · ½ half day · WO weekly off · H holiday · PL paid leave · LWP unpaid ·
            OD on duty travel · CO comp off · · not marked · — not employed
          </p>
        </Panel>

        {canApprove ? (
          <Panel title="Close the month">
            <form class="ncc-stack" method="post" action="/api/hr/attendance/approve">
              <CsrfInput token={session.csrfToken} />
              <p class="ncc-hint">
                Stamps <code>approved_at</code> on every unapproved row in the month, for every employee and
                every project. After that the month rejects entry and edits unless{' '}
                <code>finance.period_close</code> is held. There is no screen that reopens it.
              </p>
              <FormField label="Month" name="month" type="month" required value={month} />
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Approve {state.total - state.approved} row
                {state.total - state.approved === 1 ? '' : 's'} and close
              </button>
            </form>
          </Panel>
        ) : null}

        {canRecord ? (
          <AttendanceEntry
            csrf={session.csrfToken}
            date={entryDate}
            month={month}
            projectId={projectId}
            locked={entryState.locked && !canOverride}
            roster={entryRoster ?? roster}
            recorded={entryCells}
            leave={entryLeave}
            projects={projects}
          />
        ) : null}
      </>
    )
  }
)

hr.post('/api/hr/attendance/bulk', requirePermission(PERMISSIONS.HR_ATTENDANCE_RECORD), async (c) => {
  const body = await readBody(c)
  const parsed = attendanceBulkSchema.safeParse(body)
  // The date is echoed back into the redirect so a refused post returns to the
  // grid for the day it was refused on, prefilled, rather than to today.
  const rawDate = typeof body['attendanceDate'] === 'string' ? body['attendanceDate'] : today()
  const date = isValidIsoDate(rawDate) ? rawDate : today()
  const back = `/app/hr/attendance?month=${monthOf(date)}&date=${date}`
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  return guard(c, `/app/hr/attendance?month=${monthOf(parsed.data.attendanceDate)}&date=${parsed.data.attendanceDate}`, async () => {
    const result = await svc.recordAttendanceBulk(c.get('db'), actorOf(c), parsed.data, {
      canOverridePeriod: c.get('perms').has(PERMISSIONS.FINANCE_PERIOD_CLOSE),
    })
    const parts = [
      result.inserted > 0 ? `${result.inserted} recorded` : null,
      result.updated > 0 ? `${result.updated} corrected` : null,
    ].filter((p): p is string => p !== null)
    return `${formatDate(parsed.data.attendanceDate)}: ${parts.join(', ')}.`
  })
})

hr.post('/api/hr/attendance/approve', requirePermission(PERMISSIONS.HR_ATTENDANCE_APPROVE), async (c) => {
  const parsed = attendanceApproveSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/hr/attendance', firstError(parsed.error))
  const back = `/app/hr/attendance?month=${parsed.data.month}`

  return guard(c, back, async () => {
    const result = await svc.approveAttendanceMonth(c.get('db'), actorOf(c), parsed.data.month)
    return `${formatMonth(parsed.data.month)} closed. ${result.approved} row${result.approved === 1 ? '' : 's'} approved${
      result.alreadyApproved > 0 ? `, ${result.alreadyApproved} already were` : ''
    }. Corrections from here need finance.period_close.`
  })
})

/* Leave (spec 6.6 route table: own / hr.leave_approve) -------------------- */

type LeaveType = Awaited<ReturnType<typeof q.leaveTypeOptions>>[number]
type EmployeeOption = Awaited<ReturnType<typeof q.managerOptions>>[number]

/**
 * One pending request with both outcomes on one form.
 *
 * Two submit buttons sharing the name `decision` is how an HTML form offers a
 * choice without JavaScript: only the clicked button posts. The reject reason
 * sits in the same form because `leaveDecisionSchema` requires it for a
 * rejection -- an employee escalates a rejection with no reason attached, so the
 * field is refused at the boundary rather than left nullable.
 */
function LeaveDecision(props: { request: q.LeaveRequestRow; csrf: string }) {
  const r = props.request
  return (
    <form class="ncc-card ncc-stack" method="post" action={`/api/hr/leave/${r.id}/approve`}>
      <CsrfInput token={props.csrf} />
      <DefinitionList
        rows={[
          [
            'Employee',
            <a href={`/app/hr/employees/${r.employee_id}`}>
              {r.employee_name} <span class="ncc-muted">{r.employee_code}</span>
            </a>,
          ],
          ['Type', `${r.type_code} ${r.type_name} (${Number(r.is_paid) === 1 ? 'paid' : 'unpaid'})`],
          [
            'Dates',
            <>
              <DateText value={r.from_date} />
              {r.from_date === r.to_date ? null : (
                <>
                  {' to '}
                  <DateText value={r.to_date} />
                </>
              )}
              {` — ${Number(r.days)} day${Number(r.days) === 1 ? '' : 's'}`}
            </>,
          ],
          ['Reason', r.reason ?? '-'],
          ['Handover to', r.handover_name ?? '-'],
          ...(Number(r.requires_document) === 1
            ? ([
                [
                  'Document',
                  <span class="ncc-badge ncc-badge-warn">
                    {r.type_code} normally needs one; there is no upload route yet
                  </span>,
                ],
              ] as Array<[string, ReturnType<typeof String>]>)
            : []),
        ]}
      />
      <p class="ncc-hint">
        Approving writes the attendance rows for every working day in the range and adds the days to the balance,
        in one transaction. If a month in the range is already closed, the approval is refused rather than
        partly applied.
      </p>
      <FormField
        label="Reason, if you are rejecting"
        name="rejectReason"
        rows={2}
        hint="Required for a rejection. The employee sees it."
      />
      <div class="ncc-row">
        <button class="ncc-btn ncc-btn-primary" type="submit" name="decision" value="approve">
          Approve
        </button>
        <button class="ncc-btn ncc-btn-danger" type="submit" name="decision" value="reject">
          Reject
        </button>
      </div>
    </form>
  )
}

/**
 * The raise form.
 *
 * `employeeId` is offered only to a holder of `hr.leave_approve`. The spec says
 * "any employee with a login raises their own", which leaves no route for site
 * staff who have no login at all, and HR entering it for them is the only way
 * those days reach `attendance` and therefore 6.8's staff cost. Raising on
 * behalf of someone also waives `min_notice_days`, and both facts are audited.
 *
 * There is no file field. `leave_types.requires_document` is set on SL, MAT and
 * PAT, but no upload route exists yet (DECISIONS 15.1) so the requirement is
 * surfaced here and not enforced -- enforcing it would make the three most
 * common types unrequestable.
 */
function LeaveRequestForm(props: {
  csrf: string
  leaveTypes: LeaveType[]
  employees: EmployeeOption[]
  canRaiseForOthers: boolean
  selfEmployeeId: number | null
}) {
  const needsDoc = props.leaveTypes.filter((t) => Number(t.requires_document) === 1).map((t) => t.code)
  if (props.selfEmployeeId === null && !props.canRaiseForOthers) {
    return (
      <Alert tone="warn">
        Raising leave needs a login linked to an employee record. Ask HR to link yours.
      </Alert>
    )
  }
  return (
    <form class="ncc-stack" method="post" action="/app/hr/leave">
      <CsrfInput token={props.csrf} />
      {props.canRaiseForOthers ? (
        <FormField
          label="For"
          name="employeeId"
          options={[
            {
              value: '',
              label: props.selfEmployeeId === null ? 'Choose an employee' : 'Yourself',
              selected: true,
            },
            ...props.employees.map((e) => ({
              value: String(e.id),
              label: `${e.employee_code} ${e.full_name}`,
            })),
          ]}
          hint="Raising it for someone else waives the notice period and is recorded in the audit log."
        />
      ) : null}
      <FormField
        label="Leave type"
        name="leaveTypeId"
        required
        options={[
          { value: '', label: 'Choose a type', selected: true },
          ...props.leaveTypes.map((t) => ({
            value: String(t.id),
            label: `${t.code} ${t.name} — ${Number(t.is_paid) === 1 ? 'paid' : 'unpaid'}, ${Number(
              t.min_notice_days
            )} day${Number(t.min_notice_days) === 1 ? '' : 's'} notice`,
          })),
        ]}
      />
      <div class="ncc-grid ncc-grid--form">
        <FormField label="From" name="fromDate" type="date" required />
        <FormField label="To" name="toDate" type="date" required />
      </div>
      <label class="ncc-field">
        <span>
          <input type="checkbox" name="halfDay" value="on" style="width:auto;margin-right:.45rem" />
          Half day
        </span>
        <span class="ncc-hint">
          A half day is a single date, so both dates have to be the same. It is recorded as ½ on the muster roll
          and as 0.5 against the balance.
        </span>
      </label>
      <FormField label="Reason" name="reason" rows={2} />
      <FormField
        label="Handover to"
        name="handoverToEmployeeId"
        options={[
          { value: '', label: 'Nobody', selected: true },
          ...props.employees.map((e) => ({ value: String(e.id), label: `${e.employee_code} ${e.full_name}` })),
        ]}
      />
      <p class="ncc-hint">
        Days are counted excluding Sundays, which are the weekly off. Public holidays are counted, because there
        is no holiday calendar in the system yet — so a month with a festival in it counts one day more than the
        employee actually took.
        {needsDoc.length > 0
          ? ` ${needsDoc.join(', ')} normally need a supporting document; there is no upload route yet, so attach it outside the system and note it in the reason.`
          : ''}
      </p>
      <button class="ncc-btn ncc-btn-primary" type="submit">
        Raise request
      </button>
    </form>
  )
}

/**
 * The leave screen, one route serving two readers.
 *
 * No `requirePermission`, because the spec's permission for this row is "own /
 * `hr.leave_approve`" and "own" means any authenticated employee. `/app/*` is
 * already behind `requireAuth`, so an unguarded route here is authenticated-only
 * -- which is how this codebase expresses "own" (see the note in src/app.ts).
 *
 * What the reader sees is decided by `hr.leave_approve`, and by the query rather
 * than by the template: an approver gets every request and the pending queue, a
 * requester gets `listLeaveRequests(db, { employeeId })` and cannot widen it with
 * a query parameter because the route never reads one for it.
 *
 * A login with no linked employee record gets the explanation rather than an
 * empty table. `users.employee_id` is the only link and 14.8 already records
 * that it is one of two unreconciled directions.
 */
hr.get('/app/hr/leave', async (c) => {
  const db = c.get('db')
  const session = c.get('session')!
  const user = currentUser(c)
  const selfEmployeeId = user.employeeId
  const canApprove = c.get('perms').has(PERMISSIONS.HR_LEAVE_APPROVE)
  const statusFilter = queryParam(c, 'status')
  const status = (LEAVE_REQUEST_STATUSES as readonly string[]).includes(statusFilter ?? '')
    ? statusFilter
    : undefined

  const fy = financialYear(today())
  const [requests, pending, leaveTypes, balances, managers] = await Promise.all([
    q.listLeaveRequests(db, {
      employeeId: canApprove ? undefined : (selfEmployeeId ?? -1),
      status,
    }),
    canApprove && selfEmployeeId !== null
      ? q.listLeaveRequests(db, { status: 'pending', pendingFor: selfEmployeeId })
      : canApprove
        ? q.listLeaveRequests(db, { status: 'pending' })
        : Promise.resolve([]),
    q.leaveTypeOptions(db),
    selfEmployeeId !== null ? q.leaveBalances(db, selfEmployeeId, fy) : Promise.resolve([]),
    canApprove ? q.managerOptions(db) : Promise.resolve([]),
  ])

  const columns: Column<q.LeaveRequestRow>[] = [
    ...(canApprove
      ? [
          {
            header: 'Employee',
            cell: (r: q.LeaveRequestRow) => (
              <>
                <a href={`/app/hr/employees/${r.employee_id}`}>{r.employee_name}</a>
                <div class="ncc-muted">{r.employee_code}</div>
              </>
            ),
          } satisfies Column<q.LeaveRequestRow>,
        ]
      : []),
    {
      header: 'Type',
      cell: (r) => (
        <>
          {r.type_code}
          <div class="ncc-muted">{Number(r.is_paid) === 1 ? 'paid' : 'unpaid'}</div>
        </>
      ),
    },
    {
      header: 'Dates',
      cell: (r) => (
        <>
          <DateText value={r.from_date} />
          {r.from_date === r.to_date ? null : (
            <>
              {' to '}
              <DateText value={r.to_date} />
            </>
          )}
        </>
      ),
    },
    { header: 'Days', numeric: true, cell: (r) => String(Number(r.days)) },
    { header: 'Reason', cell: (r) => r.reason ?? <span class="ncc-muted">-</span> },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      header: 'Outcome',
      cell: (r) =>
        r.status === 'rejected' ? (
          <>
            <div>{r.reject_reason}</div>
            <div class="ncc-muted">{r.decided_by_name ?? ''}</div>
          </>
        ) : r.status === 'approved' ? (
          <span class="ncc-muted">
            {r.decided_by_name ?? ''} <DateText value={r.approved_at} />
          </span>
        ) : r.status === 'pending' && Number(r.employee_id) === selfEmployeeId ? (
          <form method="post" action={`/api/hr/leave/${r.id}/withdraw`}>
            <CsrfInput token={session.csrfToken} />
            <button class="ncc-btn" type="submit">
              Withdraw
            </button>
          </form>
        ) : (
          <span class="ncc-muted">-</span>
        ),
    },
  ]

  const balanceColumns: Column<q.LeaveBalanceRow>[] = [
    { header: 'Type', cell: (r) => `${r.type_code} ${r.type_name}` },
    {
      header: 'Quota',
      numeric: true,
      cell: (r) =>
        r.annual_quota === null ? <span class="ncc-muted">not set</span> : String(r.annual_quota),
    },
    { header: 'Opening', numeric: true, cell: (r) => String(r.opening) },
    { header: 'Availed', numeric: true, cell: (r) => String(r.availed) },
    { header: 'Balance', numeric: true, cell: (r) => String(r.balance) },
  ]

  return page(
    c,
    {
      title: 'Leave',
      path: '/app/hr/leave',
      subtitle: canApprove
        ? `${pending.length} awaiting your decision, ${requests.length} in all`
        : `${requests.length} of your request${requests.length === 1 ? '' : 's'}`,
    },
    <>
      {banner(c)}

      {selfEmployeeId === null ? (
        <Alert tone="warn">
          This login is not linked to an employee record, so it cannot raise leave for itself.{' '}
          {canApprove
            ? 'You can still decide other people’s requests and raise leave on their behalf.'
            : 'Ask HR to link the login to your employee record.'}
        </Alert>
      ) : null}

      {canApprove && pending.length > 0 ? (
        <Panel title={`Awaiting your decision (${pending.length})`}>
          <p class="ncc-hint">
            Your own request is not in this queue. Leave is approved against the employee record, so a request
            filed for you cannot be decided by you whichever login you use.
          </p>
          <div class="ncc-stack">
            {pending.map((r) => (
              <LeaveDecision request={r} csrf={session.csrfToken} />
            ))}
          </div>
        </Panel>
      ) : null}

      {selfEmployeeId !== null ? (
        <Panel title={`Your balances, FY ${fy}`}>
          <DataTable columns={balanceColumns} rows={balances} empty="No leave types are active." />
          <p class="ncc-hint">
            Balances are tracked, not enforced: every quota in the seed is unset pending the owner&rsquo;s figures,
            so a request is never refused for want of balance. A negative balance is a fact for HR to look at.
          </p>
        </Panel>
      ) : null}

      <Panel title="Raise a request">
        <LeaveRequestForm
          csrf={session.csrfToken}
          leaveTypes={leaveTypes}
          canRaiseForOthers={canApprove}
          employees={managers}
          selfEmployeeId={selfEmployeeId}
        />
      </Panel>

      <Panel title={canApprove ? 'All requests' : 'Your requests'}>
        <form class="ncc-toolbar" method="get" action="/app/hr/leave">
          <FormField
            label="Status"
            name="status"
            options={[
              { value: '', label: 'Any status', selected: !status },
              ...LEAVE_REQUEST_STATUSES.map((s) => ({
                value: s,
                label: titleCase(s),
                selected: s === status,
              })),
            ]}
          />
          <button class="ncc-btn" type="submit">
            Filter
          </button>
        </form>
        <DataTable columns={columns} rows={requests} empty="No leave requests to show." />
      </Panel>
    </>
  )
})

/**
 * Raising a request. POST to `/app/hr/leave`, which is the spec's own path for
 * this row -- unlike the compensation and stage rows it names a verb an HTML
 * form can actually send, so there is nothing to reconcile here.
 */
hr.post('/app/hr/leave', async (c) => {
  const parsed = leaveRequestSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/hr/leave', firstError(parsed.error))

  return guard(c, '/app/hr/leave', async () => {
    const id = await svc.requestLeave(c.get('db'), actorOf(c), parsed.data, {
      selfEmployeeId: currentUser(c).employeeId,
      canRaiseForOthers: c.get('perms').has(PERMISSIONS.HR_LEAVE_APPROVE),
    })
    return `Leave request ${id} raised. It shows as pending until somebody holding hr.leave_approve decides it.`
  })
})

hr.post('/api/hr/leave/:id/approve', requirePermission(PERMISSIONS.HR_LEAVE_APPROVE), async (c) => {
  const id = idParam(c, 'id')
  const parsed = leaveDecisionSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/hr/leave', firstError(parsed.error))

  return guard(c, '/app/hr/leave', async () => {
    const result = await svc.decideLeave(c.get('db'), actorOf(c), id, parsed.data, {
      approverEmployeeId: currentUser(c).employeeId,
      canOverridePeriod: c.get('perms').has(PERMISSIONS.FINANCE_PERIOD_CLOSE),
    })
    if (result.decision === 'reject') {
      return `Request ${id} for ${result.employeeName} rejected. The reason is on the request.`
    }
    return `Request ${id} for ${result.employeeName} approved: ${result.attendanceRowsWritten} attendance row${
      result.attendanceRowsWritten === 1 ? '' : 's'
    } written, ${result.days} day${result.days === 1 ? '' : 's'} against the FY ${result.financialYear} balance, now ${result.balanceAfter}.`
  })
})

/**
 * Withdrawing your own pending request.
 *
 * Not in the 6.6 route table, but `leave_requests.status` carries a `withdrawn`
 * member that nothing else could write, and a request raised for the wrong week
 * otherwise sits in the approver's queue forever. Unguarded for the same reason
 * the GET is: the service checks the row is yours and is pending.
 */
hr.post('/api/hr/leave/:id/withdraw', async (c) => {
  const id = idParam(c, 'id')
  return guard(c, '/app/hr/leave', async () => {
    await svc.withdrawLeave(c.get('db'), actorOf(c), id, { selfEmployeeId: currentUser(c).employeeId })
    return `Request ${id} withdrawn.`
  })
})

/* The muster roll (spec 6.6 route table) ---------------------------------- */

/**
 * The statutory muster roll for a month.
 *
 * Form-shaped rather than dashboard-shaped: the columns are the ones the
 * register wants beside the daily marks (father's or husband's name, sex,
 * designation, date of joining), and the totals are counted from `attendance`
 * rather than typed. It is a read screen with no filter but the month, because
 * a muster roll for part of a workforce is not a muster roll.
 *
 * `approved` is shown on the page, unhidden: an unapproved month is a draft
 * register and printing it as final is the mistake this line prevents.
 */
hr.get('/app/hr/reports/muster', requirePermission(PERMISSIONS.HR_EMPLOYEE_VIEW), async (c) => {
  const db = c.get('db')
  const month = monthParam(c)
  const [roster, cells, state] = await Promise.all([
    q.attendanceRoster(db, month),
    q.attendanceMonth(db, month),
    q.attendanceMonthState(db, month),
  ])

  const bounds = monthBounds(month)
  const days = datesBetween(bounds.start, bounds.end)
  const byKey = new Map(cells.map((r) => [`${r.employee_id}|${r.attendance_date}`, r]))

  const rows = roster.map((r) => {
    const own = days.map((d) => byKey.get(`${r.id}|${d}`))
    const count = (test: (s: string) => boolean) =>
      own.filter((cell) => cell !== undefined && test(cell.status)).length
    return {
      employee: r,
      // A half day is half a day paid, which is the whole point of the status:
      // counting it as one would overstate the register against the payroll.
      payable:
        count((s) => s === 'present' || s === 'on_duty_travel' || s === 'comp_off') +
        count((s) => s === 'paid_leave') +
        count((s) => s === 'half_day') * 0.5,
      absent: count((s) => s === 'absent' || s === 'unpaid_leave'),
      overtime: own.reduce((sum, cell) => sum + Number(cell?.overtime_hours ?? 0), 0),
      marked: own.filter((cell) => cell !== undefined).length,
    }
  })

  const columns: Column<(typeof rows)[number]>[] = [
    {
      header: 'Employee',
      cell: (r) => (
        <>
          <strong>{r.employee.full_name}</strong>
          <div class="ncc-muted">
            {r.employee.employee_code}
            {r.employee.designation_name ? ` · ${r.employee.designation_name}` : ''}
          </div>
        </>
      ),
    },
    {
      header: 'Father / spouse',
      cell: (r) => r.employee.father_or_spouse_name ?? <span class="ncc-muted">not recorded</span>,
    },
    { header: 'Sex', cell: (r) => (r.employee.gender ? titleCase(r.employee.gender) : '-') },
    { header: 'Joined', cell: (r) => <DateText value={r.employee.date_of_joining} /> },
    ...days.map(
      (date): Column<(typeof rows)[number]> => ({
        header: date.slice(8),
        cell: (r) => {
          const outside =
            date < String(r.employee.date_of_joining) ||
            (r.employee.date_of_exit !== null && date > String(r.employee.date_of_exit))
          if (outside) return <span class="ncc-muted">—</span>
          return <Mark status={byKey.get(`${r.employee.id}|${date}`)?.status} />
        },
      })
    ),
    { header: 'Payable', numeric: true, cell: (r) => String(r.payable) },
    { header: 'Absent', numeric: true, cell: (r) => String(r.absent) },
    { header: 'OT hrs', numeric: true, cell: (r) => String(Math.round(r.overtime * 10) / 10) },
    { header: 'Marked', numeric: true, cell: (r) => `${r.marked}/${days.length}` },
  ]

  const totalPayable = rows.reduce((sum, r) => sum + r.payable, 0)
  const totalMarked = rows.reduce((sum, r) => sum + r.marked, 0)

  return page(
    c,
    {
      title: 'Muster roll',
      path: '/app/hr/reports/muster',
      subtitle: `${formatMonth(month)} — ${roster.length} on the roster, ${totalPayable} payable day${
        totalPayable === 1 ? '' : 's'
      }`,
      actions: (
        <a class="ncc-btn" href={`/app/hr/attendance?month=${month}`}>
          Attendance entry
        </a>
      ),
    },
    <>
      {banner(c)}
      {state.locked ? (
        <Alert tone="ok">
          {formatMonth(month)} is closed: {state.approved} of {state.total} rows carry an approval. This register
          is final unless somebody holding <code>finance.period_close</code> reopens it.
        </Alert>
      ) : (
        <Alert tone="warn">
          {formatMonth(month)} is not closed. {state.total - state.approved} of {state.total} rows are still
          unapproved, so this register is a draft: do not file or pay against it until{' '}
          <code>hr.attendance_approve</code> has closed the month.
        </Alert>
      )}
      <form class="ncc-toolbar" method="get" action="/app/hr/reports/muster">
        <FormField label="Month" name="month" type="month" value={month} />
        <button class="ncc-btn" type="submit">
          Show
        </button>
      </form>
      <Panel title={`Muster roll — ${formatMonth(month)}`}>
        <DataTable
          columns={columns}
          rows={rows}
          empty="Nobody was on the books in this month."
          caption={`${totalMarked} of ${roster.length * days.length} employee-days are marked. Unmarked days count as nothing, not as absent.`}
        />
        <p class="ncc-hint">
          P present · A absent · ½ half day · WO weekly off · H holiday · PL paid leave · LWP unpaid ·
          OD on duty travel · CO comp off · · not marked · — not employed. Payable counts present, on duty,
          comp off and paid leave in full and a half day as 0.5. Sundays are the weekly off; public holidays are
          not in the system, so a festival day shows as whatever it was marked.
        </p>
      </Panel>
    </>
  )
})

/* Contractor labour and bills (spec 6.6 rules 2 and 3) --------------------- */

/**
 * The second population of 6.6.
 *
 * No screen below reaches an `employees` row and none of them can create one.
 * A contractor's workers are a headcount by skill level and are never named, so
 * there is no person to link: `contractor_attendance` has a `headcount` column
 * and no `employee_id`, which is the spec expressing the separation in DDL.
 *
 * The route table gives four routes and the page list gives five screens, so the
 * GETs for attendance entry and for bills are additions -- a page cannot exist
 * without a route to reach it. `POST /api/hr/contractor-attendance/approve` is
 * the other addition, and the load-bearing one: rule 2 bills only rows whose
 * `approved_at` is set, and nothing in the table can set it. Both are flagged in
 * DECISIONS 18.3 rather than treated as licence to redesign the table.
 */
function canApproveAttendance(c: Ctx): boolean {
  return c.get('perms').has(PERMISSIONS.HR_ATTENDANCE_APPROVE)
}

function canContractors(c: Ctx): boolean {
  return c.get('perms').has(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE)
}

/** An expiry that has passed, for the compliance column and the entry warning. */
function expired(value: string | null, onDate: string): boolean {
  return value !== null && value < onDate
}

hr.get('/app/hr/contractors', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const db = c.get('db')
  const status = queryParam(c, 'status')
  const search = queryParam(c, 'q')
  const rows = await q.listContractors(db, { status, search })
  const now = today()

  const columns: Column<q.ContractorListRow>[] = [
    {
      header: 'Contractor',
      cell: (r) => (
        <>
          <a href={`/app/hr/contractors/${r.id}`}>
            <strong>{r.name}</strong>
          </a>
          <div class="ncc-muted">{r.code}</div>
        </>
      ),
    },
    { header: 'Trade', cell: (r) => r.trade_specialisation ?? <span class="ncc-muted">-</span> },
    { header: 'Phone', cell: (r) => r.contact_phone ?? <span class="ncc-muted">-</span> },
    {
      header: 'Licence',
      cell: (r) =>
        r.licence_valid_until === null ? (
          <span class="ncc-muted">not recorded</span>
        ) : expired(r.licence_valid_until, now) ? (
          <span class="ncc-badge ncc-badge-danger">expired {formatDate(r.licence_valid_until)}</span>
        ) : (
          <DateText value={r.licence_valid_until} />
        ),
    },
    {
      header: 'WC policy',
      cell: (r) =>
        r.wc_policy_valid_until === null ? (
          <span class="ncc-muted">not recorded</span>
        ) : expired(r.wc_policy_valid_until, now) ? (
          <span class="ncc-badge ncc-badge-danger">expired {formatDate(r.wc_policy_valid_until)}</span>
        ) : (
          <DateText value={r.wc_policy_valid_until} />
        ),
    },
    {
      header: 'ESI / PF',
      cell: (r) => `${r.esi_registered ? 'ESI' : '-'} / ${r.pf_registered ? 'PF' : '-'}`,
    },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  return page(
    c,
    {
      title: 'Labour contractors',
      path: '/app/hr/contractors',
      subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'}`,
      actions: (
        <>
          <a class="ncc-btn" href="/app/hr/contractor-attendance">
            Attendance entry
          </a>
          <a class="ncc-btn" href="/app/hr/contractor-bills">
            Bills
          </a>
          <a class="ncc-btn ncc-btn-primary" href="/app/hr/contractors/new">
            New contractor
          </a>
        </>
      ),
    },
    <>
      {banner(c)}
      <form class="ncc-card ncc-row" method="get" action="/app/hr/contractors">
        <FormField label="Status" name="status" options={enumOptions(CONTRACTOR_STATUSES, status, 'Any')} />
        <FormField label="Name or code contains" name="q" value={search ?? ''} />
        <button class="ncc-btn" type="submit">
          Filter
        </button>
      </form>
      <Panel title="Labour contractors">
        <DataTable columns={columns} rows={rows} empty="No contractor matches that filter." />
        <p class="ncc-hint">
          These are firms, not employees. Nothing on this screen creates a row in the employee master, and a
          contractor's workers are counted by skill level rather than named (6.6 rules 2 and 3).
        </p>
      </Panel>
    </>
  )
})

/* The contractor form, shared by create and edit ---------------------------- */

type ContractorDetail = NonNullable<Awaited<ReturnType<typeof q.findContractor>>>

/**
 * One form for both create and edit, the same shape as `EmployeeForm`.
 *
 * The two compliance dates carry their consequence in the hint rather than in a
 * validation rule, because leaving them blank is allowed and expired is only
 * refused at the point of recording labour (rule 3). A user who has to discover
 * that by being refused at a site gate has been told too late.
 */
function ContractorForm(props: {
  action: string
  csrf: string
  contractor?: ContractorDetail
  vendors: Awaited<ReturnType<typeof q.contractorVendorOptions>>
  submit: string
}) {
  const r = props.contractor
  return (
    <form class="ncc-card ncc-stack" method="post" action={props.action}>
      <CsrfInput token={props.csrf} />
      <fieldset class="ncc-fieldset">
        <legend>Who they are</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField label="Code" name="code" required value={r?.code} hint="Short, unique, upper case." />
          <FormField label="Name" name="name" required value={r?.name} />
          <FormField
            label="Also a registered vendor"
            name="vendorId"
            options={idOptions(props.vendors, r?.vendor_id ?? null, 'Not on the vendor master')}
            hint="Optional. Links this firm to its 6.4 vendor record for payments."
          />
          <FormField label="Contact phone" name="contactPhone" type="tel" value={r?.contact_phone} />
          <FormField label="Trade" name="tradeSpecialisation" value={r?.trade_specialisation} />
          <FormField
            label="Status"
            name="status"
            options={enumOptions(CONTRACTOR_STATUSES, r?.status ?? 'active')}
            hint="On hold can be overridden at entry; blacklisted cannot."
          />
        </div>
      </fieldset>
      <fieldset class="ncc-fieldset">
        <legend>Statutory</legend>
        <div class="ncc-grid ncc-grid--form">
          <FormField label="PAN" name="pan" value={r?.pan} hint="Ten characters. Without it, TDS is not deducted at the higher rate here -- see the bill screen." />
          <FormField label="GSTIN" name="gstin" value={r?.gstin} />
          <FormField label="Labour licence no" name="licenceNo" value={r?.licence_no} />
          <FormField
            label="Licence valid until"
            name="licenceValidUntil"
            type="date"
            value={r?.licence_valid_until}
            hint="Once this date has passed, recording labour needs an override."
          />
          <FormField label="WC policy no" name="wcPolicyNo" value={r?.wc_policy_no} />
          <FormField
            label="WC policy valid until"
            name="wcPolicyValidUntil"
            type="date"
            value={r?.wc_policy_valid_until}
            hint="Workmen's compensation. Same override, same audit entry."
          />
          <FormField
            label="Rating"
            name="rating"
            type="number"
            min="1"
            max="5"
            value={r?.rating}
            hint="1 to 5, or blank."
          />
        </div>
        <div class="ncc-row">
          <label class="ncc-field">
            <span>Registered for ESI</span>
            <input type="checkbox" name="esiRegistered" value="on" checked={Boolean(r?.esi_registered)} />
          </label>
          <label class="ncc-field">
            <span>Registered for PF</span>
            <input type="checkbox" name="pfRegistered" value="on" checked={Boolean(r?.pf_registered)} />
          </label>
        </div>
      </fieldset>
      <p>
        <button class="ncc-btn ncc-btn-primary" type="submit">
          {props.submit}
        </button>
      </p>
    </form>
  )
}

hr.get('/app/hr/contractors/new', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const session = c.get('session')!
  const vendors = await q.contractorVendorOptions(c.get('db'))
  return page(
    c,
    { title: 'New labour contractor', path: '/app/hr/contractors' },
    <>
      {banner(c)}
      <ContractorForm
        action="/app/hr/contractors"
        csrf={session.csrfToken}
        vendors={vendors}
        submit="Create contractor"
      />
    </>
  )
})

hr.post('/app/hr/contractors', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const parsed = contractorSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/hr/contractors/new', firstError(parsed.error))

  try {
    const id = await svc.createContractor(c.get('db'), actorOf(c), parsed.data)
    return okRedirect(c, `/app/hr/contractors/${id}`, `${parsed.data.name} added.`)
  } catch (err) {
    if (!isAppError(err)) throw err
    return errRedirect(c, '/app/hr/contractors/new', err.message)
  }
})

hr.get(
  '/app/hr/contractors/:contractorId/edit',
  requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE),
  async (c) => {
    const contractorId = idParam(c, 'contractorId')
    const db = c.get('db')
    const session = c.get('session')!
    const [contractor, vendors] = await Promise.all([
      q.findContractor(db, contractorId),
      q.contractorVendorOptions(db),
    ])
    if (!contractor) throw new NotFoundError('That contractor does not exist.')

    return page(
      c,
      { title: `Edit ${contractor.name}`, path: '/app/hr/contractors' },
      <>
        {banner(c)}
        <ContractorForm
          action={`/app/hr/contractors/${contractorId}`}
          csrf={session.csrfToken}
          contractor={contractor}
          vendors={vendors}
          submit="Save changes"
        />
      </>
    )
  }
)

hr.post('/app/hr/contractors/:contractorId', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const contractorId = idParam(c, 'contractorId')
  const back = `/app/hr/contractors/${contractorId}/edit`
  const parsed = contractorSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  try {
    await svc.updateContractor(c.get('db'), actorOf(c), contractorId, parsed.data)
    return okRedirect(c, `/app/hr/contractors/${contractorId}`, 'Contractor updated.')
  } catch (err) {
    if (!isAppError(err)) throw err
    return errRedirect(c, back, err.message)
  }
})

/* Contractor detail: profile, rate card, attendance, bills ------------------ */

const CONTRACTOR_TABS = ['profile', 'rates', 'attendance', 'bills'] as const
type ContractorTab = (typeof CONTRACTOR_TABS)[number]

/**
 * The attendance grid, shared by the contractor tab, the entry screen and a
 * bill's own lines.
 *
 * `rate_paise` is shown beside the amount because it is a snapshot column, not a
 * join: the figure on a six-month-old row is the rate that was on the card that
 * day, and a reader comparing it against today's card needs to see both.
 */
function contractorAttendanceColumns(opts: { showContractor?: boolean } = {}): Column<q.ContractorAttendanceRow>[] {
  return [
    { header: 'Date', cell: (r) => <DateText value={r.attendance_date} /> },
    ...(opts.showContractor
      ? [
          {
            header: 'Contractor',
            cell: (r: q.ContractorAttendanceRow) => (
              <>
                {r.contractor_name}
                <div class="ncc-muted">{r.contractor_code}</div>
              </>
            ),
          },
        ]
      : []),
    { header: 'Project', cell: (r) => r.project_code ?? '-' },
    {
      header: 'Skill',
      cell: (r) => (
        <>
          {titleCase(r.skill_level)}
          {r.work_type === '' ? null : <div class="ncc-muted">{r.work_type}</div>}
        </>
      ),
    },
    { header: 'Head', numeric: true, cell: (r) => String(r.headcount) },
    {
      // Without this column a measured row shows a rate, a headcount and an
      // amount that do not multiply together, and the reader is left to guess
      // which figure is wrong. `per_day` is the row that has no measure.
      header: 'Measure',
      numeric: true,
      cell: (r) =>
        r.uom === 'per_day' || r.quantity === null ? (
          <span class="ncc-muted">-</span>
        ) : (
          <>
            {String(r.quantity)} <span class="ncc-muted">{uomLabel(r.uom)}</span>
          </>
        ),
    },
    { header: 'OT hrs', numeric: true, cell: (r) => (r.overtime_hours === 0 ? '-' : String(r.overtime_hours)) },
    { header: 'Rate', numeric: true, cell: (r) => <Money paise={r.rate_paise} /> },
    { header: 'Amount', numeric: true, cell: (r) => <Money paise={r.amount_paise} /> },
    {
      header: 'State',
      cell: (r) =>
        r.bill_no !== null ? (
          <a href={`/app/hr/contractor-bills/${r.bill_id}`}>{r.bill_no}</a>
        ) : r.approved_at !== null ? (
          <StatusBadge status="approved" />
        ) : (
          <StatusBadge status="pending" />
        ),
    },
  ]
}

function billColumns(opts: { showContractor?: boolean } = {}): Column<q.ContractorBillRow>[] {
  return [
    {
      header: 'Bill',
      cell: (r) => (
        <a href={`/app/hr/contractor-bills/${r.id}`}>
          <strong>{r.bill_no}</strong>
        </a>
      ),
    },
    ...(opts.showContractor
      ? [
          {
            header: 'Contractor',
            cell: (r: q.ContractorBillRow) => (
              <>
                {r.contractor_name}
                <div class="ncc-muted">{r.contractor_code}</div>
              </>
            ),
          },
        ]
      : []),
    { header: 'Project', cell: (r) => r.project_code },
    {
      header: 'Period',
      cell: (r) => (
        <>
          <DateText value={r.period_from} /> to <DateText value={r.period_to} />
        </>
      ),
    },
    { header: 'Gross', numeric: true, cell: (r) => <Money paise={r.gross_paise} /> },
    { header: 'Net payable', numeric: true, cell: (r) => <Money paise={r.net_payable_paise} /> },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]
}

hr.get('/app/hr/contractors/:contractorId', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const db = c.get('db')
  const session = c.get('session')!
  const contractorId = idParam(c, 'contractorId')
  const contractor = await q.findContractor(db, contractorId)
  if (!contractor) throw new NotFoundError('That contractor does not exist.')

  const requested = (queryParam(c, 'tab') ?? 'profile') as ContractorTab
  const tab: ContractorTab = CONTRACTOR_TABS.includes(requested) ? requested : 'profile'
  const now = today()

  let body: Child = null

  if (tab === 'profile') {
    const failures: string[] = []
    if (expired(contractor.licence_valid_until, now)) failures.push('labour licence')
    if (expired(contractor.wc_policy_valid_until, now)) failures.push('workmen’s compensation policy')

    body = (
      <div class="ncc-stack">
        {contractor.status === 'blacklisted' ? (
          <Alert tone="error">
            This contractor is blacklisted. No labour can be recorded against them and there is no override for
            it, because the permission that would override it is the one that set the status.
          </Alert>
        ) : failures.length > 0 ? (
          <Alert tone="warn">
            The {failures.join(' and the ')} {failures.length === 1 ? 'has' : 'have'} expired. Recording labour
            for a day after the expiry needs an override, and the override is written to the audit log (6.6 rule
            3).
          </Alert>
        ) : null}
        <Panel title="The firm">
          <DefinitionList
            rows={[
              ['Code', contractor.code],
              ['Name', contractor.name],
              ['Trade', contractor.trade_specialisation ?? '-'],
              ['Phone', contractor.contact_phone ?? '-'],
              ['Vendor record', contractor.vendor_name ?? 'not on the vendor master'],
              ['Status', <StatusBadge status={contractor.status} />],
              ['Rating', contractor.rating === null ? '-' : `${contractor.rating} of 5`],
            ]}
          />
        </Panel>
        <Panel title="Statutory and compliance">
          <DefinitionList
            rows={[
              ['PAN', contractor.pan ?? 'not recorded'],
              ['GSTIN', contractor.gstin ?? 'not recorded'],
              ['Labour licence', contractor.licence_no ?? 'not recorded'],
              [
                'Licence valid until',
                contractor.licence_valid_until === null ? (
                  'not recorded'
                ) : (
                  <DateText value={contractor.licence_valid_until} />
                ),
              ],
              ['WC policy', contractor.wc_policy_no ?? 'not recorded'],
              [
                'WC policy valid until',
                contractor.wc_policy_valid_until === null ? (
                  'not recorded'
                ) : (
                  <DateText value={contractor.wc_policy_valid_until} />
                ),
              ],
              ['ESI', contractor.esi_registered ? 'registered' : 'not registered'],
              ['PF', contractor.pf_registered ? 'registered' : 'not registered'],
            ]}
          />
          <p class="ncc-hint">
            A date left blank does not block anything: rule 3 refuses a date that has passed, and a column
            nobody filled in has not passed. Whether a missing licence should block is an 8.1 question.
          </p>
        </Panel>
      </div>
    )
  }

  if (tab === 'rates') {
    const [rates, projects] = await Promise.all([q.contractorRates(db, contractorId), q.projectOptions(db)])
    body = (
      <div class="ncc-stack">
        <Panel title="Rate card">
          <DataTable
            columns={[
              { header: 'Work', cell: (r: q.ContractorRateRow) => r.work_type },
              { header: 'Skill', cell: (r: q.ContractorRateRow) => (r.skill_level ? titleCase(r.skill_level) : '-') },
              { header: 'Unit', cell: (r: q.ContractorRateRow) => titleCase(r.uom) },
              { header: 'Project', cell: (r: q.ContractorRateRow) => r.project_code ?? 'any project' },
              {
                header: 'Rate',
                numeric: true,
                cell: (r: q.ContractorRateRow) => <Money paise={r.rate_paise} />,
              },
              { header: 'From', cell: (r: q.ContractorRateRow) => <DateText value={r.effective_from} /> },
              {
                header: 'To',
                cell: (r: q.ContractorRateRow) =>
                  r.effective_to === null ? <span class="ncc-muted">open</span> : <DateText value={r.effective_to} />,
              },
            ]}
            rows={rates}
            empty="No rate is on the card yet. Attendance cannot be priced until one is."
            caption="A rate is superseded, not edited: adding one closes the open line for the same scope the day before."
          />
        </Panel>
        <Panel title="Add a rate">
          <form class="ncc-stack" method="post" action={`/api/hr/contractors/${contractorId}/rates`}>
            <CsrfInput token={session.csrfToken} />
            <div class="ncc-grid ncc-grid--form">
              <FormField label="Work type" name="workType" required hint="For example: block masonry." />
              <FormField label="Unit" name="uom" required options={enumOptions(RATE_UOMS, 'per_day')} />
              <FormField
                label="Skill level"
                name="skillLevel"
                options={enumOptions(SKILL_LEVELS, null, 'Not skill-based')}
                hint="Required for a per-day rate: that is what a headcount is priced against."
              />
              <FormField
                label="Project"
                name="projectId"
                options={idOptions(projects, null, 'Any project')}
                hint="A project rate is preferred over the company-wide one for that project."
              />
              <FormField label="Rate in rupees" name="rate" type="number" step="0.01" min="0" required />
              <FormField label="Effective from" name="effectiveFrom" type="date" required value={now} />
              <FormField label="Effective to" name="effectiveTo" type="date" hint="Blank leaves it open." />
            </div>
            <p>
              <button class="ncc-btn ncc-btn-primary" type="submit">
                Add rate
              </button>
            </p>
            <p class="ncc-hint">
              All five units price a day's attendance since migration 013. A <code>per_day</code> rate is
              multiplied by the headcount and needs a skill level; the other four are multiplied by the
              quantity entered against the work type, and a skill level on those only narrows which rate
              applies. DECISIONS 19.2 records that 6.6 shipped without the quantity column this needs.
            </p>
          </form>
        </Panel>
      </div>
    )
  }

  if (tab === 'attendance') {
    const rows = await q.contractorAttendance(db, { contractorId })
    body = (
      <Panel title="Recorded labour">
        <DataTable
          columns={contractorAttendanceColumns()}
          rows={rows}
          empty="No labour has been recorded against this contractor."
          caption={`${rows.length} row${rows.length === 1 ? '' : 's'}, newest period last. A row with a bill number cannot be changed.`}
        />
        <p>
          <a class="ncc-btn" href={`/app/hr/contractor-attendance?contractorId=${contractorId}`}>
            Record a day
          </a>
        </p>
      </Panel>
    )
  }

  if (tab === 'bills') {
    const bills = await q.listContractorBills(db, { contractorId })
    body = (
      <Panel title="Bills">
        <DataTable
          columns={billColumns()}
          rows={bills}
          empty="No bill has been generated for this contractor."
        />
      </Panel>
    )
  }

  return page(
    c,
    {
      title: contractor.name,
      path: '/app/hr/contractors',
      subtitle: `${contractor.code}${contractor.trade_specialisation ? `, ${contractor.trade_specialisation}` : ''}`,
      actions: (
        <>
          <StatusBadge status={contractor.status} />
          <a class="ncc-btn" href={`/app/hr/contractors/${contractorId}/edit`}>
            Edit
          </a>
        </>
      ),
    },
    <>
      {banner(c)}
      <Tabs
        tabs={CONTRACTOR_TABS.map((t) => ({
          label: titleCase(t),
          href: `/app/hr/contractors/${contractorId}?tab=${t}`,
        }))}
        active={`/app/hr/contractors/${contractorId}?tab=${tab}`}
      />
      {body}
    </>
  )
})

hr.post(
  '/api/hr/contractors/:contractorId/rates',
  requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE),
  async (c) => {
    const contractorId = idParam(c, 'contractorId')
    const back = `/app/hr/contractors/${contractorId}?tab=rates`
    const parsed = contractorRateSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

    return guard(c, back, async () => {
      await svc.addContractorRate(c.get('db'), actorOf(c), contractorId, parsed.data)
      return `${parsed.data.workType} rate added with effect from ${parsed.data.effectiveFrom}.`
    })
  }
)

/* Contractor attendance entry (6.6 rule 2, first half) ---------------------- */

/** Projects with their code in the label, which `idOptions` drops. */
const projectSelect = (
  projects: Array<{ id: number; code: string; name: string }>,
  selected: number | null,
  blank: string
) => [
  { value: '', label: blank, selected: !selected },
  ...projects.map((p) => ({
    value: String(p.id),
    label: `${p.code} ${p.name}`,
    selected: Number(p.id) === selected,
  })),
]

/**
 * The entry screen: one contractor, one project, one day, and two grids.
 *
 * The grid is server-rendered and the date is a query parameter, exactly like the
 * employee attendance screen, and for the same reason: the rows have to be
 * prefilled with what is already recorded, and nothing in `src/` is client-side
 * yet. The keyboard-driven matrix spec line 1761 asks for is the slice that
 * follows this one (DECISIONS 17.2); it is not quietly dropped and it is not
 * introduced mid-slice.
 *
 * Which rows appear is not a guess: they are the rate card lines in force on that
 * date, one grid per kind. Days first, because that is most of the work; measured
 * lines below, one per (work type, unit) the card carries. A skill or a work type
 * with no rate cannot be priced, so offering it would be offering a row the
 * service must refuse.
 *
 * Both grids post into one form and one array set. Every rendered line emits
 * exactly one value for each of the six repeated names -- `skillLevel`, `uom`,
 * `workType`, `headcount`, `quantity`, `overtimeHours` -- because the schema pairs
 * them by index. That is why a billed row still emits an empty `headcount` and why
 * a day line emits an empty `quantity`: dropping the input instead would shift
 * every line below it onto the wrong values. Whoever adds a column here adds it to
 * every line in both grids or breaks all of them.
 *
 * The skill on a measured line is a select, not a hidden field. A piece rate need
 * not name a skill -- 240 sqft of plastering costs the same whoever laid it -- but
 * `contractor_attendance.skill_level` is NOT NULL, so someone has to say who did
 * the work. When the rate does name a skill, that answer is fixed and the field is
 * hidden instead.
 */
hr.get('/app/hr/contractor-attendance', requirePermission(PERMISSIONS.HR_ATTENDANCE_RECORD), async (c) => {
  const db = c.get('db')
  const session = c.get('session')!
  const contractorId = Number(queryParam(c, 'contractorId') ?? '') || null
  const projectId = Number(queryParam(c, 'projectId') ?? '') || null
  const dateParam = queryParam(c, 'date')
  const date = dateParam && isValidIsoDate(dateParam) ? dateParam : today()

  const [contractors, projects] = await Promise.all([q.contractorOptions(db), q.projectOptions(db)])
  const contractor = contractorId === null ? undefined : await q.findContractor(db, contractorId)

  const rates = contractor ? await q.contractorRates(db, Number(contractor.id)) : []
  const inForce = rates.filter(
    (r) =>
      r.effective_from <= date &&
      (r.effective_to === null || r.effective_to >= date) &&
      (r.project_id === null || projectId === null || r.project_id === projectId)
  )
  const perDay = inForce.filter((r) => r.uom === 'per_day' && r.skill_level !== null)
  const skills = [...new Set(perDay.map((r) => r.skill_level as string))].sort()

  // One line per (work type, unit), best rate first: the same scope-then-date
  // ordering `applicableRate` uses, so the figure shown is the figure that will be
  // snapshotted. Two cards for the same work type and unit are a supersession, not
  // two offers.
  const measuredLines = (() => {
    const best = new Map<string, (typeof inForce)[number]>()
    for (const r of inForce) {
      if (r.uom === 'per_day') continue
      const key = [r.uom, r.work_type].join(' ')
      const held = best.get(key)
      const better =
        held === undefined ||
        (r.project_id === null ? 0 : 1) - (held.project_id === null ? 0 : 1) > 0 ||
        ((r.project_id === null) === (held.project_id === null) &&
          r.effective_from.localeCompare(held.effective_from) > 0)
      if (better) best.set(key, r)
    }
    return [...best.values()].sort(
      (a, b) => a.work_type.localeCompare(b.work_type) || a.uom.localeCompare(b.uom)
    )
  })()

  const prior =
    contractor && projectId !== null
      ? await q.contractorAttendance(db, { contractorId: Number(contractor.id), projectId, from: date, to: date })
      : []
  const priorBySkill = new Map(prior.filter((r) => r.uom === 'per_day').map((r) => [r.skill_level, r]))
  const billed = prior.filter((r) => r.bill_id !== null).length
  // A measured row belongs to the line that priced it, which is the (work type,
  // unit) pair -- not the skill, since two work types can share one. `work_type`
  // is NOT NULL since 016, so there is no coalesce left to do here.
  const workKey = (uom: string, workType: string) => [uom, workType].join(' ')
  const priorByWork = new Map(
    prior.filter((r) => r.uom !== 'per_day').map((r) => [workKey(r.uom, r.work_type), r])
  )
  const renderedWork = new Set(measuredLines.map((r) => workKey(r.uom, r.work_type)))
  // Rows on the day that no line in either grid renders, because the rate card
  // moved under them. They are shown read-only rather than silently omitted: the
  // post only touches skills it carries, so they survive it either way, but a
  // screen that hides a recorded figure is how a day gets counted twice.
  const orphans = prior.filter((r) =>
    r.uom === 'per_day' ? !skills.includes(r.skill_level) : !renderedWork.has(workKey(r.uom, r.work_type))
  )

  const failures: string[] = []
  if (contractor) {
    if (expired(contractor.licence_valid_until, date)) failures.push('the labour licence had expired')
    if (expired(contractor.wc_policy_valid_until, date)) failures.push('the WC policy had expired')
    if (contractor.status === 'on_hold') failures.push('the contractor is on hold')
  }

  return page(
    c,
    {
      title: 'Contractor attendance',
      path: '/app/hr/contractors',
      subtitle: contractor ? `${contractor.name} — ${formatDate(date)}` : 'Choose a contractor and a day',
      actions: (
        <a class="ncc-btn" href="/app/hr/contractors">
          All contractors
        </a>
      ),
    },
    <>
      {banner(c)}
      <form class="ncc-toolbar" method="get" action="/app/hr/contractor-attendance">
        <FormField
          label="Contractor"
          name="contractorId"
          options={idOptions(contractors, contractorId, 'Choose one')}
        />
        <FormField label="Project" name="projectId" options={projectSelect(projects, projectId, 'Choose one')} />
        <FormField label="Date" name="date" type="date" value={date} />
        <button class="ncc-btn" type="submit">
          Show
        </button>
      </form>
      {contractor === undefined || projectId === null ? (
        <Alert tone="warn">
          Pick a contractor, the project the labour worked on and the day. Unlike employee attendance, a project
          is required: contractor labour is always charged to a site.
        </Alert>
      ) : contractor.status === 'blacklisted' ? (
        <Alert tone="error">
          {contractor.name} is blacklisted. No labour can be recorded against them, and this one has no
          override.
        </Alert>
      ) : skills.length === 0 && measuredLines.length === 0 ? (
        <Alert tone="warn">
          {contractor.name} has no rate in force on {formatDate(date)}, of any unit, so nothing here can be
          priced. Add one on the <a href={`/app/hr/contractors/${contractor.id}?tab=rates`}>rate card</a> first.
        </Alert>
      ) : (
        <>
          {failures.length > 0 ? (
            <Alert tone="warn">
              On {formatDate(date)} {failures.join(' and ')}. Recording this day needs the override below, and it
              is written to the audit log with the reason list (6.6 rule 3).
            </Alert>
          ) : null}
          {billed > 0 ? (
            <Alert tone="warn">
              {billed} of the rows for this day {billed === 1 ? 'is' : 'are'} already on a bill and cannot be
              changed here.
            </Alert>
          ) : null}
          {orphans.length > 0 ? (
            <Alert tone="warn">
              {orphans.length === 1 ? 'One row' : `${orphans.length} rows`} recorded for this day{' '}
              {orphans.length === 1 ? 'has' : 'have'} no rate card line in force any more, so{' '}
              {orphans.length === 1 ? 'it is' : 'they are'} not in the grids below and posting will not touch{' '}
              {orphans.length === 1 ? 'it' : 'them'}:{' '}
              {orphans
                .map(
                  (r) =>
                    `${r.skill_level.replace(/_/g, ' ')} ${
                      r.uom === 'per_day' ? `× ${r.headcount}` : `${r.quantity} ${uomLabel(r.uom)}`
                    }`
                )
                .join(', ')}
              . Restore the rate to correct {orphans.length === 1 ? 'it' : 'them'} here.
            </Alert>
          ) : null}
          <Panel title={`Headcount for ${formatDate(date)}`}>
            <form method="post" action="/api/hr/contractor-attendance">
              <CsrfInput token={session.csrfToken} />
              <input type="hidden" name="contractorId" value={String(contractor.id)} />
              <input type="hidden" name="projectId" value={String(projectId)} />
              <input type="hidden" name="attendanceDate" value={date} />
              <DataTable
                columns={[
                  {
                    header: 'Skill',
                    cell: (skill: string) => (
                      <>
                        <input type="hidden" name="skillLevel" value={skill} />
                        {/* The three fields a day line does not use, emitted anyway:
                            the schema pairs the six arrays by index, so a missing
                            input here would read the line below this one's values. */}
                        <input type="hidden" name="uom" value="per_day" />
                        <input type="hidden" name="workType" value="" />
                        <input type="hidden" name="quantity" value="" />
                        {titleCase(skill)}
                      </>
                    ),
                  },
                  {
                    header: 'Rate that day',
                    numeric: true,
                    cell: (skill: string) => {
                      const best = perDay
                        .filter((r) => r.skill_level === skill)
                        .sort(
                          (a, b) =>
                            (b.project_id === null ? 0 : 1) - (a.project_id === null ? 0 : 1) ||
                            b.effective_from.localeCompare(a.effective_from)
                        )[0]
                      return <Money paise={best?.rate_paise ?? null} />
                    },
                  },
                  {
                    header: 'Headcount',
                    numeric: true,
                    cell: (skill: string) => {
                      const p = priorBySkill.get(skill)
                      return p && p.bill_id !== null ? (
                        <>
                          <input type="hidden" name="headcount" value="" />
                          <span class="ncc-num">{p.headcount}</span>
                        </>
                      ) : (
                        <input
                          type="number"
                          name="headcount"
                          min="1"
                          max="999"
                          step="1"
                          style="max-width:6rem"
                          value={p ? String(p.headcount) : ''}
                          aria-label={`Headcount for ${titleCase(skill)}`}
                        />
                      )
                    },
                  },
                  {
                    header: 'OT hours',
                    numeric: true,
                    cell: (skill: string) => {
                      const p = priorBySkill.get(skill)
                      return p && p.bill_id !== null ? (
                        <>
                          <input type="hidden" name="overtimeHours" value="" />
                          <span class="ncc-num">{p.overtime_hours}</span>
                        </>
                      ) : (
                        <input
                          type="number"
                          name="overtimeHours"
                          min="0"
                          step="0.5"
                          style="max-width:6rem"
                          value={p && p.overtime_hours !== 0 ? String(p.overtime_hours) : ''}
                          aria-label={`Overtime hours for ${titleCase(skill)}`}
                        />
                      )
                    },
                  },
                  {
                    header: 'State',
                    cell: (skill: string) => {
                      const p = priorBySkill.get(skill)
                      if (!p) return <span class="ncc-muted">nothing recorded</span>
                      if (p.bill_no !== null)
                        return <a href={`/app/hr/contractor-bills/${p.bill_id}`}>{p.bill_no}</a>
                      return p.approved_at !== null ? (
                        <StatusBadge status="approved" />
                      ) : (
                        <StatusBadge status="pending" />
                      )
                    },
                  },
                ]}
                rows={skills}
                empty="No priced skill for this day."
                caption="A blank headcount writes nothing. Changing an approved row clears its approval, because the figure that was approved is not the figure it now carries."
              />
              {measuredLines.length > 0 ? (
                <>
                  <h3 style="margin:1.5rem 0 .5rem">Measured work</h3>
                  <DataTable
                    columns={[
                      {
                        header: 'Work',
                        cell: (r: (typeof measuredLines)[number]) => (
                          <>
                            <input type="hidden" name="uom" value={r.uom} />
                            <input type="hidden" name="workType" value={r.work_type} />
                            <input type="hidden" name="overtimeHours" value="" />
                            {r.work_type}
                            <br />
                            <span class="ncc-muted">{uomLabel(r.uom)}</span>
                          </>
                        ),
                      },
                      {
                        header: 'Rate',
                        numeric: true,
                        cell: (r: (typeof measuredLines)[number]) => <Money paise={r.rate_paise} />,
                      },
                      {
                        header: 'Skill',
                        cell: (r: (typeof measuredLines)[number]) => {
                          const p = priorByWork.get(workKey(r.uom, r.work_type))
                          const fixed = r.skill_level ?? (p ? p.skill_level : null)
                          // Fixed by the rate card, or by what was already recorded
                          // against this line: changing it would leave the old row
                          // behind under its old skill and write a second one.
                          return fixed !== null ? (
                            <>
                              <input type="hidden" name="skillLevel" value={fixed} />
                              {titleCase(fixed)}
                            </>
                          ) : (
                            <select name="skillLevel" aria-label={`Skill that did the ${r.work_type}`}>
                              {SKILL_LEVELS.map((s) => (
                                <option value={s}>{titleCase(s)}</option>
                              ))}
                            </select>
                          )
                        },
                      },
                      {
                        header: 'People',
                        numeric: true,
                        cell: (r: (typeof measuredLines)[number]) => {
                          const p = priorByWork.get(workKey(r.uom, r.work_type))
                          return p && p.bill_id !== null ? (
                            <>
                              <input type="hidden" name="headcount" value="" />
                              <span class="ncc-num">{p.headcount}</span>
                            </>
                          ) : (
                            <input
                              type="number"
                              name="headcount"
                              min="1"
                              max="999"
                              step="1"
                              style="max-width:5rem"
                              value={p ? String(p.headcount) : ''}
                              aria-label={`People on the ${r.work_type}`}
                            />
                          )
                        },
                      },
                      {
                        header: 'Quantity',
                        numeric: true,
                        cell: (r: (typeof measuredLines)[number]) => {
                          const p = priorByWork.get(workKey(r.uom, r.work_type))
                          return p && p.bill_id !== null ? (
                            <>
                              <input type="hidden" name="quantity" value="" />
                              <span class="ncc-num">{p.quantity}</span>
                            </>
                          ) : (
                            <input
                              type="number"
                              name="quantity"
                              min="0.001"
                              step="0.001"
                              style="max-width:7rem"
                              value={p && p.quantity !== null ? String(p.quantity) : ''}
                              aria-label={`Quantity of ${r.work_type} in ${uomLabel(r.uom)}`}
                            />
                          )
                        },
                      },
                      {
                        header: 'State',
                        cell: (r: (typeof measuredLines)[number]) => {
                          const p = priorByWork.get(workKey(r.uom, r.work_type))
                          if (!p) return <span class="ncc-muted">nothing recorded</span>
                          if (p.bill_no !== null)
                            return <a href={`/app/hr/contractor-bills/${p.bill_id}`}>{p.bill_no}</a>
                          return p.approved_at !== null ? (
                            <StatusBadge status="approved" />
                          ) : (
                            <StatusBadge status="pending" />
                          )
                        },
                      },
                    ]}
                    rows={measuredLines}
                    caption="Priced by the measure, not by the day: the amount is the rate times the quantity, and the people count is recorded rather than charged. Overtime does not apply to a piece rate and is not offered."
                  />
                </>
              ) : null}
              {measuredLines.length > 0 && skills.length > 0 ? (
                <p class="ncc-hint">
                  A day holds one row per skill level, whatever the unit, so filling the same skill in both
                  grids for one date is refused rather than written twice. Recording both a day rate and a
                  piece rate for one gang on one site needs the wider key noted in DECISIONS 19.2.
                </p>
              ) : null}
              {failures.length > 0 ? (
                <label class="ncc-field">
                  <span>Override the compliance failure</span>
                  <input type="checkbox" name="overrideCompliance" value="on" />
                  <span class="ncc-hint">
                    Needs <code>hr.labour_contractor_manage</code>. Recorded against your name.
                  </span>
                </label>
              ) : null}
              <p style="margin-top:1rem">
                <button class="ncc-btn ncc-btn-primary" type="submit">
                  Post the day
                </button>
              </p>
              <p class="ncc-hint">
                Overtime is recorded and not priced: 6.6 gives no multiplier and 8.6 has not answered, so a
                day row's amount is headcount times the day rate and a measured row's is quantity times the
                piece rate. DECISIONS records that.
              </p>
            </form>
          </Panel>
          {canApproveAttendance(c) ? (
            <Panel title="Approve a period">
              <form class="ncc-stack" method="post" action="/api/hr/contractor-attendance/approve">
                <CsrfInput token={session.csrfToken} />
                <input type="hidden" name="contractorId" value={String(contractor.id)} />
                <input type="hidden" name="projectId" value={String(projectId)} />
                <div class="ncc-row">
                  <FormField label="From" name="from" type="date" required value={monthBounds(monthOf(date)).start} />
                  <FormField label="To" name="to" type="date" required value={date} />
                  <button class="ncc-btn" type="submit">
                    Approve
                  </button>
                </div>
                <p class="ncc-hint">
                  Rule 2 bills approved attendance only. The 6.6 route table has no route that sets{' '}
                  <code>approved_at</code> on these rows, so this one is an addition rather than a spec route --
                  it carries <code>hr.attendance_approve</code>, the permission rule 4 uses for the same act on
                  employees. Flagged in DECISIONS 18.3.
                </p>
              </form>
            </Panel>
          ) : null}
        </>
      )}
    </>
  )
})

hr.post('/api/hr/contractor-attendance', requirePermission(PERMISSIONS.HR_ATTENDANCE_RECORD), async (c) => {
  const body = await readBody(c)
  const parsed = contractorAttendanceSchema.safeParse(body)
  const back = (() => {
    const cid = String(body['contractorId'] ?? '')
    const pid = String(body['projectId'] ?? '')
    const date = String(body['attendanceDate'] ?? '')
    return `/app/hr/contractor-attendance?contractorId=${cid}&projectId=${pid}&date=${date}`
  })()
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  return guard(c, back, async () => {
    const result = await svc.recordContractorAttendance(c.get('db'), actorOf(c), parsed.data, {
      canManageContractors: canContractors(c),
    })
    const parts = [`${result.inserted} written, ${result.updated} corrected, ${result.headcount} on site`]
    if (result.complianceOverride.length > 0) {
      parts.push(`compliance override recorded (${result.complianceOverride.join('; ')})`)
    }
    if (result.ambiguousRates.length > 0) {
      parts.push(`two rates were equally applicable, the newest was used (${result.ambiguousRates.join('; ')})`)
    }
    return `${parts.join('. ')}.`
  })
})

hr.post(
  '/api/hr/contractor-attendance/approve',
  requirePermission(PERMISSIONS.HR_ATTENDANCE_APPROVE),
  async (c) => {
    const body = await readBody(c)
    const parsed = contractorPeriodSchema.safeParse(body)
    const back = `/app/hr/contractor-attendance?contractorId=${String(body['contractorId'] ?? '')}&projectId=${String(
      body['projectId'] ?? ''
    )}`
    if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

    return guard(c, back, async () => {
      const result = await svc.approveContractorAttendance(c.get('db'), actorOf(c), parsed.data)
      return `${result.approved} row${result.approved === 1 ? '' : 's'} approved, ${result.alreadyApproved} already were. They can now be billed.`
    })
  }
)

/* Contractor bills (6.6 rule 2, second half) -------------------------------- */

/**
 * The bill list, and the generate form.
 *
 * The generate form shows what the bill would come to before it burns a bill
 * number: `unbilledSummary` runs the same filter the generator will, so the
 * operator sees the gross rule 2 will compute and the count of unapproved rows
 * that are keeping it down.
 */
hr.get('/app/hr/contractor-bills', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const db = c.get('db')
  const session = c.get('session')!
  const status = queryParam(c, 'status')
  const contractorId = Number(queryParam(c, 'contractorId') ?? '') || null
  const projectId = Number(queryParam(c, 'projectId') ?? '') || null
  const from = queryParam(c, 'from')
  const to = queryParam(c, 'to')

  const [bills, contractors, projects] = await Promise.all([
    q.listContractorBills(db, {
      ...(status ? { status } : {}),
      ...(contractorId !== null ? { contractorId } : {}),
      ...(projectId !== null ? { projectId } : {}),
    }),
    q.contractorOptions(db),
    q.projectOptions(db),
  ])

  const period =
    from && to && isValidIsoDate(from) && isValidIsoDate(to) && to >= from
      ? { from, to }
      : { from: monthBounds(monthOf(today())).start, to: monthBounds(monthOf(today())).end }
  const summary =
    contractorId !== null && projectId !== null
      ? await q.unbilledSummary(db, { contractorId, projectId, from: period.from, to: period.to })
      : null

  return page(
    c,
    {
      title: 'Contractor bills',
      path: '/app/hr/contractor-bills',
      subtitle: `${bills.length} bill${bills.length === 1 ? '' : 's'}`,
      actions: (
        <a class="ncc-btn" href="/app/hr/contractors">
          All contractors
        </a>
      ),
    },
    <>
      {banner(c)}
      <form class="ncc-card ncc-row" method="get" action="/app/hr/contractor-bills">
        <FormField
          label="Contractor"
          name="contractorId"
          options={idOptions(contractors, contractorId, 'Any')}
        />
        <FormField label="Project" name="projectId" options={projectSelect(projects, projectId, 'Any')} />
        <FormField label="Status" name="status" options={enumOptions(CONTRACTOR_BILL_STATUSES, status, 'Any')} />
        <FormField label="Period from" name="from" type="date" value={period.from} />
        <FormField label="to" name="to" type="date" value={period.to} />
        <button class="ncc-btn" type="submit">
          Filter
        </button>
      </form>
      <Panel title="Bills">
        <DataTable columns={billColumns({ showContractor: true })} rows={bills} empty="No bill matches that filter." />
      </Panel>
      {canContractors(c) ? (
        <Panel title="Generate a bill">
          {contractorId === null || projectId === null ? (
            <Alert tone="warn">
              Choose a contractor and a project above. A bill covers one contractor on one site for one period.
              Nothing in <code>contractor_bills</code> enforces that -- its only unique key is{' '}
              <code>bill_no</code> -- so what stops a day reaching two bills is <code>bill_id</code> being
              stamped on each attendance row under a <code>WHERE bill_id IS NULL</code> guard.
            </Alert>
          ) : (
            <>
              <DefinitionList
                rows={[
                  ['Period', `${formatDate(period.from)} to ${formatDate(period.to)}`],
                  ['Approved rows, unbilled', String(summary?.rows ?? 0)],
                  ['Days', String(summary?.days ?? 0)],
                  ['Person-days', String(summary?.headcountDays ?? 0)],
                  ['Overtime hours (recorded, unpriced)', String(summary?.overtimeHours ?? 0)],
                  ['Gross this would bill', <Money paise={summary?.grossPaise ?? 0} />],
                ]}
              />
              {summary !== null && summary.unapproved > 0 ? (
                <Alert tone="error">
                  {summary.unapproved} row{summary.unapproved === 1 ? '' : 's'} in this period{' '}
                  {summary.unapproved === 1 ? 'is' : 'are'} not approved, and generation will refuse rather than
                  leave {summary.unapproved === 1 ? 'it' : 'them'} behind unbilled for good. Approve{' '}
                  {summary.unapproved === 1 ? 'it' : 'them'} on the{' '}
                  <a
                    href={`/app/hr/contractor-attendance?contractorId=${contractorId}&projectId=${projectId}&date=${period.to}`}
                  >
                    entry screen
                  </a>{' '}
                  first.
                </Alert>
              ) : null}
              <form class="ncc-stack" method="post" action="/api/hr/contractor-bills/generate">
                <CsrfInput token={session.csrfToken} />
                <input type="hidden" name="contractorId" value={String(contractorId)} />
                <input type="hidden" name="projectId" value={String(projectId)} />
                <input type="hidden" name="from" value={period.from} />
                <input type="hidden" name="to" value={period.to} />
                <div class="ncc-row">
                  <FormField
                    label="Retention %"
                    name="retentionPct"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    hint="Blank uses finance.retention_default_pct."
                  />
                  <FormField
                    label="TDS %"
                    name="tdsPct"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    hint="Blank uses finance.tds_default_pct."
                  />
                  <FormField
                    label="Advance recovered (rupees)"
                    name="advanceRecovered"
                    type="number"
                    step="0.01"
                    min="0"
                    hint="Typed: no advance table exists. DECISIONS 18.6."
                  />
                  <FormField
                    label="Penalty (rupees)"
                    name="penalty"
                    type="number"
                    step="0.01"
                    min="0"
                    hint="Liquidated damages, a judgement."
                  />
                </div>
                <p>
                  <button class="ncc-btn ncc-btn-primary" type="submit">
                    Generate the bill
                  </button>
                </p>
                <p class="ncc-hint">
                  The gross is never typed: rule 2 sums it from approved attendance inside the transaction and
                  stamps <code>bill_id</code> on every row it consumed, so the same day cannot reach two bills.
                </p>
              </form>
            </>
          )}
        </Panel>
      ) : null}
    </>
  )
})

/**
 * One bill, with the attendance it was built from.
 *
 * The finance line at the bottom is the point of this page. 6.8 rule 1 creates
 * the `expenses` row when the bill is approved, and that posting is not built
 * yet, so an approved bill with no `expense_id` is the normal state today. A page
 * that showed an approved bill without saying so is the screen somebody posts a
 * second time from.
 */
hr.get('/app/hr/contractor-bills/:billId', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const db = c.get('db')
  const session = c.get('session')!
  const billId = idParam(c, 'billId')
  const bill = await q.findContractorBill(db, billId)
  if (bill === undefined) throw new NotFoundError('That contractor bill does not exist.')
  const lines = await q.contractorAttendance(db, { billId })

  const deduction = (label: string, paise: number) =>
    [label, paise === 0 ? <span class="ncc-muted">nil</span> : <Money paise={-paise} />] as [string, Child]

  return page(
    c,
    {
      title: bill.bill_no,
      path: '/app/hr/contractor-bills',
      subtitle: `${bill.contractor_name} · ${bill.project_code} · ${formatDate(bill.period_from)} to ${formatDate(bill.period_to)}`,
      actions: (
        <a class="ncc-btn" href="/app/hr/contractor-bills">
          All bills
        </a>
      ),
    },
    <>
      {banner(c)}
      <div class="ncc-grid ncc-grid--kpi">
        <KpiCard label="Gross" value={<Money paise={bill.gross_paise} />} hint={`${lines.length} attendance rows`} />
        <KpiCard label="Net payable" value={<Money paise={bill.net_payable_paise} />} hint="after deductions" />
        <KpiCard label="Status" value={<StatusBadge status={bill.status} />} hint={`bill ${bill.id}`} />
      </div>
      <Panel title="The figures">
        <DefinitionList
          rows={[
            ['Gross from approved attendance', <Money paise={bill.gross_paise} />],
            deduction('Retention', bill.retention_paise),
            deduction('TDS', bill.tds_paise),
            deduction('Advance recovered', bill.advance_recovered_paise),
            deduction('Penalty', bill.penalty_paise),
            ['Net payable', <Money paise={bill.net_payable_paise} />],
            ['PAN', bill.contractor_pan ?? <span class="ncc-badge ncc-badge-warn">not recorded</span>],
            ['GSTIN', bill.contractor_gstin ?? <span class="ncc-muted">-</span>],
            ['Raised by', bill.created_by_name ?? <span class="ncc-muted">-</span>],
            [
              'Approved',
              bill.approved_at === null ? (
                <span class="ncc-muted">not yet</span>
              ) : (
                <>
                  <DateText value={bill.approved_at} withTime /> by {bill.approved_by_name ?? 'unknown'}
                </>
              ),
            ],
          ]}
        />
        {bill.contractor_pan === null ? (
          <Alert tone="warn">
            No PAN is on file. Section 206AA would put TDS at 20% and this bill has not applied that -- the rate
            used is whatever was entered or defaulted. DECISIONS 18.7 records 206AA as unimplemented.
          </Alert>
        ) : null}
      </Panel>
      <Panel title="Attendance on this bill">
        <DataTable
          columns={contractorAttendanceColumns({ showContractor: false })}
          rows={lines}
          empty="No attendance row points at this bill."
          caption="These rows carry bill_id and can no longer be corrected on the entry screen."
        />
      </Panel>
      <Panel title="Finance">
        <DefinitionList
          rows={[
            ['Identity finance keys on', <code>(contractor_bills, {String(bill.id)})</code>],
            [
              'Expense row',
              bill.expense_id === null ? (
                <span class="ncc-muted">none yet -- 6.8 rule 1 is not built</span>
              ) : (
                <>#{bill.expense_id}</>
              ),
            ],
          ]}
        />
        <p class="ncc-hint">
          When 6.8 lands, approving a bill writes one <code>expenses</code> row with{' '}
          <code>source_type='contractor_bill'</code>, <code>source_table='contractor_bills'</code> and{' '}
          <code>source_id={String(bill.id)}</code>, and <code>expense_id</code> above becomes the back-link. That
          id is immutable; <code>{bill.bill_no}</code> is its human-facing form.
        </p>
      </Panel>
      {bill.approved_at === null && canContractors(c) ? (
        <Panel title="Approve">
          <form method="post" action={`/api/hr/contractor-bills/${bill.id}/approve`}>
            <CsrfInput token={session.csrfToken} />
            <button class="ncc-btn ncc-btn-primary" type="submit">
              Approve this bill
            </button>
            <p class="ncc-hint">
              Checked against your approval limit for document type <code>expense</code> -- the ENUM in 002 has no{' '}
              <code>contractor_bill</code> member -- and against the gross, not the net, because the gross is what
              the project commits. <code>approval_limits</code> is empty pending 8.2, so this refuses for now.
            </p>
          </form>
        </Panel>
      ) : null}
    </>
  )
})

hr.post('/api/hr/contractor-bills/generate', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const body = await readBody(c)
  const parsed = contractorBillGenerateSchema.safeParse(body)
  const back = `/app/hr/contractor-bills?contractorId=${String(body['contractorId'] ?? '')}&projectId=${String(
    body['projectId'] ?? ''
  )}&from=${String(body['from'] ?? '')}&to=${String(body['to'] ?? '')}`
  if (!parsed.success) return errRedirect(c, back, firstError(parsed.error))

  return guard(c, back, async () => {
    const r = await svc.generateContractorBill(c.get('db'), actorOf(c), parsed.data)
    const warn = r.noPan ? ' The contractor has no PAN on file; 206AA is not applied.' : ''
    return `${r.billNo} raised from ${r.rows} approved row${r.rows === 1 ? '' : 's'} over ${r.days} day${r.days === 1 ? '' : 's'}: gross ${formatPaise(r.grossPaise)}, net payable ${formatPaise(r.netPayablePaise)} after ${r.retentionBp / 100}% retention and ${r.tdsBp / 100}% TDS.${warn}`
  })
})

hr.post(
  '/api/hr/contractor-bills/:billId/approve',
  requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE),
  async (c) => {
    const billId = idParam(c, 'billId')
    const back = `/app/hr/contractor-bills/${billId}`
    return guard(c, back, async () => {
      const r = await svc.approveContractorBill(c.get('db'), actorOf(c), billId, c.get('roleKeys'))
      return `${r.billNo} approved as ${r.limitRoleKey}: gross ${formatPaise(r.grossPaise)}, net payable ${formatPaise(r.netPayablePaise)}. It does not reach finance until 6.8 rule 1 is built.`
    })
  }
)





hr.get('/app/hr/recruiting', requirePermission(PERMISSIONS.HR_RECRUIT_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('applicants')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Recruiting', path: '/app/hr/recruiting' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from applicants" />
      </div>
      <Panel title="Recruiting">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

export default hr
