import type { Db, Queryable } from '../../db/kysely.js'
import type { ScopeContext } from '../../lib/scope.js'
import { projectScopeFilter } from '../../lib/scope.js'
import { today } from '../../lib/dates.js'

/**
 * Project reads (spec 6.3).
 *
 * Two things are load bearing here.
 *
 * Row-level scoping is applied as a SQL predicate built from
 * projectScopeFilter, never as a JavaScript filter after the fact. A JS
 * filter means the unscoped rows were already selected, already counted in
 * the total, and already in memory next to the response.
 *
 * Cost visibility is a parameter, not a post-processing step. When
 * canViewCost is false the money columns are not in the SELECT at all, so
 * there is no path by which a contract value reaches the HTML for a
 * supervisor (spec 4.3).
 */

export interface ProjectListRow {
  id: number
  code: string
  name: string
  status: string
  city: string
  project_type: string
  physical_progress_pct: number
  planned_end: string | null
  client_name: string
  contract_value_paise?: number | null
}

export async function listProjects(
  db: Db,
  scope: ScopeContext,
  opts: { canViewCost: boolean; status?: string }
): Promise<ProjectListRow[]> {
  const scoped = await projectScopeFilter(db, scope)

  let query = db
    .selectFrom('projects')
    .innerJoin('clients', 'clients.id', 'projects.client_id')
    .select([
      'projects.id',
      'projects.code',
      'projects.name',
      'projects.status',
      'projects.city',
      'projects.project_type',
      'projects.physical_progress_pct',
      'projects.planned_end',
      'clients.name as client_name',
    ])
    .orderBy('projects.code')

  if (opts.canViewCost) query = query.select('projects.contract_value_paise')
  if (opts.status) query = query.where('projects.status', '=', opts.status as 'in_progress')
  if (scoped) query = query.where('projects.id', 'in', scoped.length ? scoped : [0])

  return (await query.execute()) as unknown as ProjectListRow[]
}

export async function findProject(db: Queryable, id: number, canViewCost: boolean) {
  let query = db
    .selectFrom('projects')
    .innerJoin('clients', 'clients.id', 'projects.client_id')
    .select([
      'projects.id',
      'projects.code',
      'projects.name',
      'projects.status',
      'projects.project_type',
      'projects.delivery_model',
      'projects.site_address',
      'projects.city',
      'projects.jurisdiction',
      'projects.built_up_area_sqft',
      'projects.plot_area_sqft',
      'projects.floors_count',
      'projects.scope_of_work',
      'projects.planned_start',
      'projects.planned_end',
      'projects.actual_start',
      'projects.actual_end',
      'projects.physical_progress_pct',
      'projects.hold_reason',
      'projects.retention_pct',
      'projects.gst_pct',
      'projects.warranty_structural_until',
      'projects.warranty_general_until',
      'projects.contract_signed_on',
      'clients.name as client_name',
      'clients.id as client_id',
      'clients.primary_contact_phone as client_phone',
    ])
    .where('projects.id', '=', id)

  if (canViewCost) {
    query = query.select(['projects.contract_value_paise', 'projects.rate_per_sqft_paise'])
  }

  return query.executeTakeFirst()
}

export async function projectStages(db: Queryable, projectId: number) {
  return db
    .selectFrom('project_stages')
    .leftJoin('project_stages as pred', 'pred.id', 'project_stages.predecessor_stage_id')
    .select([
      'project_stages.id',
      'project_stages.seq',
      'project_stages.name',
      'project_stages.weightage_pct',
      'project_stages.progress_pct',
      'project_stages.status',
      'project_stages.planned_start',
      'project_stages.planned_end',
      'project_stages.actual_start',
      'project_stages.actual_end',
      'project_stages.blocked_reason',
      'project_stages.requires_quality_check',
      'project_stages.predecessor_stage_id',
      'pred.name as predecessor_name',
      'pred.status as predecessor_status',
    ])
    .where('project_stages.project_id', '=', projectId)
    .orderBy('project_stages.seq')
    .execute()
}

