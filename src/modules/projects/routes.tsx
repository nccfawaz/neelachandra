import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../types.js'
import { currentUser, currentScope } from '../../types.js'
import { page, banner, okRedirect, errRedirect, queryParam } from '../../dashboard/render.js'
import {
  Alert,
  DataTable,
  DateText,
  DefinitionList,
  FormField,
  Money,
  Panel,
  Progress,
  Qty,
  StatusBadge,
  Tabs,
  type Column,
} from '../../dashboard/components/index.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireProjectAccess } from '../../middleware/requireProjectAccess.js'
import { PERMISSIONS } from '../../lib/permissions.js'
import { readBody } from '../../middleware/csrf.js'
import { NotFoundError } from '../../lib/errors.js'
import { formatDate } from '../../lib/dates.js'
import { today } from '../../lib/dates.js'
import * as q from './queries.js'
import * as svc from './service.js'
import {
  approvalSchema,
  createProjectSchema,
  dprSchema,
  firstError,
  projectStatusSchema,
  qualityCheckSchema,
  snagSchema,
  snagStatusSchema,
  stageProgressSchema,
  DELIVERY_MODELS,
  JURISDICTIONS,
  PROJECT_TYPES,
} from './schemas.js'

/**
 * Projects routes (spec 6.3).
 *
 * Every detail route sits behind requireProjectAccess, which 404s rather
 * than 403s an unassigned project. Cost visibility is passed into the
 * queries as canViewCost so the money columns are absent from the SELECT for
 * a supervisor, not merely hidden in the template.
 */

const projects = new Hono<AppEnv>()

type Ctx = Context<AppEnv>

function actorOf(c: Ctx): svc.Actor {
  return { userId: currentUser(c).id, ip: c.get('clientIp') }
}

function canCost(c: Ctx): boolean {
  return c.get('perms').has(PERMISSIONS.PROJECTS_VIEW_COST)
}

function idParam(c: Ctx, name = 'projectId'): number {
  const n = Number(c.req.param(name))
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('Not found')
  return n
}

const TABS = [
  'overview',
  'stages',
  'dpr',
  'quality',
  'milestones',
  'snags',
  'approvals',
  'materials',
  'cost',
  'documents',
  'team',
] as const
type TabName = (typeof TABS)[number]

function tabsFor(projectId: number, perms: Set<string>) {
  const base = TABS.filter((t) => {
    // The cost tab is omitted for a user without the permission, and the
    // route that renders it is guarded separately, so hiding the link is
    // convenience rather than the control (spec 4.2).
    if (t === 'cost') return perms.has(PERMISSIONS.PROJECTS_VIEW_COST)
    return true
  })
  return base.map((t) => ({
    label: t === 'dpr' ? 'Daily reports' : t.charAt(0).toUpperCase() + t.slice(1),
    href: `/app/projects/${projectId}?tab=${t}`,
  }))
}

/* List ------------------------------------------------------------------- */

projects.get('/app/projects', requirePermission(PERMISSIONS.PROJECTS_VIEW), async (c) => {
  const db = c.get('db')
  const cost = canCost(c)
  const status = queryParam(c, 'status')
  const rows = await q.listProjects(db, currentScope(c), { canViewCost: cost, status })

  const columns: Column<q.ProjectListRow>[] = [
    {
      header: 'Project',
      cell: (r) => (
        <>
          <a href={`/app/projects/${r.id}`}>
            <strong>{r.name}</strong>
          </a>
          <div class="ncc-muted">{r.code}</div>
        </>
      ),
    },
    { header: 'Client', cell: (r) => r.client_name },
    { header: 'Type', cell: (r) => r.project_type.replace(/_/g, ' ') },
    { header: 'City', cell: (r) => r.city },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    { header: 'Progress', cell: (r) => <Progress pct={Number(r.physical_progress_pct)} /> },
    {
      header: 'Planned end',
      cell: (r) => (
        <>
          <DateText value={r.planned_end} />
          {r.planned_end && r.planned_end < today() && r.status === 'in_progress' ? (
            <div class="ncc-badge ncc-badge-danger">overdue</div>
          ) : null}
        </>
      ),
    },
    {
      header: 'Contract value',
      numeric: true,
      cell: (r) => <Money paise={r.contract_value_paise ?? null} hidden={!cost} compact />,
    },
  ]

  const statuses = ['', 'mobilising', 'in_progress', 'on_hold', 'snagging', 'handed_over', 'defect_liability', 'closed']

  return page(
    c,
    {
      title: 'Projects',
      path: '/app/projects',
      subtitle: `${rows.length} project${rows.length === 1 ? '' : 's'} you can see`,
      actions: c.get('perms').has(PERMISSIONS.PROJECTS_MANAGE) ? (
        <a class="ncc-btn ncc-btn-primary" href="/app/projects/new">
          New project
        </a>
      ) : null,
    },
    <>
      {banner(c)}
      <form class="ncc-card ncc-row" method="get" action="/app/projects">
        <FormField
          label="Status"
          name="status"
          options={statuses.map((s) => ({
            value: s,
            label: s === '' ? 'All statuses' : s.replace(/_/g, ' '),
            selected: s === (status ?? ''),
          }))}
        />
        <button class="ncc-btn" type="submit">
          Filter
        </button>
      </form>
      <Panel title="Project list">
        <DataTable columns={columns} rows={rows} empty="No projects match. A project you are not assigned to will not appear here." />
      </Panel>
    </>
  )
})

/* Cross-project queues --------------------------------------------------- */

projects.get('/app/projects/dprs', requirePermission(PERMISSIONS.PROJECTS_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const missing = await q.todayDprMissing(db, scope)
  const options = await q.activeProjectOptions(db, scope)

  return page(
    c,
    { title: 'Daily reports', path: '/app/projects/dprs', subtitle: `${missing} active project(s) have no report for today` },
    <>
      {banner(c)}
      <Panel title="File a report">
        <p class="ncc-hint">
          A tracker nobody fills in is worse than a spreadsheet, because it looks authoritative while being stale. The
          nightly job notifies the PM for any active project missing yesterday's report.
        </p>
        <ul>
          {options.map((p) => (
            <li>
              <a href={`/app/projects/${p.id}/dpr/new`}>
                {p.code} {p.name}
              </a>
            </li>
          ))}
        </ul>
        {options.length === 0 ? <div class="ncc-empty">No active projects assigned to you.</div> : null}
      </Panel>
    </>
  )
})

