import { Hono } from 'hono'
import type { Context } from 'hono'
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
import { today } from '../../lib/dates.js'
import * as q from './queries.js'
import * as svc from './service.js'
import {
  compensationSchema,
  documentSchema,
  employeeSchema,
  exitSchema,
  firstError,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  EXIT_TYPES,
  GENDERS,
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
          // Linked only for a holder of hr.attendance_record, because that is
          // what /app/hr/attendance is guarded by. Spec line 1723 gives that GET
          // to hr.employee_view, but the 002 role seed grants the two
          // permissions to different roles -- hr_manager holds both, while an
          // employee_view-only holder would follow this link into a 403. The
          // count still shows; only the link is withheld.
          href={c.get('perms').has(PERMISSIONS.HR_ATTENDANCE_RECORD) ? '/app/hr/attendance' : undefined}
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

/* Still stubs: attendance, leave, contractors, recruiting ----------------- */

/**
 * These four keep the shape the earlier phase left them in.
 *
 * They are mounted, guarded by the permission their sidebar item names, and
 * report the real row count from their primary table, so no link a user can see
 * 404s or 403s while the rest of 6.6 is built out.
 */
hr.get('/app/hr/attendance', requirePermission(PERMISSIONS.HR_ATTENDANCE_RECORD), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('attendance')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Attendance', path: '/app/hr/attendance' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from attendance" />
      </div>
      <Panel title="Attendance">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

hr.get('/app/hr/leave', requirePermission(PERMISSIONS.HR_EMPLOYEE_VIEW), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('leave_requests')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Leave', path: '/app/hr/leave' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from leave_requests" />
      </div>
      <Panel title="Leave">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

hr.get('/app/hr/contractors', requirePermission(PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE), async (c) => {
  const db = c.get('db')
  const row = await db
    .selectFrom('labour_contractors')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  const total = Number(row?.n ?? 0)
  return page(
    c,
    { title: 'Labour contractors', path: '/app/hr/contractors' },
    <>
      {banner(c)}
      <div class="ncc-kpi-row">
        <KpiCard label="Records held" value={String(total)} hint="Live count from labour_contractors" />
      </div>
      <Panel title="Labour contractors">
        <Alert tone="warn">
          The data model behind this screen is migrated. The entry and approval
          forms are the next build phase.
        </Alert>
      </Panel>
    </>
  )
})

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