export async function projectMilestones(db: Queryable, projectId: number, canViewCost: boolean) {
  let query = db
    .selectFrom('project_milestones')
    .leftJoin('project_stages', 'project_stages.id', 'project_milestones.trigger_stage_id')
    .select([
      'project_milestones.id',
      'project_milestones.seq',
      'project_milestones.name',
      'project_milestones.due_basis',
      'project_milestones.due_date',
      'project_milestones.status',
      'project_milestones.certified_on',
      'project_milestones.percent_of_contract',
      'project_stages.name as trigger_stage',
      'project_stages.status as trigger_stage_status',
      'project_stages.progress_pct as trigger_stage_progress',
    ])
    .where('project_milestones.project_id', '=', projectId)
    .orderBy('project_milestones.seq')

  if (canViewCost) query = query.select('project_milestones.amount_paise')
  return query.execute()
}

export async function projectDprs(db: Queryable, projectId: number, limit = 30) {
  return db
    .selectFrom('daily_progress_reports')
    .leftJoin('users', 'users.id', 'daily_progress_reports.submitted_by')
    .select([
      'daily_progress_reports.id',
      'daily_progress_reports.report_date',
      'daily_progress_reports.weather',
      'daily_progress_reports.work_stopped_hours',
      'daily_progress_reports.stoppage_reason',
      'daily_progress_reports.labour_skilled',
      'daily_progress_reports.labour_unskilled',
      'daily_progress_reports.work_done',
      'daily_progress_reports.issues',
      'daily_progress_reports.reviewed_at',
      'users.full_name as submitted_by_name',
    ])
    .where('daily_progress_reports.project_id', '=', projectId)
    .orderBy('daily_progress_reports.report_date', 'desc')
    .limit(limit)
    .execute()
}

/**
 * The stoppage summary (spec 6.3).
 *
 * Grouped in SQL because the point of the panel is "how many days did rain
 * cost us this project", and answering that in Node means reading every DPR
 * row to produce eight numbers.
 */
export async function stoppageSummary(db: Queryable, projectId: number) {
  return db
    .selectFrom('daily_progress_reports')
    .select((eb) => [
      eb.ref('stoppage_reason').as('reason'),
      eb.fn.countAll<number>().as('days'),
      eb.fn.sum<number>('work_stopped_hours').as('hours'),
    ])
    .where('project_id', '=', projectId)
    .where('stoppage_reason', '!=', 'none')
    .groupBy('stoppage_reason')
    .orderBy('hours', 'desc')
    .execute()
}

export async function projectSnags(db: Queryable, projectId: number) {
  return db
    .selectFrom('snags')
    .leftJoin('users as raiser', 'raiser.id', 'snags.raised_by')
    .leftJoin('users as assignee', 'assignee.id', 'snags.assigned_to')
    .select([
      'snags.id',
      'snags.location',
      'snags.trade',
      'snags.description',
      'snags.severity',
      'snags.status',
      'snags.raised_on',
      'snags.target_date',
      'snags.resolved_on',
      'raiser.full_name as raised_by_name',
      'assignee.full_name as assigned_to_name',
    ])
    .where('snags.project_id', '=', projectId)
    .orderBy('snags.status')
    .orderBy('snags.severity', 'desc')
    .execute()
}

export async function projectAssignments(db: Queryable, projectId: number) {
  return db
    .selectFrom('project_assignments')
    .innerJoin('users', 'users.id', 'project_assignments.user_id')
    .select([
      'project_assignments.id',
      'project_assignments.assignment_role',
      'project_assignments.from_date',
      'project_assignments.to_date',
      'users.full_name',
      'users.email',
      'users.id as user_id',
    ])
    .where('project_assignments.project_id', '=', projectId)
    .orderBy('project_assignments.assignment_role')
    .orderBy('users.full_name')
    .execute()
}

