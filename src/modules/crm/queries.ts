import { sql } from 'kysely'
import type { Db, Queryable } from '../../db/kysely.js'
import { today } from '../../lib/dates.js'

/**
 * CRM reads (spec 6.7).
 *
 * The same three things are load bearing as in src/modules/projects/queries.ts
 * and src/modules/inventory/queries.ts, with one addition specific to leads.
 *
 * Scoping is a SQL predicate. It is not built from ScopeContext, because that
 * type answers "which projects may this user see" and a lead has no project
 * yet. The rule instead comes from the permission the seeded roles actually
 * differ on: migrations/002_rbac.sql gives crm.lead_assign to owner and
 * ops_manager and withholds it from sales_exec, whose role description is "own
 * leads plus the unassigned pool". So a caller holding crm.lead_assign sees
 * every lead, and a caller without it sees `assigned_to = me OR assigned_to IS
 * NULL`. Deriving it from the permission rather than from a role key means a
 * new role gets the visibility its grants imply, with no list to update here.
 *
 * Pipeline value is a parameter (canViewValue), not a post-processing step:
 * without crm.view_pipeline_value the value columns are not in the SELECT.
 *
 * The 45-day dormancy rule (rule 9) is applied inside the aggregate, not by
 * filtering rows afterwards, so the number on the board is the number the
 * report would produce.
 */

/** Who the caller may see. `all` is true when they hold crm.lead_assign. */
export interface LeadScope {
  all: boolean
  userId: number
}

/** Stages a lead can still be won from, so the ones pipeline value counts. */
export const OPEN_STAGES = [
  'new',
  'contacted',
  'qualified',
  'site_visit_scheduled',
  'site_visit_done',
  'estimate_shared',
  'quote_sent',
  'negotiation',
  'verbal_agreement',
] as const

const PAGE_SIZE = 25

/** Rule 9: a lead nobody has touched in this many days stops counting. */
export const DORMANT_DAYS = 45

export interface LeadFilters {
  q?: string | null
  stage?: string | null
  temperature?: string | null
  assignedTo?: number | null
  source?: number | null
  unassigned?: boolean
}

export interface LeadListRow {
  id: number
  lead_no: string
  contact_name: string
  phone: string
  stage: string
  temperature: string
  score: number
  site_city: string | null
  site_locality: string | null
  next_action: string | null
  next_action_date: string | null
  stage_changed_at: string
  assignee_name: string | null
  source_name: string | null
  expected_value_paise?: number | null
  probability_pct?: number | null
}

export async function listLeads(
  db: Queryable,
  scope: LeadScope,
  opts: LeadFilters & { canViewValue: boolean; limit?: number; offset?: number }
): Promise<LeadListRow[]> {
  let query = db
    .selectFrom('leads')
    .leftJoin('users', 'users.id', 'leads.assigned_to')
    .leftJoin('lead_sources', 'lead_sources.id', 'leads.lead_source_id')
    .select([
      'leads.id',
      'leads.lead_no',
      'leads.contact_name',
      'leads.phone',
      'leads.stage',
      'leads.temperature',
      'leads.score',
      'leads.site_city',
      'leads.site_locality',
      'leads.next_action',
      'leads.next_action_date',
      'leads.stage_changed_at',
      'users.full_name as assignee_name',
      'lead_sources.name as source_name',
    ])
    // Hottest first, then the oldest untouched: the order a sales exec works in.
    .orderBy('leads.score', 'desc')
    .orderBy('leads.stage_changed_at')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (opts.canViewValue) {
    query = query.select(['leads.expected_value_paise', 'leads.probability_pct'])
  }

  // The filter block is repeated in countLeads rather than extracted, which is
  // what listVendors and countVendors do in the inventory module. A shared
  // helper would have to be generic over two different Kysely builder types and
  // would earn that complexity only once.
  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  if (opts.stage) query = query.where('leads.stage', '=', opts.stage as 'new')
  if (opts.temperature) query = query.where('leads.temperature', '=', opts.temperature as 'hot')
  if (opts.assignedTo) query = query.where('leads.assigned_to', '=', opts.assignedTo)
  if (opts.unassigned) query = query.where('leads.assigned_to', 'is', null)
  if (opts.source) query = query.where('leads.lead_source_id', '=', opts.source)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) =>
      eb.or([
        eb('leads.contact_name', 'like', like),
        eb('leads.phone', 'like', like),
        eb('leads.lead_no', 'like', like),
        eb('leads.site_locality', 'like', like),
      ])
    )
  }

  return (await query.execute()) as unknown as LeadListRow[]
}