projects.get('/app/projects/snags', requirePermission(PERMISSIONS.PROJECTS_VIEW), async (c) => {
  const db = c.get('db')
  const scope = currentScope(c)
  const { projectScopeFilter } = await import('../../lib/scope.js')
  const scoped = await projectScopeFilter(db, scope)

  let query = db
    .selectFrom('snags')
    .innerJoin('projects', 'projects.id', 'snags.project_id')
    .leftJoin('users', 'users.id', 'snags.assigned_to')
    .select([
      'snags.id',
      'snags.location',
      'snags.trade',
      'snags.severity',
      'snags.status',
      'snags.target_date',
      'snags.description',
      'projects.id as project_id',
      'projects.code as project_code',
      'projects.name as project_name',
      'users.full_name as assigned_to_name',
    ])
    .where('snags.status', 'in', ['open', 'in_progress', 'resolved'])
    .orderBy('snags.severity', 'desc')
    .orderBy('snags.target_date')
    .limit(300)

  if (scoped) query = query.where('snags.project_id', 'in', scoped.length ? scoped : [0])
  const rows = await query.execute()

  const columns: Column<(typeof rows)[number]>[] = [
    {
      header: 'Project',
      cell: (r) => (
        <a href={`/app/projects/${r.project_id}?tab=snags`}>
          {r.project_code} {r.project_name}
        </a>
      ),
    },
    { header: 'Location', cell: (r) => r.location },
    { header: 'Trade', cell: (r) => r.trade },
    { header: 'Defect', cell: (r) => r.description },
    { header: 'Severity', cell: (r) => r.severity },
    { header: 'Assigned', cell: (r) => r.assigned_to_name ?? <span class="ncc-muted">Unassigned</span> },
    {
      header: 'Target',
      cell: (r) => (
        <>
          <DateText value={r.target_date} />
          {r.target_date && r.target_date < today() ? <div class="ncc-badge ncc-badge-danger">overdue</div> : null}
        </>
      ),
    },
    { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  ]

  return page(
    c,
    { title: 'Open snags', path: '/app/projects/snags', subtitle: `${rows.length} defect(s) across your projects` },
    <>
      {banner(c)}
      <Panel title="Snag queue">
        <DataTable columns={columns} rows={rows} empty="No open defects." />
      </Panel>
    </>
  )
})

/* Create ----------------------------------------------------------------- */

projects.get('/app/projects/new', requirePermission(PERMISSIONS.PROJECTS_MANAGE), async (c) => {
  const db = c.get('db')
  const [clients, templates] = await Promise.all([q.clientOptions(db), q.stageTemplateOptions(db)])
  const session = c.get('session')!

  return page(
    c,
    { title: 'New project', path: '/app/projects', subtitle: 'Stages are created from the template in the same transaction' },
    <>
      {banner(c)}
      {clients.length === 0 ? (
        <Alert tone="warn">
          There are no active clients yet. A project needs a client, so create one through a CRM conversion or add a
          client record first.
        </Alert>
      ) : null}
      <form class="ncc-card ncc-stack" method="post" action="/app/projects">
        <input type="hidden" name="nc_csrf" value={session.csrfToken} />
        <FormField label="Project name" name="name" required />
        <FormField
          label="Client"
          name="clientId"
          required
          options={clients.map((cl) => ({ value: String(cl.id), label: `${cl.name} (${cl.code ?? '-'})` }))}
        />
        <FormField
          label="Project type"
          name="projectType"
          required
          options={PROJECT_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
        />
        <FormField
          label="Delivery model"
          name="deliveryModel"
          required
          hint="Drives which costing view the project shows."
          options={DELIVERY_MODELS.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
        />
        <FormField
          label="Stage template"
          name="stageTemplateId"
          hint="Leave blank to use the default for this project type. Weightages must sum to 100."
          options={[
            { value: '', label: 'Automatic' },
            ...templates.map((t) => ({
              value: String(t.id),
              label: `${t.name}${t.is_default ? ' (default)' : ''}`,
            })),
          ]}
        />
        <FormField label="Site address" name="siteAddress" required rows={3} />
        <FormField label="City" name="city" required value="Bengaluru" />
        <FormField
          label="Planning authority"
          name="jurisdiction"
          options={[{ value: '', label: 'Not known yet' }, ...JURISDICTIONS.map((j) => ({ value: j, label: j }))]}
        />
        <FormField label="Built up area (sqft)" name="builtUpAreaSqft" type="number" step="0.01" />
        <FormField label="Plot area (sqft)" name="plotAreaSqft" type="number" step="0.01" />
        <FormField label="Scope of work" name="scopeOfWork" rows={3} />
        <FormField label="Contract value (rupees)" name="contractValuePaise" type="number" step="0.01" />
        <FormField label="Rate per sqft (rupees)" name="ratePerSqftPaise" type="number" step="0.01" />
        <FormField label="Contract signed on" name="contractSignedOn" type="date" hint="Structural warranty runs 10 years from this date." />
        <FormField label="Planned start" name="plannedStart" type="date" />
        <FormField label="Planned end" name="plannedEnd" type="date" />
        <div class="ncc-row">
          <button class="ncc-btn ncc-btn-primary" type="submit">
            Create project
          </button>
          <a class="ncc-btn" href="/app/projects">
            Cancel
          </a>
        </div>
      </form>
    </>
  )
})

projects.post('/app/projects', requirePermission(PERMISSIONS.PROJECTS_MANAGE), async (c) => {
  const parsed = createProjectSchema.safeParse(await readBody(c))
  if (!parsed.success) return errRedirect(c, '/app/projects/new', firstError(parsed.error))

  const { projectId, code } = await svc.createProject(c.get('db'), actorOf(c), parsed.data)
  return okRedirect(c, `/app/projects/${projectId}`, `Project ${code} created.`)
})

/* Detail ----------------------------------------------------------------- */

projects.get(
  '/app/projects/:projectId',
  requirePermission(PERMISSIONS.PROJECTS_VIEW),
  requireProjectAccess(),
  async (c) => {
    const db = c.get('db')
    const projectId = idParam(c)
    const cost = canCost(c)
    const project = await q.findProject(db, projectId, cost)
    if (!project) throw new NotFoundError('Project not found')

    const requested = (queryParam(c, 'tab') ?? 'overview') as TabName
    const tab: TabName = TABS.includes(requested) ? requested : 'overview'
    if (tab === 'cost' && !cost) throw new NotFoundError('Not found')

    const body = await renderTab(c, tab, projectId, project, cost)

    return page(
      c,
      {
        title: project.name,
        path: '/app/projects',
        subtitle: `${project.code} for ${project.client_name}`,
        actions: <StatusBadge status={project.status} />,
      },
      <>
        {banner(c)}
        <Tabs tabs={tabsFor(projectId, c.get('perms'))} active={`/app/projects/${projectId}?tab=${tab}`} />
        {body}
      </>
    )
  }
)

/** The tab fragment endpoint, so a slow tab can be lazy loaded without a route change. */
projects.get(
  '/api/projects/:projectId/tab/:tab',
  requirePermission(PERMISSIONS.PROJECTS_VIEW),
  requireProjectAccess(),
  async (c) => {
    const db = c.get('db')
    const projectId = idParam(c)
    const cost = canCost(c)
    const raw = c.req.param('tab') as TabName
    if (!TABS.includes(raw)) throw new NotFoundError('Not found')
    if (raw === 'cost' && !cost) throw new NotFoundError('Not found')

    const project = await q.findProject(db, projectId, cost)
    if (!project) throw new NotFoundError('Project not found')
    return c.html(await renderTab(c, raw, projectId, project, cost))
  }
)

type ProjectRow = NonNullable<Awaited<ReturnType<typeof q.findProject>>>

async function renderTab(c: Ctx, tab: TabName, projectId: number, project: ProjectRow, cost: boolean) {
  const db = c.get('db')
  const perms = c.get('perms')
  const csrf = c.get('session')!.csrfToken

  switch (tab) {
    case 'overview': {
      const [snagCount, stages] = await Promise.all([
        q.openSnagCount(db, projectId),
        q.projectStages(db, projectId),
      ])
      const contractValue = 'contract_value_paise' in project ? project.contract_value_paise : null
      return (
        <div class="ncc-stack">
          <Panel title="Overview">
            <DefinitionList
              rows={[
                ['Code', project.code],
                ['Client', project.client_name],
                ['Type', project.project_type.replace(/_/g, ' ')],
                ['Delivery model', project.delivery_model.replace(/_/g, ' ')],
                ['Site', `${project.site_address}, ${project.city}`],
                ['Planning authority', project.jurisdiction ?? 'Not recorded'],
                ['Built up area', project.built_up_area_sqft ? `${Number(project.built_up_area_sqft)} sqft` : 'Not recorded'],
                ['Progress', <Progress pct={Number(project.physical_progress_pct)} />],
                ['Planned', `${formatDate(project.planned_start) || '-'} to ${formatDate(project.planned_end) || '-'}`],
                ['Actual', `${formatDate(project.actual_start) || '-'} to ${formatDate(project.actual_end) || '-'}`],
                ['Contract value', <Money paise={contractValue as number | null} hidden={!cost} />],
                ['Open snags', String(snagCount)],
                ['Structural warranty', <DateText value={project.warranty_structural_until} />],
                ['General warranty', <DateText value={project.warranty_general_until} />],
              ]}
            />
            {project.hold_reason ? <Alert tone="warn">On hold: {project.hold_reason}</Alert> : null}
          </Panel>
          {perms.has(PERMISSIONS.PROJECTS_MANAGE) ? (
            <Panel title="Change status">
              <form class="ncc-stack" method="post" action={`/app/projects/${projectId}/status`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <FormField
                  label="New status"
                  name="status"
                  required
                  hint={`From ${project.status.replace(/_/g, ' ')} you can move to: ${
                    svc.ALLOWED_TRANSITIONS[project.status as svc.ProjectStatus]
                      .map((s) => s.replace(/_/g, ' '))
                      .join(', ') || 'nothing further'
                  }.`}
                  options={svc.ALLOWED_TRANSITIONS[project.status as svc.ProjectStatus].map((s) => ({
                    value: s,
                    label: s.replace(/_/g, ' '),
                  }))}
                />
                <FormField label="Reason" name="reason" rows={2} hint="Required for a hold." />
                <button class="ncc-btn ncc-btn-primary" type="submit" disabled={stages.length === 0 && false}>
                  Update status
                </button>
              </form>
            </Panel>
          ) : null}
        </div>
      )
    }

    case 'stages': {
      const stages = await q.projectStages(db, projectId)
      const canUpdate = perms.has(PERMISSIONS.PROJECTS_UPDATE_PROGRESS)
      const columns: Column<(typeof stages)[number]>[] = [
        { header: '#', cell: (r) => String(r.seq), numeric: true },
        {
          header: 'Stage',
          cell: (r) => (
            <>
              <strong>{r.name}</strong>
              {r.predecessor_name ? <div class="ncc-muted">after {r.predecessor_name}</div> : null}
              {Number(r.requires_quality_check) === 1 ? (
                <div class="ncc-badge ncc-badge-warn">quality gate</div>
              ) : null}
            </>
          ),
        },
        { header: 'Weight', cell: (r) => `${Number(r.weightage_pct)}%`, numeric: true },
        { header: 'Progress', cell: (r) => <Progress pct={Number(r.progress_pct)} /> },
        { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        { header: 'Planned end', cell: (r) => <DateText value={r.planned_end} /> },
        {
          header: 'Update',
          cell: (r) =>
            canUpdate ? (
              <form class="ncc-row" method="post" action={`/app/projects/${projectId}/stages/${r.id}/progress`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <input name="progressPct" type="number" min="0" max="100" step="0.01" value={String(Number(r.progress_pct))} style="width:5.5rem" />
                <input name="override" type="text" placeholder="Override reason" style="width:11rem" />
                <button class="ncc-btn" type="submit">
                  Save
                </button>
              </form>
            ) : (
              <span class="ncc-muted">-</span>
            ),
        },
      ]
      return (
        <Panel title="Stages">
          <p class="ncc-hint">
            Project progress is the weighted sum of these rows and cannot be typed directly. A stage will not start
            while its predecessor is incomplete unless an override reason is given.
          </p>
          <DataTable columns={columns} rows={stages} empty="This project has no stages. It was created without a template." />
        </Panel>
      )
    }

    case 'dpr': {
      const [dprs, stoppages] = await Promise.all([q.projectDprs(db, projectId), q.stoppageSummary(db, projectId)])
      const columns: Column<(typeof dprs)[number]>[] = [
        { header: 'Date', cell: (r) => <DateText value={r.report_date} /> },
        { header: 'Weather', cell: (r) => r.weather.replace(/_/g, ' ') },
        {
          header: 'Stopped',
          numeric: true,
          cell: (r) =>
            Number(r.work_stopped_hours) > 0 ? (
              <>
                {Number(r.work_stopped_hours)} h
                <div class="ncc-muted">{r.stoppage_reason.replace(/_/g, ' ')}</div>
              </>
            ) : (
              <span class="ncc-muted">-</span>
            ),
        },
        {
          header: 'Labour',
          numeric: true,
          cell: (r) => `${Number(r.labour_skilled)} + ${Number(r.labour_unskilled)}`,
        },
        { header: 'Work done', cell: (r) => <span>{r.work_done}</span> },
        { header: 'Filed by', cell: (r) => r.submitted_by_name ?? '-' },
        {
          header: 'Review',
          cell: (r) =>
            r.reviewed_at ? (
              <span class="ncc-badge ncc-badge-ok">reviewed</span>
            ) : perms.has(PERMISSIONS.PROJECTS_MANAGE) ? (
              <form method="post" action={`/app/projects/${projectId}/dprs/${r.id}/review`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <button class="ncc-btn" type="submit">
                  Mark reviewed
                </button>
              </form>
            ) : (
              <span class="ncc-muted">pending</span>
            ),
        },
      ]
      return (
        <div class="ncc-stack">
          {stoppages.length > 0 ? (
            <Panel title="Stoppage summary">
              <p class="ncc-hint">
                This is the record a delay notice reads. Monsoon delay is the most common schedule dispute and a dated
                trail is the only defence against a liquidated damages claim.
              </p>
              <DataTable
                columns={[
                  { header: 'Reason', cell: (r: (typeof stoppages)[number]) => String(r.reason).replace(/_/g, ' ') },
                  { header: 'Days', cell: (r: (typeof stoppages)[number]) => String(Number(r.days)), numeric: true },
                  { header: 'Hours lost', cell: (r: (typeof stoppages)[number]) => String(Number(r.hours)), numeric: true },
                ]}
                rows={stoppages}
              />
            </Panel>
          ) : null}
          <Panel
            title="Daily progress reports"
            actions={
              perms.has(PERMISSIONS.PROJECTS_DPR_SUBMIT) ? (
                <a class="ncc-btn ncc-btn-primary" href={`/app/projects/${projectId}/dpr/new`}>
                  File today
                </a>
              ) : null
            }
          >
            <DataTable columns={columns} rows={dprs} empty="No daily reports filed yet." />
          </Panel>
        </div>
      )
    }

    case 'quality': {
      const [checks, stages] = await Promise.all([
        q.projectQualityChecks(db, projectId),
        q.projectStages(db, projectId),
      ])
      const columns: Column<(typeof checks)[number]>[] = [
        { header: 'Check', cell: (r) => r.check_type.replace(/_/g, ' ') },
        { header: 'Stage', cell: (r) => r.stage_name ?? <span class="ncc-muted">Project level</span> },
        { header: 'Tested', cell: (r) => <DateText value={r.tested_on} /> },
        {
          header: 'Target vs actual',
          numeric: true,
          cell: (r) =>
            r.actual_value === null && r.target_value === null ? (
              <span class="ncc-muted">-</span>
            ) : (
              `${r.target_value === null ? '-' : Number(r.target_value)} / ${
                r.actual_value === null ? '-' : Number(r.actual_value)
              } ${r.unit ?? ''}`
            ),
        },
        { header: 'Result', cell: (r) => <StatusBadge status={r.result === 'pass' ? 'passed' : r.result === 'fail' ? 'failed' : r.result} /> },
        { header: 'Lab', cell: (r) => r.lab_name ?? '-' },
        {
          header: 'Sign off',
          cell: (r) =>
            r.signed_off_by_name ? (
              <span>{r.signed_off_by_name}</span>
            ) : perms.has(PERMISSIONS.PROJECTS_QUALITY_SIGNOFF) ? (
              <form method="post" action={`/app/projects/${projectId}/quality-checks/${r.id}/signoff`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <button class="ncc-btn" type="submit">
                  Sign off
                </button>
              </form>
            ) : (
              <span class="ncc-muted">unsigned</span>
            ),
        },
      ]
      return (
        <div class="ncc-stack">
          <Panel title="Quality checks">
            <DataTable columns={columns} rows={checks} empty="No quality checks recorded. Milestones on quality-gated stages cannot be certified until one exists." />
          </Panel>
          {perms.has(PERMISSIONS.PROJECTS_DPR_SUBMIT) ? (
            <Panel title="Record a check">
              <form class="ncc-stack" method="post" action={`/app/projects/${projectId}/quality-checks`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <FormField
                  label="Stage"
                  name="projectStageId"
                  options={[
                    { value: '', label: 'Project level' },
                    ...stages.map((s) => ({ value: String(s.id), label: `${s.seq}. ${s.name}` })),
                  ]}
                />
                <FormField
                  label="Check type"
                  name="checkType"
                  required
                  options={[
                    'concrete_slump',
                    'cube_test_7day',
                    'cube_test_28day',
                    'steel_test',
                    'plumb_level',
                    'waterproofing_ponding',
                    'electrical_insulation',
                    'plumbing_pressure',
                    'soil_compaction',
                    'other',
                  ].map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
                />
                <FormField label="Lab report number" name="referenceNo" />
                <FormField label="Sample taken on" name="sampleTakenOn" type="date" />
                <FormField label="Tested on" name="testedOn" type="date" />
                <FormField label="Target value" name="targetValue" type="number" step="0.01" />
                <FormField label="Actual value" name="actualValue" type="number" step="0.01" />
                <FormField label="Unit" name="unit" placeholder="mm or N/mm2" />
                <FormField
                  label="Result"
                  name="result"
                  required
                  options={['pending', 'pass', 'fail', 'retest'].map((r) => ({ value: r, label: r }))}
                />
                <FormField label="Lab name" name="labName" />
                <button class="ncc-btn ncc-btn-primary" type="submit">
                  Record check
                </button>
              </form>
            </Panel>
          ) : null}
        </div>
      )
    }

    case 'milestones': {
      const milestones = await q.projectMilestones(db, projectId, cost)
      const columns: Column<(typeof milestones)[number]>[] = [
        { header: '#', cell: (r) => String(r.seq), numeric: true },
        { header: 'Milestone', cell: (r) => <strong>{r.name}</strong> },
        { header: 'Trigger stage', cell: (r) => r.trigger_stage ?? <span class="ncc-muted">None</span> },
        {
          header: 'Stage progress',
          cell: (r) =>
            r.trigger_stage_progress === null || r.trigger_stage_progress === undefined ? (
              <span class="ncc-muted">-</span>
            ) : (
              <Progress pct={Number(r.trigger_stage_progress)} />
            ),
        },
        { header: 'Percent', cell: (r) => (r.percent_of_contract === null ? '-' : `${Number(r.percent_of_contract)}%`), numeric: true },
        {
          header: 'Amount',
          numeric: true,
          cell: (r) => <Money paise={'amount_paise' in r ? (r.amount_paise as number | null) : null} hidden={!cost} />,
        },
        { header: 'Due', cell: (r) => <DateText value={r.due_date} /> },
        { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        {
          header: 'Certify',
          cell: (r) =>
            r.status === 'pending' || r.status === 'ready_to_certify' ? (
              perms.has(PERMISSIONS.PROJECTS_MILESTONE_CERTIFY) ? (
                <form method="post" action={`/app/projects/${projectId}/milestones/${r.id}/certify`}>
                  <input type="hidden" name="nc_csrf" value={csrf} />
                  <button class="ncc-btn" type="submit">
                    Certify
                  </button>
                </form>
              ) : (
                <span class="ncc-muted">-</span>
              )
            ) : (
              <DateText value={r.certified_on} />
            ),
        },
      ]
      return (
        <Panel title="Payment milestones">
          <p class="ncc-hint">
            Certification requires the trigger stage complete and its quality checks passed, including the 28 day cube
            test. That chain is what makes an invoice defensible.
          </p>
          <DataTable columns={columns} rows={milestones} empty="No payment milestones defined for this project." />
        </Panel>
      )
    }

    case 'snags': {
      const [snags, users] = await Promise.all([q.projectSnags(db, projectId), q.assignableUsers(db)])
      const canManage = perms.has(PERMISSIONS.PROJECTS_SNAG_MANAGE)
      const columns: Column<(typeof snags)[number]>[] = [
        { header: 'Location', cell: (r) => <strong>{r.location}</strong> },
        { header: 'Trade', cell: (r) => r.trade },
        { header: 'Defect', cell: (r) => r.description },
        { header: 'Severity', cell: (r) => <StatusBadge status={r.severity === 'structural' || r.severity === 'safety' ? 'overdue' : 'open'} tone={r.severity === 'structural' || r.severity === 'safety' ? 'danger' : 'warn'} /> },
        { header: 'Assigned', cell: (r) => r.assigned_to_name ?? <span class="ncc-muted">Unassigned</span> },
        { header: 'Target', cell: (r) => <DateText value={r.target_date} /> },
        { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        {
          header: 'Move to',
          cell: (r) => {
            const allowed = svc.SNAG_TRANSITIONS[r.status] ?? []
            if (!canManage || allowed.length === 0) return <span class="ncc-muted">-</span>
            return (
              <form class="ncc-row" method="post" action={`/app/projects/${projectId}/snags/${r.id}/status`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <select name="status">
                  {allowed.map((s) => (
                    <option value={s}>{s.replace(/_/g, ' ')}</option>
                  ))}
                </select>
                <button class="ncc-btn" type="submit">
                  Go
                </button>
              </form>
            )
          },
        },
      ]
      return (
        <div class="ncc-stack">
          <Panel title="Snag list">
            <p class="ncc-hint">
              Handover is refused while a structural or safety snag is open, because that would transfer a live hazard
              to the client.
            </p>
            <DataTable columns={columns} rows={snags} empty="No defects recorded." />
          </Panel>
          {canManage ? (
            <Panel title="Raise a snag">
              <form class="ncc-stack" method="post" action={`/app/projects/${projectId}/snags`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <FormField label="Location" name="location" required placeholder="First floor, master bedroom" />
                <FormField
                  label="Trade"
                  name="trade"
                  required
                  options={['civil', 'plaster', 'painting', 'electrical', 'plumbing', 'carpentry', 'flooring', 'waterproofing', 'fabrication', 'other'].map(
                    (t) => ({ value: t, label: t })
                  )}
                />
                <FormField label="Description" name="description" required rows={2} />
                <FormField
                  label="Severity"
                  name="severity"
                  required
                  options={['cosmetic', 'functional', 'structural', 'safety'].map((s) => ({ value: s, label: s }))}
                />
                <FormField
                  label="Raised by"
                  name="raisedSource"
                  required
                  options={['internal', 'client', 'consultant'].map((s) => ({ value: s, label: s }))}
                />
                <FormField
                  label="Assign to"
                  name="assignedTo"
                  options={[{ value: '', label: 'Unassigned' }, ...users.map((u) => ({ value: String(u.id), label: u.full_name }))]}
                />
                <FormField label="Target date" name="targetDate" type="date" />
                <button class="ncc-btn ncc-btn-primary" type="submit">
                  Raise snag
                </button>
              </form>
            </Panel>
          ) : null}
        </div>
      )
    }

    case 'approvals': {
      const [approvals, stages] = await Promise.all([
        q.projectApprovals(db, projectId, cost),
        q.projectStages(db, projectId),
      ])
      const columns: Column<(typeof approvals)[number]>[] = [
        { header: 'Authority', cell: (r) => <strong>{r.authority}</strong> },
        { header: 'Approval', cell: (r) => r.approval_type },
        { header: 'Reference', cell: (r) => r.reference_no ?? '-' },
        { header: 'Applied', cell: (r) => <DateText value={r.applied_on} /> },
        { header: 'Received', cell: (r) => <DateText value={r.received_on} /> },
        {
          header: 'Valid until',
          cell: (r) => (
            <>
              <DateText value={r.valid_until} />
              {r.valid_until && r.valid_until < today() ? <div class="ncc-badge ncc-badge-danger">expired</div> : null}
            </>
          ),
        },
        { header: 'Fee', numeric: true, cell: (r) => <Money paise={'fee_paise' in r ? (r.fee_paise as number | null) : null} hidden={!cost} /> },
        { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        { header: 'Blocks', cell: (r) => r.blocks_stage ?? '-' },
      ]
      return (
        <div class="ncc-stack">
          <Panel title="Statutory approvals">
            <DataTable columns={columns} rows={approvals} empty="No approvals recorded." />
          </Panel>
          {perms.has(PERMISSIONS.PROJECTS_MANAGE) ? (
            <Panel title="Add an approval">
              <form class="ncc-stack" method="post" action={`/app/projects/${projectId}/approvals`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <FormField
                  label="Authority"
                  name="authority"
                  required
                  options={['BBMP', 'BMRDA', 'BDA', 'Gram Panchayat', 'TUDA', 'KIADB', 'BESCOM', 'BWSSB', 'KSPCB', 'Fire', 'Lift Inspectorate', 'Other'].map(
                    (a) => ({ value: a, label: a })
                  )}
                />
                <FormField label="Approval type" name="approvalType" required placeholder="Plan sanction" />
                <FormField label="Reference number" name="referenceNo" />
                <FormField label="Applied on" name="appliedOn" type="date" />
                <FormField label="Received on" name="receivedOn" type="date" />
                <FormField label="Valid until" name="validUntil" type="date" />
                <FormField label="Fee (rupees)" name="feePaise" type="number" step="0.01" />
                <FormField
                  label="Status"
                  name="status"
                  required
                  options={['not_started', 'applied', 'queried', 'received', 'rejected', 'expired'].map((s) => ({
                    value: s,
                    label: s.replace(/_/g, ' '),
                  }))}
                />
                <FormField
                  label="Blocks stage"
                  name="blocksStageId"
                  options={[{ value: '', label: 'None' }, ...stages.map((s) => ({ value: String(s.id), label: s.name }))]}
                />
                <button class="ncc-btn ncc-btn-primary" type="submit">
                  Add approval
                </button>
              </form>
            </Panel>
          ) : null}
        </div>
      )
    }

    case 'materials': {
      const materials = await q.projectMaterials(db, projectId, cost)
      const columns: Column<(typeof materials)[number]>[] = [
        {
          header: 'Item',
          cell: (r) => (
            <>
              <strong>{r.item_name}</strong>
              <div class="ncc-muted">{r.item_code}</div>
            </>
          ),
        },
        { header: 'Issued', numeric: true, cell: (r) => <Qty value={Number(r.qty_issued)} unit={r.unit} /> },
        { header: 'Returned', numeric: true, cell: (r) => <Qty value={Number(r.qty_returned)} unit={r.unit} /> },
        {
          header: 'Net consumed',
          numeric: true,
          cell: (r) => <Qty value={Number(r.qty_issued) - Number(r.qty_returned)} unit={r.unit} />,
        },
        {
          header: 'Value',
          numeric: true,
          cell: (r) => <Money paise={'value_paise' in r ? Number(r.value_paise ?? 0) : null} hidden={!cost} compact />,
        },
      ]
      return (
        <Panel title="Material issued to this site">
          <DataTable columns={columns} rows={materials} empty="No material issued to this project yet." />
        </Panel>
      )
    }

    case 'cost': {
      const data = await q.projectBudgetVsActual(db, projectId)
      const columns: Column<(typeof data.lines)[number]>[] = [
        { header: 'Cost head', cell: (r) => <strong>{r.cost_head}</strong> },
        { header: 'Description', cell: (r) => r.description ?? '-' },
        { header: 'Budget', numeric: true, cell: (r) => <Money paise={Number(r.amount_paise)} compact /> },
        { header: 'Actual', numeric: true, cell: (r) => <Money paise={Number(r.spent)} compact /> },
        {
          header: 'Variance',
          numeric: true,
          cell: (r) => {
            const v = Number(r.amount_paise) - Number(r.spent)
            return (
              <span class={v < 0 ? 'ncc-badge ncc-badge-danger' : undefined}>
                <Money paise={v} compact />
              </span>
            )
          },
        },
      ]
      return (
        <div class="ncc-stack">
          {data.budget ? (
            <Panel title={`Approved budget version ${data.budget.version}`}>
              <DefinitionList
                rows={[
                  ['Type', String(data.budget.budget_type).replace(/_/g, ' ')],
                  ['Total', <Money paise={Number(data.budget.total_paise)} />],
                  ['Contingency', `${Number(data.budget.contingency_pct)}%`],
                  ['Approved', <DateText value={data.budget.approved_at} withTime />],
                ]}
              />
            </Panel>
          ) : (
            <Alert tone="warn">
              This project has no approved budget, so overrun blocking on expense approval has nothing to check
              against. Set one under Money, Budgets.
            </Alert>
          )}
          <Panel title="Budget against actual by cost head">
            <DataTable columns={columns} rows={data.lines} empty="No budget lines." />
            {data.uncategorised > 0 ? (
              <Alert tone="warn">
                <Money paise={data.uncategorised} /> of spend sits on cost heads with no budget line. Either the budget
                is incomplete or the expense was coded to the wrong head.
              </Alert>
            ) : null}
          </Panel>
        </div>
      )
    }

    case 'documents': {
      const docs = await q.projectDocuments(db, projectId)
      const columns: Column<(typeof docs)[number]>[] = [
        { header: 'Type', cell: (r) => r.doc_type },
        { header: 'Title', cell: (r) => <strong>{r.title}</strong> },
        { header: 'Revision', cell: (r) => r.revision ?? '-' },
        { header: 'Current', cell: (r) => (Number(r.is_current) === 1 ? <span class="ncc-badge ncc-badge-ok">current</span> : <span class="ncc-muted">superseded</span>) },
        { header: 'File', cell: (r) => (r.original_name ? <a href={`/api/files/${r.id}`}>{r.original_name}</a> : '-') },
        { header: 'Added', cell: (r) => <DateText value={r.created_at} withTime /> },
      ]
      return (
        <Panel title="Documents">
          <p class="ncc-hint">
            A superseded revision is kept, not deleted. When a wall is built to the wrong revision the only useful
            question is which revision was on site.
          </p>
          <DataTable columns={columns} rows={docs} empty="No documents uploaded." />
        </Panel>
      )
    }

    case 'team': {
      const [team, users] = await Promise.all([q.projectAssignments(db, projectId), q.assignableUsers(db)])
      const columns: Column<(typeof team)[number]>[] = [
        {
          header: 'Person',
          cell: (r) => (
            <>
              <strong>{r.full_name}</strong>
              <div class="ncc-muted">{r.email}</div>
            </>
          ),
        },
        { header: 'Role on project', cell: (r) => r.assignment_role },
        { header: 'From', cell: (r) => <DateText value={r.from_date} /> },
        { header: 'To', cell: (r) => <DateText value={r.to_date} /> },
      ]
      return (
        <div class="ncc-stack">
          <Panel title="Project team">
            <p class="ncc-hint">
              This list is what row-level scoping reads. Removing someone here removes their access to the project.
            </p>
            <DataTable columns={columns} rows={team} empty="Nobody assigned. Only unscoped roles can see this project." />
          </Panel>
          {perms.has(PERMISSIONS.PROJECTS_ASSIGN_STAFF) ? (
            <Panel title="Replace the team">
              <form class="ncc-stack" method="post" action={`/app/projects/${projectId}/team`}>
                <input type="hidden" name="nc_csrf" value={csrf} />
                <p class="ncc-hint">
                  Tick everyone who should have access and choose their role. Submitting replaces the whole list, so a
                  person left unticked loses access.
                </p>
                {users.map((u) => {
                  const existing = team.find((t) => Number(t.user_id) === u.id)
                  return (
                    <div class="ncc-row">
                      <label>
                        <input type="checkbox" name="userIds" value={String(u.id)} checked={Boolean(existing)} /> {u.full_name}
                      </label>
                      <select name={`role_${u.id}`}>
                        {['pm', 'supervisor', 'qs', 'accounts', 'observer'].map((r) => (
                          <option value={r} selected={existing?.assignment_role === r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })}
                <button class="ncc-btn ncc-btn-primary" type="submit">
                  Save team
                </button>
              </form>
            </Panel>
          ) : null}
        </div>
      )
    }
  }
}

/* Mutations -------------------------------------------------------------- */

projects.post(
  '/app/projects/:projectId/status',
  requirePermission(PERMISSIONS.PROJECTS_MANAGE),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const parsed = projectStatusSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, `/app/projects/${projectId}`, firstError(parsed.error))
    await svc.setProjectStatus(c.get('db'), actorOf(c), projectId, parsed.data.status, parsed.data.reason)
    return okRedirect(c, `/app/projects/${projectId}`, `Status set to ${parsed.data.status.replace(/_/g, ' ')}.`)
  }
)

projects.post(
  '/app/projects/:projectId/stages/:stageId/progress',
  requirePermission(PERMISSIONS.PROJECTS_UPDATE_PROGRESS),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const stageId = idParam(c, 'stageId')
    const parsed = stageProgressSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, `/app/projects/${projectId}?tab=stages`, firstError(parsed.error))

    const result = await svc.setStageProgress(c.get('db'), actorOf(c), {
      projectId,
      stageId,
      progressPct: parsed.data.progressPct,
      override: parsed.data.override,
      canOverride: c.get('perms').has(PERMISSIONS.PROJECTS_MANAGE),
    })
    return okRedirect(
      c,
      `/app/projects/${projectId}?tab=stages`,
      `Stage set to ${result.stageProgress}%. Project now ${result.projectProgress}%.`
    )
  }
)

projects.get(
  '/app/projects/:projectId/dpr/new',
  requirePermission(PERMISSIONS.PROJECTS_DPR_SUBMIT),
  requireProjectAccess(),
  async (c) => {
    const db = c.get('db')
    const projectId = idParam(c)
    const project = await q.findProject(db, projectId, false)
    if (!project) throw new NotFoundError('Project not found')
    const stages = await q.projectStages(db, projectId)
    const csrf = c.get('session')!.csrfToken
    const filed = await q.dprExists(db, projectId, today())

    /*
     * Deliberately a plain form post, single column, native date input.
     * A supervisor fills this standing on a slab on a phone with two bars of
     * signal, so it must work with no JavaScript at all.
     */
    return page(
      c,
      {
        title: 'Daily progress report',
        path: '/app/projects',
        subtitle: `${project.code}, ${formatDate(today())}`,
      },
      <>
        {banner(c)}
        {filed ? <Alert tone="warn">A report is already filed for today. Submitting again replaces it.</Alert> : null}
        <form class="ncc-card ncc-stack" method="post" action={`/app/projects/${projectId}/dpr`}>
          <input type="hidden" name="nc_csrf" value={csrf} />
          <FormField label="Report date" name="reportDate" type="date" required value={today()} max={today()} />
          <FormField
            label="Weather"
            name="weather"
            required
            options={['clear', 'cloudy', 'light_rain', 'heavy_rain', 'unworkable'].map((w) => ({
              value: w,
              label: w.replace(/_/g, ' '),
            }))}
          />
          <FormField label="Hours work was stopped" name="workStoppedHours" type="number" step="0.5" min="0" max="24" value="0" />
          <FormField
            label="Reason for stoppage"
            name="stoppageReason"
            required
            hint="Rain hours are contractual. Record them even when the day was partly worked."
            options={['none', 'rain', 'material_shortage', 'labour_shortage', 'power_failure', 'client_instruction', 'statutory', 'equipment_breakdown', 'safety_incident'].map(
              (r) => ({ value: r, label: r.replace(/_/g, ' ') })
            )}
          />
          <FormField label="Skilled labour on site" name="labourSkilled" type="number" min="0" value="0" />
          <FormField label="Unskilled labour on site" name="labourUnskilled" type="number" min="0" value="0" />
          <FormField label="Work done today" name="workDone" required rows={4} />
          <FormField label="Issues" name="issues" rows={2} />
          <FormField label="Instructions received" name="instructionsReceived" rows={2} />
          {stages.map((s) => (
            <FormField
              label={`${s.name} progress at end of day`}
              name={`stage_${s.id}`}
              type="number"
              step="0.01"
              min={String(Number(s.progress_pct))}
              max="100"
              value={String(Number(s.progress_pct))}
              hint={`Currently ${Number(s.progress_pct)}%. Leave as is if it did not move.`}
            />
          ))}
          <button class="ncc-btn ncc-btn-primary" type="submit">
            File report
          </button>
        </form>
      </>
    )
  }
)

projects.post(
  '/app/projects/:projectId/dpr',
  requirePermission(PERMISSIONS.PROJECTS_DPR_SUBMIT),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const body = await readBody(c)
    const parsed = dprSchema.safeParse(body)
    if (!parsed.success) return errRedirect(c, `/app/projects/${projectId}/dpr/new`, firstError(parsed.error))

    // Stage fields arrive as stage_<id>. Collected here rather than in the
    // schema because the field names are data driven.
    const stageProgress: Array<{ stageId: number; pct: number }> = []
    for (const [key, value] of Object.entries(body)) {
      if (!key.startsWith('stage_')) continue
      const stageId = Number(key.slice(6))
      const pct = Number(value)
      if (Number.isInteger(stageId) && stageId > 0 && Number.isFinite(pct)) {
        stageProgress.push({ stageId, pct })
      }
    }

    const result = await svc.submitDpr(c.get('db'), actorOf(c), projectId, { ...parsed.data, stageProgress })
    return okRedirect(
      c,
      `/app/projects/${projectId}?tab=dpr`,
      result.replaced ? 'Report for that date replaced.' : 'Report filed.'
    )
  }
)

projects.post(
  '/app/projects/:projectId/dprs/:dprId/review',
  requirePermission(PERMISSIONS.PROJECTS_MANAGE),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    await svc.reviewDpr(c.get('db'), actorOf(c), idParam(c, 'dprId'))
    return okRedirect(c, `/app/projects/${projectId}?tab=dpr`, 'Report marked reviewed.')
  }
)

projects.post(
  '/app/projects/:projectId/quality-checks',
  requirePermission(PERMISSIONS.PROJECTS_DPR_SUBMIT),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const parsed = qualityCheckSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, `/app/projects/${projectId}?tab=quality`, firstError(parsed.error))
    await svc.createQualityCheck(c.get('db'), actorOf(c), projectId, parsed.data)
    return okRedirect(c, `/app/projects/${projectId}?tab=quality`, 'Quality check recorded.')
  }
)

projects.post(
  '/app/projects/:projectId/quality-checks/:checkId/signoff',
  requirePermission(PERMISSIONS.PROJECTS_QUALITY_SIGNOFF),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    await svc.signOffQualityCheck(c.get('db'), actorOf(c), idParam(c, 'checkId'))
    return okRedirect(c, `/app/projects/${projectId}?tab=quality`, 'Check signed off.')
  }
)

projects.post(
  '/app/projects/:projectId/milestones/:msId/certify',
  requirePermission(PERMISSIONS.PROJECTS_MILESTONE_CERTIFY),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    await svc.certifyMilestone(c.get('db'), actorOf(c), projectId, idParam(c, 'msId'))
    return okRedirect(c, `/app/projects/${projectId}?tab=milestones`, 'Milestone certified and ready to invoice.')
  }
)

projects.post(
  '/app/projects/:projectId/snags',
  requirePermission(PERMISSIONS.PROJECTS_SNAG_MANAGE),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const parsed = snagSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, `/app/projects/${projectId}?tab=snags`, firstError(parsed.error))
    await svc.createSnag(c.get('db'), actorOf(c), projectId, parsed.data)
    return okRedirect(c, `/app/projects/${projectId}?tab=snags`, 'Snag raised.')
  }
)

projects.post(
  '/app/projects/:projectId/snags/:snagId/status',
  requirePermission(PERMISSIONS.PROJECTS_SNAG_MANAGE),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const parsed = snagStatusSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, `/app/projects/${projectId}?tab=snags`, firstError(parsed.error))
    await svc.setSnagStatus(c.get('db'), actorOf(c), idParam(c, 'snagId'), parsed.data.status)
    return okRedirect(c, `/app/projects/${projectId}?tab=snags`, 'Snag updated.')
  }
)

projects.post(
  '/app/projects/:projectId/approvals',
  requirePermission(PERMISSIONS.PROJECTS_MANAGE),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const parsed = approvalSchema.safeParse(await readBody(c))
    if (!parsed.success) return errRedirect(c, `/app/projects/${projectId}?tab=approvals`, firstError(parsed.error))
    await svc.createApproval(c.get('db'), actorOf(c), projectId, parsed.data)
    return okRedirect(c, `/app/projects/${projectId}?tab=approvals`, 'Approval recorded.')
  }
)

projects.post(
  '/app/projects/:projectId/team',
  requirePermission(PERMISSIONS.PROJECTS_ASSIGN_STAFF),
  requireProjectAccess(),
  async (c) => {
    const projectId = idParam(c)
    const body = await readBody(c)
    const raw = body.userIds
    const ids = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw])
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0)

    const members = ids.map((userId) => {
      const role = body[`role_${userId}`]
      return { userId, assignmentRole: typeof role === 'string' ? role : 'observer' }
    })

    await svc.replaceTeam(c.get('db'), actorOf(c), projectId, members)
    return okRedirect(c, `/app/projects/${projectId}?tab=team`, `Team set to ${members.length} member(s).`)
  }
)

export default projects