export async function projectQualityChecks(db: Queryable, projectId: number) {
  return db
    .selectFrom('quality_checks')
    .leftJoin('project_stages', 'project_stages.id', 'quality_checks.project_stage_id')
    .leftJoin('users', 'users.id', 'quality_checks.signed_off_by')
    .select([
      'quality_checks.id',
      'quality_checks.check_type',
      'quality_checks.reference_no',
      'quality_checks.result',
      'quality_checks.tested_on',
      'quality_checks.target_value',
      'quality_checks.actual_value',
      'quality_checks.unit',
      'quality_checks.lab_name',
      'project_stages.name as stage_name',
      'users.full_name as signed_off_by_name',
    ])
    .where('quality_checks.project_id', '=', projectId)
    .orderBy('quality_checks.tested_on', 'desc')
    .execute()
}

export async function projectSafety(db: Queryable, projectId: number) {
  return db
    .selectFrom('safety_incidents')
    .select([
      'id',
      'incident_date',
      'severity',
      'affected_person_type',
      'affected_person_name',
      'description',
      'immediate_action',
      'corrective_action',
      'days_lost',
      'reported_to_authority',
      'closed_on',
    ])
    .where('project_id', '=', projectId)
    .orderBy('incident_date', 'desc')
    .execute()
}

export async function projectDocuments(db: Queryable, projectId: number) {
  return db
    .selectFrom('project_documents')
    .leftJoin('files', 'files.id', 'project_documents.file_id')
    .select([
      'project_documents.id',
      'project_documents.doc_type',
      'project_documents.title',
      'project_documents.revision',
      'project_documents.is_current',
      'project_documents.created_at',
      'files.original_name',
      'files.size_bytes',
    ])
    .where('project_documents.project_id', '=', projectId)
    .orderBy('project_documents.doc_type')
    .orderBy('project_documents.revision', 'desc')
    .execute()
}

/** Budget against actual spend, by cost head. Cost permission gated by caller. */
export async function projectBudgetVsActual(db: Db, projectId: number) {
  const budget = await db
    .selectFrom('project_budgets')
    .select(['id', 'version', 'budget_type', 'total_paise', 'contingency_pct', 'status', 'approved_at'])
    .where('project_id', '=', projectId)
    .where('status', '=', 'approved')
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst()

  const lines = budget
    ? await db
        .selectFrom('budget_lines')
        .innerJoin('cost_heads', 'cost_heads.id', 'budget_lines.cost_head_id')
        .select([
          'budget_lines.id',
          'budget_lines.amount_paise',
          'budget_lines.description',
          'cost_heads.name as cost_head',
          'cost_heads.id as cost_head_id',
        ])
        .where('budget_lines.budget_id', '=', budget.id)
        .orderBy('cost_heads.sort_order')
        .execute()
    : []

  const actualRows = await db
    .selectFrom('expense_lines')
    .innerJoin('expenses', 'expenses.id', 'expense_lines.expense_id')
    .select((eb) => [
      eb.ref('expense_lines.cost_head_id').as('cost_head_id'),
      eb.fn.sum<number>('expense_lines.amount_paise').as('spent'),
    ])
    .where('expenses.project_id', '=', projectId)
    .where('expenses.status', 'in', ['approved', 'part_paid', 'paid'])
    .groupBy('expense_lines.cost_head_id')
    .execute()

  const actual = new Map(actualRows.map((r) => [Number(r.cost_head_id), Number(r.spent ?? 0)]))

  return {
    budget: budget ?? null,
    lines: lines.map((line) => ({
      ...line,
      spent: actual.get(Number(line.cost_head_id)) ?? 0,
    })),
    uncategorised: [...actual.entries()]
      .filter(([id]) => !lines.some((l) => Number(l.cost_head_id) === id))
      .reduce((sum, [, value]) => sum + value, 0),
  }
}

export async function activeProjectOptions(db: Db, scope: ScopeContext) {
  const scoped = await projectScopeFilter(db, scope)
  let query = db
    .selectFrom('projects')
    .select(['id', 'code', 'name'])
    .where('status', 'in', ['mobilising', 'in_progress', 'on_hold', 'snagging'])
    .orderBy('code')
  if (scoped) query = query.where('id', 'in', scoped.length ? scoped : [0])
  return query.execute()
}