export async function countLeads(db: Queryable, scope: LeadScope, opts: LeadFilters): Promise<number> {
  let query = db.selectFrom('leads').select((eb) => eb.fn.countAll<number>().as('n'))
  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  if (opts.stage) query = query.where('leads.stage', '=', opts.stage as 'new')
  if (opts.temperature) query = query.where('leads.temperature', '=', opts.temperature as 'hot')
  if (opts.assignedTo) query = query.where('leads.assigned_to', '=', opts.assignedTo)
  if (opts.unassigned) query = query.where('leads.assigned_to', 'is', null)
  if (opts.source) query = query.where('leads.lead_source_id', '=', opts.source)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) =>
      eb.or([
        eb('leads.contact_name', 'like', like),
        eb('leads.phone', 'like', like),
        eb('leads.lead_no', 'like', like),
        eb('leads.site_locality', 'like', like),
      ])
    )
  }
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

/**
 * One lead with everything the detail header shows.
 *
 * The budget columns are not gated on canViewValue. The budget is the client's
 * own number and a sales executive cannot qualify a lead without it;
 * crm.view_pipeline_value guards the company's forecast, which is
 * expected_value_paise and the probability, and those are gated.
 */
export async function findLead(db: Queryable, id: number, canViewValue: boolean) {
  let query = db
    .selectFrom('leads')
    .leftJoin('clients', 'clients.id', 'leads.client_id')
    .leftJoin('users', 'users.id', 'leads.assigned_to')
    .leftJoin('lead_sources', 'lead_sources.id', 'leads.lead_source_id')
    .leftJoin('campaigns', 'campaigns.id', 'leads.campaign_id')
    .leftJoin('site_packages', 'site_packages.id', 'leads.preferred_package_id')
    .leftJoin('projects', 'projects.id', 'leads.converted_project_id')
    .select([
      'leads.id',
      'leads.lead_no',
      'leads.enquiry_id',
      'leads.client_id',
      'leads.contact_name',
      'leads.phone',
      'leads.alt_phone',
      'leads.email',
      'leads.lead_source_id',
      'leads.campaign_id',
      'leads.referred_by_client_id',
      'leads.enquiry_type',
      'leads.site_city',
      'leads.site_locality',
      'leads.survey_number',
      'leads.plot_area_sqft',
      'leads.plot_dimensions',
      'leads.target_built_up_sqft',
      'leads.floors_wanted',
      'leads.jurisdiction',
      'leads.plot_ownership',
      'leads.has_sanctioned_plan',
      'leads.has_architect',
      'leads.architect_name',
      'leads.budget_min_paise',
      'leads.budget_max_paise',
      'leads.preferred_package_id',
      'leads.funding_mode',
      'leads.expected_start',
      'leads.stage',
      'leads.stage_changed_at',
      'leads.score',
      'leads.temperature',
      'leads.assigned_to',
      'leads.assigned_at',
      'leads.next_action',
      'leads.next_action_date',
      'leads.first_response_at',
      'leads.lost_reason',
      'leads.lost_to_competitor',
      'leads.lost_notes',
      'leads.converted_project_id',
      'leads.created_at',
      'users.full_name as assignee_name',
      'clients.name as client_name',
      'clients.code as client_code',
      'lead_sources.name as source_name',
      'campaigns.name as campaign_name',
      'site_packages.name as package_name',
      'site_packages.rate_per_sqft_paise as package_rate_paise',
      'projects.code as project_code',
    ])
    .where('leads.id', '=', id)

  if (canViewValue) {
    query = query.select(['leads.expected_value_paise', 'leads.probability_pct'])
  }

  return query.executeTakeFirst()
}

/**
 * Whether this caller may see this lead at all.
 *
 * Asked as its own predicate so the route can answer 404 rather than 403, the
 * same way requireProjectAccess does for projects: telling an unauthorised
 * caller that a lead exists is itself a disclosure, and in sales it is the
 * disclosure that matters — that a competitor's prospect is in the pipeline.
 */
export async function leadVisible(db: Queryable, scope: LeadScope, id: number): Promise<boolean> {
  if (scope.all) {
    const any = await db.selectFrom('leads').select('id').where('id', '=', id).executeTakeFirst()
    return any !== undefined
  }
  const row = await db
    .selectFrom('leads')
    .select('id')
    .where('id', '=', id)
    .where((eb) => eb.or([eb('assigned_to', '=', scope.userId), eb('assigned_to', 'is', null)]))
    .executeTakeFirst()
  return row !== undefined
}

export async function leadActivities(db: Queryable, leadId: number, limit = 50) {
  return db
    .selectFrom('lead_activities')
    .innerJoin('users', 'users.id', 'lead_activities.created_by')
    .select([
      'lead_activities.id',
      'lead_activities.activity_type',
      'lead_activities.occurred_at',
      'lead_activities.duration_minutes',
      'lead_activities.outcome',
      'lead_activities.summary',
      'lead_activities.next_action',
      'lead_activities.next_action_date',
      'users.full_name as by_name',
    ])
    .where('lead_activities.lead_id', '=', leadId)
    .orderBy('lead_activities.occurred_at', 'desc')
    .limit(limit)
    .execute()
}

export async function leadStageHistory(db: Queryable, leadId: number) {
  return db
    .selectFrom('lead_stage_history')
    .innerJoin('users', 'users.id', 'lead_stage_history.changed_by')
    .select([
      'lead_stage_history.id',
      'lead_stage_history.from_stage',
      'lead_stage_history.to_stage',
      'lead_stage_history.changed_at',
      'lead_stage_history.days_in_previous_stage',
      'lead_stage_history.note',
      'users.full_name as by_name',
    ])
    .where('lead_stage_history.lead_id', '=', leadId)
    .orderBy('lead_stage_history.changed_at', 'desc')
    .execute()
}

export async function leadVisits(db: Queryable, leadId: number) {
  return db
    .selectFrom('site_visits')
    .leftJoin('users', 'users.id', 'site_visits.visited_by')
    .select([
      'site_visits.id',
      'site_visits.scheduled_at',
      'site_visits.visited_at',
      'site_visits.status',
      'site_visits.feasibility',
      'site_visits.estimated_extra_cost_paise',
      'users.full_name as visited_by_name',
    ])
    .where('site_visits.lead_id', '=', leadId)
    .orderBy('site_visits.scheduled_at', 'desc')
    .execute()
}

/**
 * Rule 3: a quote cannot go out until a site visit is on the record as done.
 *
 * Both halves of the rule are asked for — status completed *and* a feasibility
 * verdict. A visit flipped to completed without the form filled in has
 * established nothing, and this is the query the gate reads, so the looser of
 * the two conditions would be the one that governs.
 *
 * Asked as a COUNT rather than by reading the visit list, so the gate is a
 * single indexed query the service can run inside its transaction.
 */
export async function hasCompletedVisit(db: Queryable, leadId: number): Promise<boolean> {
  const row = await db
    .selectFrom('site_visits')
    .select('id')
    .where('lead_id', '=', leadId)
    .where('status', '=', 'completed')
    .where('feasibility', 'is not', null)
    .executeTakeFirst()
  return row !== undefined
}

export async function findVisit(db: Queryable, id: number) {
  return db
    .selectFrom('site_visits')
    .innerJoin('leads', 'leads.id', 'site_visits.lead_id')
    .leftJoin('users', 'users.id', 'site_visits.visited_by')
    .select([
      'site_visits.id',
      'site_visits.lead_id',
      'site_visits.scheduled_at',
      'site_visits.visited_at',
      'site_visits.visited_by',
      'site_visits.status',
      'site_visits.soil_type',
      'site_visits.road_access',
      'site_visits.water_availability',
      'site_visits.power_availability',
      'site_visits.neighbouring_structures',
      'site_visits.level_difference_ft',
      'site_visits.demolition_required',
      'site_visits.tree_cutting_permission_needed',
      'site_visits.access_constraints',
      'site_visits.feasibility',
      'site_visits.conditions_notes',
      'site_visits.estimated_extra_cost_paise',
      'leads.lead_no',
      'leads.contact_name',
      'leads.site_locality',
      'leads.site_city',
      'leads.assigned_to',
      'users.full_name as visited_by_name',
    ])
    .where('site_visits.id', '=', id)
    .executeTakeFirst()
}

export interface VisitFilters {
  status?: string | null
  from?: string | null
  to?: string | null
}