/** Has a DPR already been filed for this project on this date. */
export async function dprExists(db: Queryable, projectId: number, date: string): Promise<boolean> {
  const row = await db
    .selectFrom('daily_progress_reports')
    .select('id')
    .where('project_id', '=', projectId)
    .where('report_date', '=', date)
    .executeTakeFirst()
  return row !== undefined
}

export async function openSnagCount(db: Queryable, projectId: number): Promise<number> {
  const row = await db
    .selectFrom('snags')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('project_id', '=', projectId)
    .where('status', 'in', ['open', 'in_progress'])
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function todayDprMissing(db: Db, scope: ScopeContext): Promise<number> {
  const scoped = await projectScopeFilter(db, scope)
  let query = db
    .selectFrom('projects')
    .leftJoin('daily_progress_reports', (join) =>
      join
        .onRef('daily_progress_reports.project_id', '=', 'projects.id')
        .on('daily_progress_reports.report_date', '=', today())
    )
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('projects.status', 'in', ['mobilising', 'in_progress', 'snagging'])
    .where('daily_progress_reports.id', 'is', null)
  if (scoped) query = query.where('projects.id', 'in', scoped.length ? scoped : [0])
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function projectApprovals(db: Queryable, projectId: number, canViewCost: boolean) {
  let query = db
    .selectFrom('project_approvals')
    .leftJoin('project_stages', 'project_stages.id', 'project_approvals.blocks_stage_id')
    .select([
      'project_approvals.id',
      'project_approvals.authority',
      'project_approvals.approval_type',
      'project_approvals.reference_no',
      'project_approvals.applied_on',
      'project_approvals.received_on',
      'project_approvals.valid_until',
      'project_approvals.status',
      'project_stages.name as blocks_stage',
    ])
    .where('project_approvals.project_id', '=', projectId)
    .orderBy('project_approvals.authority')

  if (canViewCost) query = query.select('project_approvals.fee_paise')
  return query.execute()
}

/** Material issued to this project, for the materials tab. */
export async function projectMaterials(db: Queryable, projectId: number, canViewCost: boolean) {
  let query = db
    .selectFrom('issue_lines')
    .innerJoin('material_issues', 'material_issues.id', 'issue_lines.issue_id')
    .innerJoin('items', 'items.id', 'issue_lines.item_id')
    .leftJoin('units', 'units.id', 'items.unit_id')
    .select((eb) => [
      eb.ref('items.id').as('item_id'),
      eb.ref('items.name').as('item_name'),
      eb.ref('items.code').as('item_code'),
      eb.ref('units.code').as('unit'),
      eb.fn.sum<number>('issue_lines.qty_issued').as('qty_issued'),
      eb.fn.sum<number>('issue_lines.qty_returned').as('qty_returned'),
    ])
    .where('material_issues.project_id', '=', projectId)
    .where('material_issues.status', '=', 'posted')
    .groupBy(['items.id', 'items.name', 'items.code', 'units.code'])
    .orderBy('items.name')

  if (canViewCost) {
    query = query.select((eb) =>
      eb.fn
        .sum<number>(eb(eb.ref('issue_lines.qty_issued'), '*', eb.ref('issue_lines.rate_paise')))
        .as('value_paise')
    )
  }
  return query.execute()
}

/** Stage template options for the create form, defaults first. */
export async function stageTemplateOptions(db: Queryable) {
  return db
    .selectFrom('stage_templates')
    .select(['id', 'name', 'project_type', 'is_default'])
    .where('is_active', '=', 1)
    .orderBy('is_default', 'desc')
    .orderBy('name')
    .execute()
}

export async function clientOptions(db: Queryable) {
  return db
    .selectFrom('clients')
    .select(['id', 'code', 'name'])
    .where('status', '=', 'active')
    .orderBy('name')
    .execute()
}

/** Users who can be assigned to a project team. */
export async function assignableUsers(db: Queryable) {
  return db
    .selectFrom('users')
    .select(['id', 'full_name', 'email'])
    .where('status', '=', 'active')
    .orderBy('full_name')
    .execute()
}