export async function listVisits(
  db: Queryable,
  scope: LeadScope,
  opts: VisitFilters & { limit?: number; offset?: number }
) {
  let query = db
    .selectFrom('site_visits')
    .innerJoin('leads', 'leads.id', 'site_visits.lead_id')
    .leftJoin('users', 'users.id', 'site_visits.visited_by')
    .select([
      'site_visits.id',
      'site_visits.lead_id',
      'site_visits.scheduled_at',
      'site_visits.visited_at',
      'site_visits.status',
      'site_visits.feasibility',
      'leads.lead_no',
      'leads.contact_name',
      'leads.phone',
      'leads.site_locality',
      'leads.site_city',
      'users.full_name as visited_by_name',
    ])
    .orderBy('site_visits.scheduled_at', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  if (opts.status) query = query.where('site_visits.status', '=', opts.status as 'scheduled')
  if (opts.from) query = query.where('site_visits.scheduled_at', '>=', `${opts.from} 00:00:00`)
  if (opts.to) query = query.where('site_visits.scheduled_at', '<=', `${opts.to} 23:59:59`)

  return query.execute()
}

export async function countVisits(db: Queryable, scope: LeadScope, opts: VisitFilters): Promise<number> {
  let query = db
    .selectFrom('site_visits')
    .innerJoin('leads', 'leads.id', 'site_visits.lead_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  if (opts.status) query = query.where('site_visits.status', '=', opts.status as 'scheduled')
  if (opts.from) query = query.where('site_visits.scheduled_at', '>=', `${opts.from} 00:00:00`)
  if (opts.to) query = query.where('site_visits.scheduled_at', '<=', `${opts.to} 23:59:59`)
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

/**
 * The packages a quote may be written against on a given date (spec 6.5 rule 4:
 * CURRENT_DATE BETWEEN effective_from AND COALESCE(effective_to, '9999-12-31')).
 *
 * The date is a parameter rather than CURRENT_DATE in the SQL so a quote dated
 * last week prices against the rate that was published last week.
 */
export async function packageOptions(db: Queryable, onDate: string = today()) {
  return db
    .selectFrom('site_packages')
    .select(['id', 'name', 'slug', 'rate_per_sqft_paise', 'min_area_sqft', 'summary'])
    .where('is_active', '=', 1)
    .where('effective_from', '<=', onDate)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', onDate)]))
    .orderBy('sort_order')
    .orderBy('rate_per_sqft_paise')
    .execute()
}

export async function findEffectivePackage(db: Queryable, id: number, onDate: string = today()) {
  return db
    .selectFrom('site_packages')
    .select(['id', 'name', 'slug', 'rate_per_sqft_paise', 'min_area_sqft', 'summary'])
    .where('id', '=', id)
    .where('effective_from', '<=', onDate)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', onDate)]))
    .executeTakeFirst()
}

/**
 * The published specification for a package, group by group.
 *
 * Spec lines hang off a group, not off the package, so this reads through
 * package_spec_groups. It is what the printed quote lists as included, and it is
 * read at print time rather than copied onto the quote — see DECISIONS.md on the
 * uq_packages_slug conflict, which is why that is a live read today.
 */
export async function packageSpec(db: Queryable, packageId: number) {
  return db
    .selectFrom('package_spec_lines')
    .innerJoin('package_spec_groups', 'package_spec_groups.id', 'package_spec_lines.group_id')
    .select([
      'package_spec_lines.id',
      'package_spec_lines.label',
      'package_spec_lines.spec_value',
      'package_spec_lines.brand_options',
      'package_spec_groups.group_name',
      'package_spec_groups.sort_order as group_sort',
    ])
    .where('package_spec_groups.package_id', '=', packageId)
    .orderBy('package_spec_groups.sort_order')
    .orderBy('package_spec_lines.sort_order')
    .execute()
}

export interface QuoteFilters {
  status?: string | null
  leadId?: number | null
  q?: string | null
}

export async function listQuotes(
  db: Queryable,
  scope: LeadScope,
  opts: QuoteFilters & { limit?: number; offset?: number }
) {
  let query = db
    .selectFrom('quotes')
    .innerJoin('leads', 'leads.id', 'quotes.lead_id')
    .leftJoin('users', 'users.id', 'quotes.created_by')
    .select([
      'quotes.id',
      'quotes.quote_no',
      'quotes.revision',
      'quotes.lead_id',
      'quotes.quote_date',
      'quotes.valid_until',
      'quotes.status',
      'quotes.discount_pct',
      'quotes.total_paise',
      'quotes.sent_at',
      'leads.lead_no',
      'leads.contact_name',
      'users.full_name as created_by_name',
    ])
    .orderBy('quotes.quote_date', 'desc')
    .orderBy('quotes.id', 'desc')
    .limit(opts.limit ?? PAGE_SIZE)
    .offset(opts.offset ?? 0)

  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  if (opts.status) query = query.where('quotes.status', '=', opts.status as 'draft')
  if (opts.leadId) query = query.where('quotes.lead_id', '=', opts.leadId)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) =>
      eb.or([eb('quotes.quote_no', 'like', like), eb('leads.contact_name', 'like', like)])
    )
  }

  return query.execute()
}

export async function countQuotes(db: Queryable, scope: LeadScope, opts: QuoteFilters): Promise<number> {
  let query = db
    .selectFrom('quotes')
    .innerJoin('leads', 'leads.id', 'quotes.lead_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  if (opts.status) query = query.where('quotes.status', '=', opts.status as 'draft')
  if (opts.leadId) query = query.where('quotes.lead_id', '=', opts.leadId)
  if (opts.q) {
    const like = `%${opts.q}%`
    query = query.where((eb) =>
      eb.or([eb('quotes.quote_no', 'like', like), eb('leads.contact_name', 'like', like)])
    )
  }
  const row = await query.executeTakeFirst()
  return Number(row?.n ?? 0)
}

export async function findQuote(db: Queryable, id: number) {
  return db
    .selectFrom('quotes')
    .innerJoin('leads', 'leads.id', 'quotes.lead_id')
    .leftJoin('site_packages', 'site_packages.id', 'quotes.package_id')
    .leftJoin('users as author', 'author.id', 'quotes.created_by')
    .leftJoin('users as approver', 'approver.id', 'quotes.approved_by')
    .select([
      'quotes.id',
      'quotes.quote_no',
      'quotes.revision',
      'quotes.lead_id',
      'quotes.package_id',
      'quotes.quote_date',
      'quotes.valid_until',
      'quotes.pricing_basis',
      'quotes.built_up_area_sqft',
      'quotes.rate_per_sqft_paise',
      'quotes.base_amount_paise',
      'quotes.extras_amount_paise',
      'quotes.discount_pct',
      'quotes.discount_amount_paise',
      'quotes.discount_approved_by',
      'quotes.subtotal_paise',
      'quotes.gst_pct',
      'quotes.gst_paise',
      'quotes.total_paise',
      'quotes.exclusions',
      'quotes.payment_schedule_json',
      'quotes.status',
      'quotes.approved_by',
      'quotes.approved_at',
      'quotes.sent_at',
      'quotes.accepted_at',
      'quotes.rejected_reason',
      'quotes.supersedes_quote_id',
      'quotes.created_by',
      'quotes.created_at',
      'leads.lead_no',
      'leads.contact_name',
      'leads.phone',
      'leads.email',
      'leads.site_locality',
      'leads.site_city',
      'leads.survey_number',
      'leads.assigned_to',
      'leads.stage as lead_stage',
      'leads.converted_project_id',
      'site_packages.name as package_name',
      'author.full_name as created_by_name',
      'approver.full_name as approved_by_name',
    ])
    .where('quotes.id', '=', id)
    .executeTakeFirst()
}

export async function quoteLines(db: Queryable, quoteId: number) {
  return db
    .selectFrom('quote_lines')
    .leftJoin('units', 'units.id', 'quote_lines.unit_id')
    .select([
      'quote_lines.id',
      'quote_lines.line_type',
      'quote_lines.description',
      'quote_lines.qty',
      'quote_lines.rate_paise',
      'quote_lines.amount_paise',
      'quote_lines.sort_order',
      'units.code as unit_code',
    ])
    .where('quote_lines.quote_id', '=', quoteId)
    .orderBy('quote_lines.sort_order')
    .orderBy('quote_lines.id')
    .execute()
}

/** Every revision of one quote number, newest first (rule 5). */
export async function quoteRevisions(db: Queryable, quoteNo: string) {
  return db
    .selectFrom('quotes')
    .select(['id', 'revision', 'status', 'quote_date', 'total_paise', 'discount_pct', 'sent_at'])
    .where('quote_no', '=', quoteNo)
    .orderBy('revision', 'desc')
    .execute()
}

export async function leadQuotes(db: Queryable, leadId: number) {
  return db
    .selectFrom('quotes')
    .select([
      'id',
      'quote_no',
      'revision',
      'quote_date',
      'valid_until',
      'status',
      'discount_pct',
      'total_paise',
      'sent_at',
      'accepted_at',
    ])
    .where('lead_id', '=', leadId)
    .orderBy('id', 'desc')
    .execute()
}

/**
 * The accepted quote conversion runs from (rule 6).
 *
 * Ordered by revision so that if two revisions were somehow both accepted the
 * later one wins, rather than the answer depending on insertion order.
 */
export async function acceptedQuotes(db: Queryable, leadId: number) {
  return db
    .selectFrom('quotes')
    .select(['id', 'quote_no', 'revision', 'total_paise', 'accepted_at'])
    .where('lead_id', '=', leadId)
    .where('status', '=', 'accepted')
    .orderBy('revision', 'desc')
    .execute()
}

/**
 * Rule 9, as a SQL predicate.
 *
 * "No activity in 45 days" is the later of the last logged activity and the day
 * the lead was created, so a lead taken this morning is active even though
 * nobody has logged a call against it yet. The correlated subquery is on
 * idx_act_lead (lead_id, occurred_at), so it is an index scan per lead rather
 * than a table scan.
 */
const notDormant = (onDate: string) =>
  sql<boolean>`COALESCE((SELECT MAX(la.occurred_at) FROM lead_activities la WHERE la.lead_id = leads.id), leads.created_at) >= DATE_SUB(${onDate}, INTERVAL ${sql.lit(DORMANT_DAYS)} DAY)`

export interface StageTotal {
  stage: string
  n: number
  value_paise: number
  weighted_paise: number
}

/**
 * The pipeline board's column headings (spec 6.7: "value per column").
 *
 * Two value columns, because they answer different questions. value_paise is
 * what the column is worth if every lead in it closes; weighted_paise applies
 * each lead's probability and is the only one of the two that can be added up
 * and called a forecast.
 */
export async function pipelineTotals(
  db: Queryable,
  scope: LeadScope,
  onDate: string = today()
): Promise<StageTotal[]> {
  let query = db
    .selectFrom('leads')
    .select((eb) => [
      'leads.stage',
      eb.fn.countAll<number>().as('n'),
      sql<number>`COALESCE(SUM(leads.expected_value_paise), 0)`.as('value_paise'),
      sql<number>`COALESCE(SUM(leads.expected_value_paise * COALESCE(leads.probability_pct, 0) / 100), 0)`.as(
        'weighted_paise'
      ),
    ])
    .where('leads.stage', 'in', OPEN_STAGES)
    .where(notDormant(onDate))
    .groupBy('leads.stage')

  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }

  return (await query.execute()) as unknown as StageTotal[]
}

export interface BoardCard {
  id: number
  lead_no: string
  contact_name: string
  stage: string
  temperature: string
  score: number
  site_locality: string | null
  next_action_date: string | null
  stage_changed_at: string
  assignee_name: string | null
  expected_value_paise?: number | null
  probability_pct?: number | null
}

/**
 * The cards on the board, every open column in one query.
 *
 * Grouping into columns happens in the route, not here. That is a presentation
 * concern rather than a scoping one: the WHERE clause has already decided which
 * rows the caller may see, so no filtering happens after the fetch.
 */
export async function boardCards(
  db: Queryable,
  scope: LeadScope,
  opts: { canViewValue: boolean; limit?: number }
): Promise<BoardCard[]> {
  let query = db
    .selectFrom('leads')
    .leftJoin('users', 'users.id', 'leads.assigned_to')
    .select([
      'leads.id',
      'leads.lead_no',
      'leads.contact_name',
      'leads.stage',
      'leads.temperature',
      'leads.score',
      'leads.site_locality',
      'leads.next_action_date',
      'leads.stage_changed_at',
      'users.full_name as assignee_name',
    ])
    .where('leads.stage', 'in', OPEN_STAGES)
    .orderBy('leads.score', 'desc')
    .orderBy('leads.stage_changed_at')
    .limit(opts.limit ?? 300)

  if (opts.canViewValue) {
    query = query.select(['leads.expected_value_paise', 'leads.probability_pct'])
  }
  if (!scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }

  return (await query.execute()) as unknown as BoardCard[]
}

export interface CrmKpis {
  openLeads: number
  unassigned: number
  followupsDue: number
  visitsUpcoming: number
  quotesPending: number
  weightedPaise: number | null
}

export async function crmKpis(
  db: Queryable,
  scope: LeadScope,
  opts: { canViewValue: boolean; onDate?: string }
): Promise<CrmKpis> {
  const onDate = opts.onDate ?? today()

  const totals = await pipelineTotals(db, scope, onDate)
  const openLeads = totals.reduce((sum, t) => sum + Number(t.n), 0)
  const weightedPaise = opts.canViewValue
    ? totals.reduce((sum, t) => sum + Number(t.weighted_paise), 0)
    : null

  // The pool is not scoped: an unassigned lead is visible to everyone who can
  // see leads at all, which is what makes it a pool.
  const unassignedQ = db
    .selectFrom('leads')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('assigned_to', 'is', null)
    .where('stage', 'in', OPEN_STAGES)

  let followupsQ = db
    .selectFrom('leads')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('next_action_date', '<=', onDate)
    .where('stage', 'in', OPEN_STAGES)
  if (!scope.all) {
    followupsQ = followupsQ.where((eb) =>
      eb.or([eb('assigned_to', '=', scope.userId), eb('assigned_to', 'is', null)])
    )
  }

  let visitsQ = db
    .selectFrom('site_visits')
    .innerJoin('leads', 'leads.id', 'site_visits.lead_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('site_visits.status', '=', 'scheduled')
    .where('site_visits.scheduled_at', '>=', `${onDate} 00:00:00`)
  if (!scope.all) {
    visitsQ = visitsQ.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }

  // Pending approvals are deliberately not scoped: an approver holds
  // crm.quote_approve without necessarily holding crm.lead_assign, and a queue
  // that hid the documents waiting on them would be worse than useless.
  const pendingQ = db
    .selectFrom('quotes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('status', '=', 'pending_approval')

  const unassigned = await unassignedQ.executeTakeFirst()
  const followups = await followupsQ.executeTakeFirst()
  const visits = await visitsQ.executeTakeFirst()
  const pending = await pendingQ.executeTakeFirst()

  return {
    openLeads,
    unassigned: Number(unassigned?.n ?? 0),
    followupsDue: Number(followups?.n ?? 0),
    visitsUpcoming: Number(visits?.n ?? 0),
    quotesPending: Number(pending?.n ?? 0),
    weightedPaise,
  }
}

/** Leads whose next action is due or overdue, for the work list and the cron. */
export async function dueFollowups(db: Queryable, scope: LeadScope | null, onDate: string = today()) {
  let query = db
    .selectFrom('leads')
    .leftJoin('users', 'users.id', 'leads.assigned_to')
    .select([
      'leads.id',
      'leads.lead_no',
      'leads.contact_name',
      'leads.phone',
      'leads.stage',
      'leads.temperature',
      'leads.next_action',
      'leads.next_action_date',
      'leads.assigned_to',
      'users.full_name as assignee_name',
    ])
    .where('leads.next_action_date', '<=', onDate)
    .where('leads.stage', 'in', OPEN_STAGES)
    .orderBy('leads.next_action_date')
    .limit(200)

  if (scope && !scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  return query.execute()
}

/**
 * Rule 7's breaches: a lead with no first response yet, past its target.
 *
 * The target arrives in hours from settings, so the cutoff is computed here
 * rather than hard-coded. created_at is the clock start, because that is when
 * the enquiry or the call landed.
 */
export async function firstResponseBreaches(
  db: Queryable,
  targetHours: number,
  scope: LeadScope | null = null
) {
  let query = db
    .selectFrom('leads')
    .leftJoin('users', 'users.id', 'leads.assigned_to')
    .select([
      'leads.id',
      'leads.lead_no',
      'leads.contact_name',
      'leads.phone',
      'leads.created_at',
      'leads.assigned_to',
      'users.full_name as assignee_name',
    ])
    .where('leads.first_response_at', 'is', null)
    .where('leads.stage', 'in', OPEN_STAGES)
    .where(sql<boolean>`leads.created_at < DATE_SUB(NOW(), INTERVAL ${sql.lit(targetHours)} HOUR)`)
    .orderBy('leads.created_at')
    .limit(200)

  if (scope && !scope.all) {
    query = query.where((eb) =>
      eb.or([eb('leads.assigned_to', '=', scope.userId), eb('leads.assigned_to', 'is', null)])
    )
  }
  return query.execute()
}

/** Rule 9's candidates: open leads that have gone quiet. Unscoped, for the cron. */
export async function dormantCandidates(db: Queryable, onDate: string = today()) {
  return db
    .selectFrom('leads')
    .select(['id', 'lead_no', 'stage'])
    .where('stage', 'in', OPEN_STAGES)
    .where(sql<boolean>`NOT (${notDormant(onDate)})`)
    .orderBy('id')
    .limit(500)
    .execute()
}

export interface FunnelRow {
  to_stage: string
  leads: number
  avg_days_in_previous: number | null
}

/**
 * The funnel (spec 6.7 `/app/crm/reports/funnel`).
 *
 * Built from lead_stage_history rather than from leads.stage, because a funnel
 * asks how many leads ever reached a stage, not how many are sitting in it now.
 * A lead counted once per stage: DISTINCT lead_id, so a lead that went back and
 * forth between contacted and qualified does not inflate either column.
 */
export async function funnelReport(db: Queryable, from: string, to: string): Promise<FunnelRow[]> {
  const rows = await db
    .selectFrom('lead_stage_history')
    .select([
      'lead_stage_history.to_stage',
      sql<number>`COUNT(DISTINCT lead_stage_history.lead_id)`.as('leads'),
      sql<number | null>`ROUND(AVG(lead_stage_history.days_in_previous_stage), 1)`.as('avg_days_in_previous'),
    ])
    .where('lead_stage_history.changed_at', '>=', `${from} 00:00:00`)
    .where('lead_stage_history.changed_at', '<=', `${to} 23:59:59`)
    .groupBy('lead_stage_history.to_stage')
    .execute()
  return rows as unknown as FunnelRow[]
}

export interface SourceRow {
  source_id: number | null
  source_name: string | null
  leads: number
  won: number
  lost: number
  won_value_paise: number
}

/**
 * Lead source performance (spec 6.7 `/app/crm/reports/sources`).
 *
 * Won value is taken from the converted project's contract value rather than
 * from the lead's expected value, because a source's worth is what it actually
 * brought in. Leads with no source are kept as a row rather than dropped: an
 * untagged lead is a data problem worth seeing on this page.
 */
export async function sourceReport(db: Queryable, from: string, to: string): Promise<SourceRow[]> {
  const rows = await db
    .selectFrom('leads')
    .leftJoin('lead_sources', 'lead_sources.id', 'leads.lead_source_id')
    .leftJoin('projects', 'projects.id', 'leads.converted_project_id')
    .select([
      'leads.lead_source_id as source_id',
      'lead_sources.name as source_name',
      sql<number>`COUNT(*)`.as('leads'),
      sql<number>`SUM(CASE WHEN leads.stage = 'won' THEN 1 ELSE 0 END)`.as('won'),
      sql<number>`SUM(CASE WHEN leads.stage = 'lost' THEN 1 ELSE 0 END)`.as('lost'),
      sql<number>`COALESCE(SUM(CASE WHEN leads.stage = 'won' THEN projects.contract_value_paise ELSE 0 END), 0)`.as(
        'won_value_paise'
      ),
    ])
    .where('leads.created_at', '>=', `${from} 00:00:00`)
    .where('leads.created_at', '<=', `${to} 23:59:59`)
    .groupBy(['leads.lead_source_id', 'lead_sources.name'])
    .orderBy('leads', 'desc')
    .execute()
  return rows as unknown as SourceRow[]
}

export interface LossRow {
  lost_reason: string | null
  lost_to_competitor: string | null
  leads: number
}

/**
 * Why deals were lost (spec 6.7 rule 8).
 *
 * Grouped by reason and by named competitor together, so "lost on price to
 * nobody in particular" and "lost on price to one firm four times" are different
 * rows. That distinction is the whole reason the competitor column exists.
 */
export async function lossReport(db: Queryable, from: string, to: string): Promise<LossRow[]> {
  const rows = await db
    .selectFrom('leads')
    .select([
      'leads.lost_reason',
      'leads.lost_to_competitor',
      sql<number>`COUNT(*)`.as('leads'),
    ])
    .where('leads.stage', '=', 'lost')
    .where('leads.stage_changed_at', '>=', `${from} 00:00:00`)
    .where('leads.stage_changed_at', '<=', `${to} 23:59:59`)
    .groupBy(['leads.lost_reason', 'leads.lost_to_competitor'])
    .orderBy('leads', 'desc')
    .execute()
  return rows as unknown as LossRow[]
}

export async function listCompetitors(db: Queryable) {
  return db
    .selectFrom('competitors')
    .select(['id', 'name', 'notes', 'typical_rate_per_sqft_paise', 'updated_at'])
    .orderBy('name')
    .execute()
}

/**
 * Website enquiries that have not become a lead yet.
 *
 * leads.enquiry_id is UNIQUE, so the absence of a matching leads row is the
 * whole test — there is no separate flag to keep in step. Spam and closed
 * enquiries are excluded because promoting one is not a thing anybody wants to
 * do by accident from a dropdown.
 */
export async function enquiriesWithoutLead(db: Queryable, limit = 100) {
  return db
    .selectFrom('enquiries')
    .leftJoin('leads', 'leads.enquiry_id', 'enquiries.id')
    .select([
      'enquiries.id',
      'enquiries.name',
      'enquiries.phone',
      'enquiries.email',
      'enquiries.city',
      'enquiries.service_interest',
      'enquiries.message',
      'enquiries.utm_source',
      'enquiries.utm_campaign',
      'enquiries.status',
      'enquiries.created_at',
    ])
    .where('leads.id', 'is', null)
    .where('enquiries.status', 'in', ['new', 'contacted'])
    .orderBy('enquiries.created_at', 'desc')
    .limit(limit)
    .execute()
}

export async function findEnquiry(db: Queryable, id: number) {
  return db
    .selectFrom('enquiries')
    .select([
      'id',
      'name',
      'phone',
      'email',
      'city',
      'service_interest',
      'message',
      'utm_source',
      'utm_campaign',
      'status',
      'created_at',
    ])
    .where('id', '=', id)
    .executeTakeFirst()
}

/*
 * Option lists.
 *
 * Declared here rather than imported from another module's queries file. That
 * is the tree's existing convention — inventory declares its own unitOptions
 * even though projects has clientOptions — and it keeps each module's reads
 * answerable from one file.
 */

export async function leadSourceOptions(db: Queryable) {
  return db
    .selectFrom('lead_sources')
    .select(['id', 'code', 'name', 'channel'])
    .where('is_active', '=', 1)
    .orderBy('name')
    .execute()
}

export async function campaignOptions(db: Queryable) {
  return db
    .selectFrom('campaigns')
    .select(['id', 'name', 'status'])
    .where('status', 'in', ['active', 'paused'])
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

/**
 * Who a lead may be assigned to.
 *
 * Active users, not filtered by permission. A permission filter here would have
 * to resolve role grants and per-user overrides to be correct, and it would
 * still only be advisory: what governs access to the lead is the scope predicate
 * at the top of this file, not who appears in this dropdown.
 */
export async function assignableUsers(db: Queryable) {
  return db
    .selectFrom('users')
    .select(['id', 'full_name', 'email'])
    .where('status', '=', 'active')
    .orderBy('full_name')
    .execute()
}

export async function stageTemplateOptions(db: Queryable) {
  return db
    .selectFrom('stage_templates')
    .select(['id', 'name', 'project_type', 'is_default'])
    .where('is_active', '=', 1)
    .orderBy('is_default', 'desc')
    .orderBy('name')
    .execute()
}

export async function unitOptions(db: Queryable) {
  return db.selectFrom('units').select(['id', 'code', 'name']).orderBy('code').execute()
}

export async function costHeadOptions(db: Queryable) {
  return db
    .selectFrom('cost_heads')
    .select(['id', 'code', 'name', 'head_type'])
    .where('is_active', '=', 1)
    .orderBy('sort_order')
    .orderBy('code')
    .execute()
}
