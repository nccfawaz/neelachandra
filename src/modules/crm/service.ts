import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { Db, Queryable, Trx } from '../../db/kysely.js'
import { env } from '../../env.js'
import { writeAudit } from '../../lib/audit.js'
import { nextNumber, sequenceCode } from '../../lib/numbering.js'
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { parseJsonColumnArray } from '../../lib/json.js'
import { PERMISSIONS, resolveApprovalLimit } from '../../lib/permissions.js'
import { notify, notifyPermission, usersWithPermission } from '../../lib/notify.js'
import { quoteEmail, send } from '../../lib/mailer.js'
import { formatPaise, splitGst } from '../../lib/money.js'
import { addDays, daysBetween, formatDate, nowSqlDateTime, today } from '../../lib/dates.js'
import { getSetting } from '../../lib/settings.js'
import {
  ensureSiteStore,
  generateMilestones,
  instantiateStagesFromTemplate,
  resolveStageTemplate,
} from '../projects/service.js'
import { DELIVERY_MODEL_FOR_BASIS } from './schemas.js'
import type { LeadInput, MilestoneInput, QuoteInput } from './schemas.js'
import { findEffectivePackage, hasCompletedVisit } from './queries.js'

/**
 * CRM policy (spec 6.7).
 *
 * The rules that live here are the ones a screen must not be able to talk its
 * way around: the score is computed from feasibility facts and never typed, the
 * expected value is derived, a quote cannot go out before somebody has stood on
 * the plot, a discount above the limit escalates instead of self-approving, and
 * conversion is one transaction that either produces a whole project or nothing.
 *
 * Arithmetic is entirely server side. Spec 6.7's "Pages and components"
 * paragraph asks for htmx to recalculate quote totals after each line change
 * precisely so "the client never owns the arithmetic"; there is no hx-* attribute
 * anywhere in src/ yet, so the same guarantee is met the plainer way — the quote
 * schema accepts the inputs to the arithmetic (area, rate, discount percentage,
 * lines) and never its results, and every total below is computed here. See
 * DECISIONS.md.
 */

export interface Actor {
  userId: number
  ip: string | null
}

/* Scoring ---------------------------------------------------------------- */

/**
 * The served area, read from the frozen JSON-LD rather than invented.
 *
 * Spec 6.7 rule 1 scores a lead on whether "site city [is] inside the served
 * area published in areaServed". areaServed is a schema.org property in the
 * legacy pages' Organization block, and legacy/golden/home.html lists exactly
 * these cities plus the state. Taking the list from the golden master keeps the
 * score and the public site agreeing; if marketing changes the published area,
 * the parity gate makes that a deliberate change rather than a silent one.
 *
 * Matched on the alternate names too, because a client typing "Bangalore" or
 * "Tumkur" has named a city we serve.
 */
export const SERVED_CITIES = [
  'bengaluru',
  'bangalore',
  'nelamangala',
  'tumakuru',
  'tumkur',
  'doddaballapura',
  'doddaballapur',
] as const

/** One weighted signal, kept so the badge can say what it counted. */
export interface ScoreSignal {
  key: string
  label: string
  points: number
  max: number
}

export interface LeadScoreInput {
  plotOwnership: string | null
  hasSanctionedPlan: number | null
  fundingMode: string | null
  expectedStart: string | null
  budgetMinPaise: number | null
  budgetMaxPaise: number | null
  targetBuiltUpSqft: number | null
  /** rate_per_sqft_paise of the preferred package, when one is chosen. */
  packageRatePaise: number | null
  siteCity: string | null
}

/**
 * The lead score (spec 6.7 rule 1).
 *
 * Pure, and deliberately so: it takes no database handle, which is what makes
 * it testable and what stops a caller from scoring a lead against one set of
 * facts and storing it against another. Every input is a fact somebody
 * established, never an impression — there is no field here for how keen the
 * prospect sounded.
 *
 * The six weights sum to 100. They are my apportionment, not the spec's: rule 1
 * names the signals and their direction (clear title highest, not-yet-purchased
 * near zero) but no numbers. Ownership and funding carry the most because they
 * are the two that stop a job dead, and the served-area check carries least
 * because it is a logistics cost rather than a reason the sale fails. Recorded
 * as a judgement call in DECISIONS.md.
 */
export function computeLeadScore(lead: LeadScoreInput): { score: number; signals: ScoreSignal[] } {
  const signals: ScoreSignal[] = []

  // Clear title is the qualifier. An agreement-stage plot can still be built
  // on, eventually; a plot the client has not bought cannot be quoted at all.
  const ownershipPoints: Record<string, number> = {
    owned_clear_title: 25,
    owned_under_verification: 18,
    joint_development: 12,
    agreement_stage: 8,
    not_yet_purchased: 1,
  }
  signals.push({
    key: 'plot_ownership',
    label: 'Plot ownership',
    points: lead.plotOwnership ? (ownershipPoints[lead.plotOwnership] ?? 0) : 0,
    max: 25,
  })

  signals.push({
    key: 'sanctioned_plan',
    label: 'Sanctioned plan in hand',
    points: lead.hasSanctionedPlan === 1 ? 15 : 0,
    max: 15,
  })

  // Money in place beats money intended. A sanctioned loan and self-funding
  // are the same thing from here; an applied-for loan is a pending decision
  // somebody else makes.
  const fundingPoints: Record<string, number> = {
    loan_sanctioned: 20,
    self: 20,
    company_capex: 16,
    home_loan: 10,
    loan_applied: 8,
  }
  signals.push({
    key: 'funding_mode',
    label: 'Funding',
    points: lead.fundingMode ? (fundingPoints[lead.fundingMode] ?? 0) : 0,
    max: 20,
  })

  const startPoints: Record<string, number> = {
    immediate: 15,
    within_1_month: 14,
    '1_to_3_months': 11,
    '3_to_6_months': 6,
    beyond_6_months: 3,
    exploring: 0,
  }
  signals.push({
    key: 'expected_start',
    label: 'Expected start',
    points: lead.expectedStart ? (startPoints[lead.expectedStart] ?? 0) : 0,
    max: 15,
  })

  // Does the stated budget reach the package at the area they want? A budget
  // 30 percent short of the published rate is the single most common reason a
  // keen prospect never signs, and it is knowable on the first call.
  let budgetPoints = 0
  if (
    lead.packageRatePaise !== null &&
    lead.targetBuiltUpSqft !== null &&
    lead.targetBuiltUpSqft > 0 &&
    (lead.budgetMinPaise !== null || lead.budgetMaxPaise !== null)
  ) {
    const needed = Math.round(lead.packageRatePaise * lead.targetBuiltUpSqft)
    const ceiling = lead.budgetMaxPaise ?? lead.budgetMinPaise!
    const ratio = needed > 0 ? ceiling / needed : 0
    budgetPoints = ratio >= 1 ? 15 : ratio >= 0.9 ? 11 : ratio >= 0.75 ? 6 : 0
  }
  signals.push({ key: 'budget_fit', label: 'Budget covers the package', points: budgetPoints, max: 15 })

  const city = (lead.siteCity ?? '').trim().toLowerCase()
  signals.push({
    key: 'served_area',
    label: 'Inside the served area',
    points: city !== '' && (SERVED_CITIES as readonly string[]).includes(city) ? 10 : 0,
    max: 10,
  })

  const score = signals.reduce((sum, s) => sum + s.points, 0)
  // score is TINYINT UNSIGNED. The weights sum to 100, but the clamp is here so
  // a future weight change cannot write a value the column will not hold.
  return { score: Math.max(0, Math.min(100, score)), signals }
}

/**
 * Temperature from the score plus recency (spec 6.7 rule 1).
 *
 * Recency is the second half of the rule, and it is what stops a lead scored 90
 * in March from still reading hot in September. A lead nobody has touched for
 * longer than the dormancy window is cold whatever it scored.
 */
export function temperatureFor(
  score: number,
  daysSinceLastActivity: number | null
): 'hot' | 'warm' | 'cold' {
  const stale = daysSinceLastActivity === null ? false : daysSinceLastActivity > 30
  if (stale) return 'cold'
  const fresh = daysSinceLastActivity !== null && daysSinceLastActivity <= 14
  if (score >= 70 && fresh) return 'hot'
  if (score < 40) return 'cold'
  return 'warm'
}

/**
 * The default probability for a stage.
 *
 * Five of these are verbatim from spec 6.7 rule 2 at NCC_BUILD_SPEC.md:1926,
 * which names `qualified` 20, `site_visit_done` 35, `quote_sent` 50,
 * `negotiation` 70 and `verbal_agreement` 85 and stops there. The other four
 * are this repository's and the rule does not mention them: `won` 100 and
 * `lost` 0 are forced by what the words mean, and `dormant` and `disqualified`
 * follow `lost` because rule 9 (:1940) already excludes dormant from pipeline
 * value, so the figure here is never what decides that.
 *
 * Every remaining stage gets null rather than a guess: a lead at 'contacted'
 * has no forecastable probability, and inventing 10 percent for it would put
 * money in the pipeline figure that nobody has any basis for.
 */
export const STAGE_PROBABILITY: Record<string, number | null> = {
  new: null,
  contacted: null,
  qualified: 20,
  site_visit_scheduled: null,
  site_visit_done: 35,
  estimate_shared: null,
  quote_sent: 50,
  negotiation: 70,
  verbal_agreement: 85,
  won: 100,
  lost: 0,
  dormant: 0,
  disqualified: 0,
}

/**
 * How far along the pipeline a stage is, for the "advance, never retreat" test.
 *
 * Several actions imply a stage — a visit completed implies site_visit_done, a
 * quote sent implies quote_sent, an acceptance implies verbal_agreement — and
 * every one of them can happen late. A second site visit during negotiation is
 * ordinary; letting it walk the lead back to site_visit_done would rewrite the
 * funnel and reset the probability to 35.
 *
 * The off-pipeline stages rank below the start, not at the end where
 * LEAD_STAGES happens to list them, so a dormant lead that gets a quote does
 * advance. won and lost are guarded separately as terminal, so their rank here
 * is never the thing that decides anything.
 */
export const STAGE_RANK: Record<string, number> = {
  lost: -1,
  dormant: -1,
  disqualified: -1,
  new: 0,
  contacted: 1,
  qualified: 2,
  site_visit_scheduled: 3,
  site_visit_done: 4,
  estimate_shared: 5,
  quote_sent: 6,
  negotiation: 7,
  verbal_agreement: 8,
  won: 9,
}

/** True when `to` is further along than `from`, so the move is an advance. */
export function advances(from: string, to: string): boolean {
  return (STAGE_RANK[from] ?? 0) < (STAGE_RANK[to] ?? 0)
}

/* Derived value ---------------------------------------------------------- */

/**
 * Expected value (spec 6.7 rule 2), derived and never entered.
 *
 * target_built_up_sqft times the preferred package rate, falling back to the
 * midpoint of the budget range. Null when neither is known, because a pipeline
 * total built on a placeholder is worse than one that admits a gap.
 */
export function expectedValuePaise(input: {
  targetBuiltUpSqft: number | null
  packageRatePaise: number | null
  budgetMinPaise: number | null
  budgetMaxPaise: number | null
}): number | null {
  if (
    input.packageRatePaise !== null &&
    input.targetBuiltUpSqft !== null &&
    input.targetBuiltUpSqft > 0
  ) {
    return Math.round(input.packageRatePaise * input.targetBuiltUpSqft)
  }
  const { budgetMinPaise: lo, budgetMaxPaise: hi } = input
  if (lo !== null && hi !== null) return Math.round((lo + hi) / 2)
  return lo ?? hi ?? null
}

/**
 * Rescores a lead in place and returns what it wrote.
 *
 * Called after every write that can change a scored fact, so the score is a
 * function of the row rather than of whichever form last happened to include a
 * score field. Runs inside the caller's transaction: a lead whose facts changed
 * but whose score did not is exactly the drift the derived-value rule exists to
 * prevent.
 */
async function rescoreLead(
  trx: Trx,
  leadId: number
): Promise<{ score: number; temperature: 'hot' | 'warm' | 'cold'; expectedValuePaise: number | null }> {
  const lead = await trx
    .selectFrom('leads')
    .leftJoin('site_packages', 'site_packages.id', 'leads.preferred_package_id')
    .select([
      'leads.plot_ownership',
      'leads.has_sanctioned_plan',
      'leads.funding_mode',
      'leads.expected_start',
      'leads.budget_min_paise',
      'leads.budget_max_paise',
      'leads.target_built_up_sqft',
      'leads.site_city',
      'leads.created_at',
      'leads.stage',
      'leads.probability_pct',
      'site_packages.rate_per_sqft_paise as package_rate_paise',
    ])
    .where('leads.id', '=', leadId)
    .executeTakeFirst()
  if (!lead) throw new NotFoundError('That lead does not exist.')

  const packageRatePaise =
    lead.package_rate_paise === null ? null : Number(lead.package_rate_paise)
  const targetBuiltUpSqft =
    lead.target_built_up_sqft === null ? null : Number(lead.target_built_up_sqft)
  const budgetMinPaise = lead.budget_min_paise === null ? null : Number(lead.budget_min_paise)
  const budgetMaxPaise = lead.budget_max_paise === null ? null : Number(lead.budget_max_paise)

  const { score } = computeLeadScore({
    plotOwnership: lead.plot_ownership,
    hasSanctionedPlan: lead.has_sanctioned_plan,
    fundingMode: lead.funding_mode,
    expectedStart: lead.expected_start,
    budgetMinPaise,
    budgetMaxPaise,
    targetBuiltUpSqft,
    packageRatePaise,
    siteCity: lead.site_city,
  })

  const last = await trx
    .selectFrom('lead_activities')
    .select((eb) => eb.fn.max('occurred_at').as('last_at'))
    .where('lead_id', '=', leadId)
    .executeTakeFirst()
  // COALESCE to created_at: a lead entered today with no activity yet is new,
  // not stale, and the dormancy query treats it the same way.
  const lastAt = (last?.last_at as string | null) ?? (lead.created_at as unknown as string)
  const daysSince = lastAt ? daysBetween(String(lastAt).slice(0, 10), today()) : null

  const temperature = temperatureFor(score, daysSince)
  const value = expectedValuePaise({
    targetBuiltUpSqft,
    packageRatePaise,
    budgetMinPaise,
    budgetMaxPaise,
  })

  await trx
    .updateTable('leads')
    .set({ score, temperature, expected_value_paise: value })
    .where('id', '=', leadId)
    .execute()

  return { score, temperature, expectedValuePaise: value }
}

/* Leads ------------------------------------------------------------------ */

/** The lead columns a form writes, mapped once so create and update agree. */
function leadColumns(input: LeadInput) {
  return {
    contact_name: input.contactName,
    phone: input.phone,
    alt_phone: input.altPhone,
    email: input.email,
    client_id: input.clientId,
    lead_source_id: input.leadSourceId,
    campaign_id: input.campaignId,
    referred_by_client_id: input.referredByClientId,
    enquiry_type: input.enquiryType,
    site_city: input.siteCity,
    site_locality: input.siteLocality,
    survey_number: input.surveyNumber,
    plot_area_sqft: input.plotAreaSqft,
    plot_dimensions: input.plotDimensions,
    target_built_up_sqft: input.targetBuiltUpSqft,
    floors_wanted: input.floorsWanted,
    jurisdiction: input.jurisdiction,
    plot_ownership: input.plotOwnership,
    has_sanctioned_plan: input.hasSanctionedPlan,
    has_architect: input.hasArchitect,
    architect_name: input.architectName,
    budget_min_paise: input.budgetMinPaise,
    budget_max_paise: input.budgetMaxPaise,
    preferred_package_id: input.preferredPackageId,
    funding_mode: input.fundingMode,
    expected_start: input.expectedStart,
    next_action: input.nextAction,
    next_action_date: input.nextActionDate,
  }
}

/**
 * Leads on the same phone number.
 *
 * The from-enquiry route warns before creating a duplicate rather than blocking
 * one: two people in a household do enquire separately, and a hard block would
 * be worked around by mistyping the number, which loses the link entirely.
 */
export async function duplicatesByPhone(
  db: Queryable,
  phone: string,
  exceptLeadId: number | null = null
) {
  let q = db
    .selectFrom('leads')
    .select(['id', 'lead_no', 'contact_name', 'stage', 'created_at'])
    .where('phone', '=', phone)
    .orderBy('id', 'desc')
    .limit(5)
  if (exceptLeadId !== null) q = q.where('id', '!=', exceptLeadId)
  return q.execute()
}

export async function createLead(
  db: Db,
  actor: Actor,
  input: LeadInput,
  assignedTo: number | null = null
): Promise<{ leadId: number; leadNo: string; score: number }> {
  return db.transaction().execute(async (trx) => {
    const leadNo = await nextNumber(trx, 'lead')

    const inserted = await trx
      .insertInto('leads')
      .values({
        ...leadColumns(input),
        lead_no: leadNo,
        stage: 'new',
        stage_changed_at: nowSqlDateTime(),
        assigned_to: assignedTo,
        assigned_at: assignedTo === null ? null : nowSqlDateTime(),
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .executeTakeFirst()

    const leadId = Number(inserted.insertId ?? 0)
    if (!leadId) throw new Error('Lead insert returned no id')

    // The opening stage is recorded like every other, so the funnel report's
    // day counts start from a row rather than from an inferred zero.
    await trx
      .insertInto('lead_stage_history')
      .values({ lead_id: leadId, from_stage: null, to_stage: 'new', changed_by: actor.userId })
      .execute()

    const { score } = await rescoreLead(trx, leadId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_create',
      entityType: 'lead',
      entityId: leadId,
      after: { lead_no: leadNo, contact_name: input.contactName, phone: input.phone, score },
      ip: actor.ip,
    })

    return { leadId, leadNo, score }
  })
}

export async function updateLead(
  db: Db,
  actor: Actor,
  leadId: number,
  input: LeadInput
): Promise<{ score: number }> {
  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('leads')
      .select(['id', 'stage', 'contact_name', 'phone', 'preferred_package_id', 'target_built_up_sqft'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!before) throw new NotFoundError('That lead does not exist.')
    if (before.stage === 'won') {
      throw new ConflictError(
        'This lead has been converted to a project. Edit the project rather than the lead it came from.'
      )
    }

    await trx
      .updateTable('leads')
      .set({ ...leadColumns(input), updated_by: actor.userId })
      .where('id', '=', leadId)
      .execute()

    const { score } = await rescoreLead(trx, leadId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_update',
      entityType: 'lead',
      entityId: leadId,
      before: { contact_name: before.contact_name, phone: before.phone },
      after: { contact_name: input.contactName, phone: input.phone, score },
      ip: actor.ip,
    })

    return { score }
  })
}

/**
 * Promotes an enquiry to a lead (spec 6.7 routes: POST
 * /api/crm/leads/from-enquiry/:enquiryId).
 *
 * The contact details are copied inside the transaction from the enquiry row,
 * never from the post body, so a promotion cannot quietly change who enquired.
 *
 * The spec's note for this route says it "sets enquiries.lead_id and status".
 * There is no lead_id column on enquiries — leads.enquiry_id is the UNIQUE key
 * that carries the link, in that direction — so only the status is set here. See
 * DECISIONS.md; the link is not lost, it is held on the other side, and being
 * unique it cannot point at two leads.
 */
export async function leadFromEnquiry(
  db: Db,
  actor: Actor,
  enquiryId: number,
  assignedTo: number | null
): Promise<{ leadId: number; leadNo: string }> {
  return db.transaction().execute(async (trx) => {
    const enq = await trx
      .selectFrom('enquiries')
      .select([
        'id',
        'name',
        'phone',
        'email',
        'city',
        'service_interest',
        'message',
        'status',
      ])
      .where('id', '=', enquiryId)
      .forUpdate()
      .executeTakeFirst()
    if (!enq) throw new NotFoundError('That enquiry does not exist.')
    if (enq.status === 'spam') {
      throw new UnprocessableError('This enquiry is marked as spam. Reopen it before promoting it.')
    }

    const existing = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no'])
      .where('enquiry_id', '=', enquiryId)
      .executeTakeFirst()
    if (existing) {
      throw new ConflictError(`This enquiry is already lead ${existing.lead_no}.`)
    }

    const leadNo = await nextNumber(trx, 'lead')
    const inserted = await trx
      .insertInto('leads')
      .values({
        lead_no: leadNo,
        enquiry_id: enquiryId,
        contact_name: enq.name,
        phone: enq.phone,
        email: enq.email,
        site_city: enq.city,
        // service_interest is free text on the public form, so it seeds the
        // notes rather than the enquiry_type enum. The qualifier is set on the
        // first call, which is the only place it can be established honestly.
        next_action: 'First call: qualify plot, plan and funding.',
        next_action_date: today(),
        stage: 'new',
        stage_changed_at: nowSqlDateTime(),
        assigned_to: assignedTo,
        assigned_at: assignedTo === null ? null : nowSqlDateTime(),
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .executeTakeFirst()

    const leadId = Number(inserted.insertId ?? 0)
    if (!leadId) throw new Error('Lead insert returned no id')

    await trx
      .insertInto('lead_stage_history')
      .values({
        lead_id: leadId,
        from_stage: null,
        to_stage: 'new',
        changed_by: actor.userId,
        note: 'Promoted from website enquiry.',
      })
      .execute()

    // The enquiry's own words are the first thing anyone calling will want, so
    // they become the opening activity rather than staying on a separate row
    // nobody opens.
    if (enq.message !== null && enq.message.trim() !== '') {
      await trx
        .insertInto('lead_activities')
        .values({
          lead_id: leadId,
          activity_type: 'note',
          summary: `Website enquiry${enq.service_interest ? ` (${enq.service_interest})` : ''}: ${enq.message}`.slice(0, 500),
          created_by: actor.userId,
        })
        .execute()
    }

    await trx
      .updateTable('enquiries')
      .set({ status: 'promoted', handled_by: actor.userId })
      .where('id', '=', enquiryId)
      .execute()

    await rescoreLead(trx, leadId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_from_enquiry',
      entityType: 'lead',
      entityId: leadId,
      before: { enquiry_status: enq.status },
      after: { lead_no: leadNo, enquiry_id: enquiryId, enquiry_status: 'promoted' },
      ip: actor.ip,
    })

    return { leadId, leadNo }
  })
}

/* Stage, assignment and activity ----------------------------------------- */

/**
 * The stages a lead cannot be moved out of by hand.
 *
 * 'won' has a project hanging off it. 'lost' is what the rule 8 loss report is
 * built from, and a lead reopened out of 'lost' would quietly rewrite that
 * report's history. A client who comes back after being lost is a new lead —
 * cheap to create, and it keeps both records true.
 */
const TERMINAL_STAGES = ['won', 'lost'] as const

/**
 * Moves a lead's stage (spec 6.7 routes: PATCH /api/crm/leads/:id/stage).
 *
 * What "validated transitions" means here, since the spec gives the stage list
 * but no transition graph: the target must be a real stage; 'won' and 'lost' are
 * reachable only through their own actions, which carry the things that make
 * them true (a project, a reason); neither can be left by hand; and rule 3's
 * site-visit gate holds on the way into 'quote_sent'. Movement among the open
 * stages is otherwise free, in both directions.
 *
 * A stricter graph was the other option and I did not build one. A construction
 * sale runs three to twelve months and legitimately slips backwards — a
 * negotiation that returns to site_visit_scheduled because the client bought a
 * different plot is normal. A block there gets worked around by recording a
 * stage that is not true, which costs more than it saves. Recorded in
 * DECISIONS.md.
 *
 * No lead_activities row is written for a stage change. lead_stage_history is
 * the record of it, and an activity row would count as a touch — which would
 * make the dormancy cron's own writes look like contact and stop any lead from
 * ever going dormant twice.
 */
export async function changeStage(
  db: Db,
  actor: Actor,
  leadId: number,
  opts: { stage: string; note: string | null }
): Promise<{ from: string; to: string; days: number | null }> {
  if (opts.stage === 'won') {
    throw new UnprocessableError(
      'A lead becomes won by converting it to a project, which is what creates the client and the contract.'
    )
  }
  if (opts.stage === 'lost') {
    throw new UnprocessableError('Record a loss through the lose action, which asks for the reason.')
  }

  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no', 'stage', 'stage_changed_at', 'probability_pct', 'assigned_to'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')

    if ((TERMINAL_STAGES as readonly string[]).includes(lead.stage)) {
      throw new ConflictError(
        `This lead is ${lead.stage}, which is final. ${lead.stage === 'won' ? 'Work on the project it became.' : 'Create a new lead if the client comes back.'}`
      )
    }
    if (lead.stage === opts.stage) {
      throw new ConflictError(`This lead is already at ${opts.stage.replace(/_/g, ' ')}.`)
    }

    if (opts.stage === 'quote_sent' && !(await hasCompletedVisit(trx, leadId))) {
      throw new UnprocessableError(
        'No completed site visit with a feasibility verdict is on record. A per-square-foot rate quoted without seeing the plot is how a level difference or an approach road no transit mixer fits down turns a profitable job into a loss.'
      )
    }

    const changedOn = String(lead.stage_changed_at).slice(0, 10)
    // Stored rather than computed on read, per the note on the column: the
    // average-days-per-stage report is then one aggregate. Clamped because the
    // column is SMALLINT UNSIGNED and a bad backdated row must not abort the move.
    const rawDays = daysBetween(changedOn, today())
    const days = Number.isFinite(rawDays) ? Math.max(0, Math.min(65535, rawDays)) : null

    // The stage default replaces any override. Rule 2 makes probability a
    // function of the stage that a person may override; once the stage moves,
    // the override was about the old stage and holding it would be a forecast
    // nobody re-examined.
    const probability = STAGE_PROBABILITY[opts.stage] ?? null

    await trx
      .updateTable('leads')
      .set({
        stage: opts.stage as 'contacted',
        stage_changed_at: nowSqlDateTime(),
        probability_pct: probability,
        updated_by: actor.userId,
      })
      .where('id', '=', leadId)
      .execute()

    await trx
      .insertInto('lead_stage_history')
      .values({
        lead_id: leadId,
        from_stage: lead.stage,
        to_stage: opts.stage,
        changed_by: actor.userId,
        days_in_previous_stage: days,
        note: opts.note,
      })
      .execute()

    await rescoreLead(trx, leadId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_stage',
      entityType: 'lead',
      entityId: leadId,
      before: { stage: lead.stage, probability_pct: lead.probability_pct },
      after: { stage: opts.stage, probability_pct: probability, days_in_previous_stage: days },
      ip: actor.ip,
    })

    return { from: lead.stage, to: opts.stage, days }
  })
}

/**
 * Assigns a lead, or returns it to the pool (spec 6.7 routes: PATCH
 * /api/crm/leads/:id/assign).
 *
 * assigned_to NULL is the unassigned pool, not an error, which is why '' is a
 * valid submission. Returning a lead to the pool is a real act — an exec going
 * on leave should be able to hand work back rather than sit on it.
 */
export async function assignLead(
  db: Db,
  actor: Actor,
  leadId: number,
  opts: { assignedTo: number | null; note: string | null }
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no', 'contact_name', 'stage', 'assigned_to'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')
    if (lead.stage === 'won') {
      throw new ConflictError('This lead has been converted. Change the project team instead.')
    }

    const before = lead.assigned_to === null ? null : Number(lead.assigned_to)
    if (before === opts.assignedTo) {
      throw new ConflictError(
        opts.assignedTo === null ? 'This lead is already in the pool.' : 'This lead is already assigned to that person.'
      )
    }

    if (opts.assignedTo !== null) {
      const user = await trx
        .selectFrom('users')
        .select(['id', 'status'])
        .where('id', '=', opts.assignedTo)
        .executeTakeFirst()
      if (!user) throw new NotFoundError('That user does not exist.')
      if (user.status !== 'active') {
        throw new UnprocessableError('That user is not active, so work cannot be assigned to them.')
      }
    }

    await trx
      .updateTable('leads')
      .set({
        assigned_to: opts.assignedTo,
        assigned_at: opts.assignedTo === null ? null : nowSqlDateTime(),
        updated_by: actor.userId,
      })
      .where('id', '=', leadId)
      .execute()

    if (opts.assignedTo !== null) {
      await notify(trx, {
        userIds: [opts.assignedTo],
        exceptUserId: actor.userId,
        kind: 'lead_assigned',
        title: `Lead ${lead.lead_no} is yours`,
        body: `${lead.contact_name}${opts.note ? ` — ${opts.note}` : ''}`,
        linkPath: `/app/crm/leads/${leadId}`,
      })
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_assign',
      entityType: 'lead',
      entityId: leadId,
      before: { assigned_to: before },
      after: { assigned_to: opts.assignedTo, note: opts.note },
      ip: actor.ip,
    })
  })
}

/**
 * The activity types that count as us reaching out.
 *
 * Rule 7 stamps first_response_at from "the first outbound lead_activities
 * row". call_in is the client reaching us, so it is not a response. note and
 * status_change are internal bookkeeping: if a note counted, the response clock
 * would be stopped by someone typing to themselves.
 */
const OUTBOUND_ACTIVITY_TYPES = [
  'call_out',
  'whatsapp',
  'email',
  'meeting',
  'site_visit',
  'quote_sent',
  'follow_up',
] as const

/**
 * Records a touch (spec 6.7 routes: POST /api/crm/leads/:id/activities).
 *
 * next_action and next_action_date cascade to the lead, because the lead row is
 * what the overdue-followups cron and the board read. Only a supplied value
 * cascades: an activity that names no next step leaves the standing one alone
 * rather than clearing it.
 */
export async function logActivity(
  db: Db,
  actor: Actor,
  leadId: number,
  input: {
    activityType: string
    occurredAt: string
    durationMinutes: number | null
    outcome: string | null
    summary: string
    nextAction: string | null
    nextActionDate: string | null
  }
): Promise<{ activityId: number; firstResponse: boolean }> {
  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'stage', 'first_response_at'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')

    const inserted = await trx
      .insertInto('lead_activities')
      .values({
        lead_id: leadId,
        activity_type: input.activityType as 'call_out',
        occurred_at: input.occurredAt,
        duration_minutes: input.durationMinutes,
        outcome: input.outcome as 'connected' | null,
        summary: input.summary,
        next_action: input.nextAction,
        next_action_date: input.nextActionDate,
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const activityId = Number(inserted.insertId ?? 0)
    if (!activityId) throw new Error('Activity insert returned no id')

    const firstResponse =
      lead.first_response_at === null &&
      (OUTBOUND_ACTIVITY_TYPES as readonly string[]).includes(input.activityType)

    const set: {
      updated_by: number
      first_response_at?: string
      next_action?: string
      next_action_date?: string
    } = { updated_by: actor.userId }
    if (firstResponse) set.first_response_at = input.occurredAt
    if (input.nextAction !== null) set.next_action = input.nextAction
    if (input.nextActionDate !== null) set.next_action_date = input.nextActionDate

    await trx.updateTable('leads').set(set).where('id', '=', leadId).execute()

    // Recency feeds temperature, so a touch changes it. This is the write that
    // makes a hot lead cool down on its own when nobody calls.
    await rescoreLead(trx, leadId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_activity',
      entityType: 'lead',
      entityId: leadId,
      after: {
        activity_id: activityId,
        activity_type: input.activityType,
        outcome: input.outcome,
        first_response_at: firstResponse ? input.occurredAt : undefined,
      },
      ip: actor.ip,
    })

    return { activityId, firstResponse }
  })
}

/* Site visits ------------------------------------------------------------ */

/**
 * Books a visit (spec 6.7 routes: POST /api/crm/leads/:id/site-visits).
 *
 * Booking one moves the lead to site_visit_scheduled unless it is already
 * further along, so the board reflects the appointment without a second click.
 * A lead past the visit stage keeps its stage: a second visit late in a
 * negotiation should not walk the pipeline backwards.
 */
export async function scheduleVisit(
  db: Db,
  actor: Actor,
  opts: { leadId: number; scheduledAt: string; visitedBy: number | null }
): Promise<{ visitId: number }> {
  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no', 'contact_name', 'stage', 'site_locality', 'site_city', 'assigned_to'])
      .where('id', '=', opts.leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')
    if ((TERMINAL_STAGES as readonly string[]).includes(lead.stage)) {
      throw new ConflictError(`This lead is ${lead.stage}. Visits are not booked against a closed lead.`)
    }

    const inserted = await trx
      .insertInto('site_visits')
      .values({
        lead_id: opts.leadId,
        scheduled_at: opts.scheduledAt,
        visited_by: opts.visitedBy,
        status: 'scheduled',
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const visitId = Number(inserted.insertId ?? 0)
    if (!visitId) throw new Error('Site visit insert returned no id')

    if (advances(lead.stage, 'site_visit_scheduled')) {
      await trx
        .updateTable('leads')
        .set({
          stage: 'site_visit_scheduled',
          stage_changed_at: nowSqlDateTime(),
          probability_pct: STAGE_PROBABILITY['site_visit_scheduled'] ?? null,
          updated_by: actor.userId,
        })
        .where('id', '=', opts.leadId)
        .execute()
      await trx
        .insertInto('lead_stage_history')
        .values({
          lead_id: opts.leadId,
          from_stage: lead.stage,
          to_stage: 'site_visit_scheduled',
          changed_by: actor.userId,
          note: 'Site visit booked.',
        })
        .execute()
    }

    if (opts.visitedBy !== null) {
      await notify(trx, {
        userIds: [opts.visitedBy],
        exceptUserId: actor.userId,
        kind: 'site_visit_scheduled',
        title: `Site visit booked for ${lead.lead_no}`,
        body: `${lead.contact_name}, ${lead.site_locality ?? lead.site_city ?? 'site'} — ${opts.scheduledAt}`,
        linkPath: `/app/crm/visits/${visitId}`,
      })
    }

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.visit_schedule',
      entityType: 'site_visit',
      entityId: visitId,
      after: { lead_id: opts.leadId, scheduled_at: opts.scheduledAt, visited_by: opts.visitedBy },
      ip: actor.ip,
    })

    return { visitId }
  })
}

/**
 * The feasibility form (spec 6.7 routes: PUT /api/crm/site-visits/:id/complete).
 *
 * This is the write rule 3 gates the quote on, so completion is the point at
 * which the findings must exist. feasibility is required by the schema, and
 * estimated_extra_cost_paise recorded here is what createQuote picks up as
 * extras — the surveyor's number reaches the price without anyone retyping it.
 *
 * Completing moves the lead to site_visit_done, again only from an earlier
 * stage. A not_feasible verdict does not disqualify the lead automatically: the
 * decision to walk away is a person's, and 'feasible_with_conditions' priced
 * with the conditions is often the right answer instead.
 */
export async function completeVisit(
  db: Db,
  actor: Actor,
  visitId: number,
  input: {
    visitedAt: string
    visitedBy: number | null
    soilType: string | null
    roadAccess: string | null
    waterAvailability: string | null
    powerAvailability: number | null
    neighbouringStructures: string | null
    levelDifferenceFt: number | null
    demolitionRequired: number | null
    treeCuttingPermissionNeeded: number | null
    accessConstraints: string | null
    feasibility: string
    conditionsNotes: string | null
    estimatedExtraCostPaise: number | null
  }
): Promise<{ leadId: number }> {
  return db.transaction().execute(async (trx) => {
    const visit = await trx
      .selectFrom('site_visits')
      .select(['id', 'lead_id', 'status', 'feasibility'])
      .where('id', '=', visitId)
      .forUpdate()
      .executeTakeFirst()
    if (!visit) throw new NotFoundError('That site visit does not exist.')
    if (visit.status === 'cancelled') {
      throw new ConflictError('This visit was cancelled. Book a new one rather than completing it.')
    }

    const leadId = Number(visit.lead_id)

    await trx
      .updateTable('site_visits')
      .set({
        status: 'completed',
        visited_at: input.visitedAt,
        visited_by: input.visitedBy,
        soil_type: input.soilType,
        road_access: input.roadAccess as 'good' | null,
        water_availability: input.waterAvailability as 'borewell' | null,
        power_availability: input.powerAvailability,
        neighbouring_structures: input.neighbouringStructures,
        level_difference_ft: input.levelDifferenceFt,
        demolition_required: input.demolitionRequired,
        tree_cutting_permission_needed: input.treeCuttingPermissionNeeded,
        access_constraints: input.accessConstraints,
        feasibility: input.feasibility as 'feasible',
        conditions_notes: input.conditionsNotes,
        estimated_extra_cost_paise: input.estimatedExtraCostPaise,
      })
      .where('id', '=', visitId)
      .execute()

    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'stage'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')

    if (advances(lead.stage, 'site_visit_done')) {
      await trx
        .updateTable('leads')
        .set({
          stage: 'site_visit_done',
          stage_changed_at: nowSqlDateTime(),
          probability_pct: STAGE_PROBABILITY['site_visit_done'] ?? null,
          updated_by: actor.userId,
        })
        .where('id', '=', leadId)
        .execute()
      await trx
        .insertInto('lead_stage_history')
        .values({
          lead_id: leadId,
          from_stage: lead.stage,
          to_stage: 'site_visit_done',
          changed_by: actor.userId,
          note: `Visit completed: ${input.feasibility.replace(/_/g, ' ')}.`,
        })
        .execute()
    }

    // The visit is a touch, and a substantial one, so it appears on the
    // timeline. Written here rather than left to the user, because a visit that
    // happened and is not on the timeline reads as silence to the follow-up cron.
    await trx
      .insertInto('lead_activities')
      .values({
        lead_id: leadId,
        activity_type: 'site_visit',
        occurred_at: input.visitedAt,
        outcome: input.feasibility === 'not_feasible' ? 'negative' : 'positive',
        summary: `Site visit: ${input.feasibility.replace(/_/g, ' ')}${
          input.estimatedExtraCostPaise ? `, extras ${formatPaise(input.estimatedExtraCostPaise)}` : ''
        }${input.conditionsNotes ? ` — ${input.conditionsNotes}` : ''}`.slice(0, 500),
        created_by: actor.userId,
      })
      .execute()

    await rescoreLead(trx, leadId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.visit_complete',
      entityType: 'site_visit',
      entityId: visitId,
      before: { status: visit.status, feasibility: visit.feasibility },
      after: {
        status: 'completed',
        feasibility: input.feasibility,
        estimated_extra_cost_paise: input.estimatedExtraCostPaise,
      },
      ip: actor.ip,
    })

    return { leadId }
  })
}

/**
 * Marks a visit no-show, rescheduled or cancelled.
 *
 * 'completed' is refused here on purpose: completion is the feasibility form,
 * and a status flipped to completed without findings would satisfy half of
 * rule 3's gate while establishing nothing about the plot.
 */
export async function setVisitStatus(
  db: Db,
  actor: Actor,
  visitId: number,
  opts: { status: string; scheduledAt: string | null }
): Promise<void> {
  if (opts.status === 'completed') {
    throw new UnprocessableError(
      'Complete a visit through the feasibility form, so the findings that a quote depends on are on the record.'
    )
  }

  await db.transaction().execute(async (trx) => {
    const visit = await trx
      .selectFrom('site_visits')
      .select(['id', 'lead_id', 'status', 'scheduled_at'])
      .where('id', '=', visitId)
      .forUpdate()
      .executeTakeFirst()
    if (!visit) throw new NotFoundError('That site visit does not exist.')
    if (visit.status === 'completed') {
      throw new ConflictError('This visit is already completed. Its findings are what a quote rests on.')
    }

    if (opts.status === 'rescheduled' && opts.scheduledAt === null) {
      throw new UnprocessableError('Give the new date and time when rescheduling.')
    }

    await trx
      .updateTable('site_visits')
      .set({
        status: opts.status as 'cancelled',
        scheduled_at: opts.scheduledAt ?? visit.scheduled_at,
      })
      .where('id', '=', visitId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.visit_status',
      entityType: 'site_visit',
      entityId: visitId,
      before: { status: visit.status, scheduled_at: visit.scheduled_at },
      after: { status: opts.status, scheduled_at: opts.scheduledAt ?? visit.scheduled_at },
      ip: actor.ip,
    })
  })
}

/* Quotes ----------------------------------------------------------------- */

/** The computed money on a quote. Every figure here is derived, never posted. */
export interface QuoteTotals {
  basePaise: number
  extrasPaise: number
  discountPaise: number
  subtotalPaise: number
  gstPaise: number
  totalPaise: number
}

/**
 * The quote arithmetic (spec 6.7 rules 4 and 5).
 *
 * Pure, so the same numbers can be asserted in a test without a database and so
 * a route cannot reach a total by any path but this one.
 *
 * For a per-square-foot quote the base is area times rate and the lines are
 * extras on top of it. For item-rate and lumpsum there is no rate to be extra
 * to, so the lines *are* the base. Either way the site visit's estimated extra
 * cost is added as extras, which is rule 3's requirement that what the surveyor
 * found reaches the price.
 *
 * The discount applies to base plus extras, not to base alone — discounting the
 * contract but not the extras is a distinction no client has ever accepted, and
 * quoting it that way makes the printed percentage a lie.
 */
export function computeQuoteTotals(opts: {
  pricingBasis: string
  builtUpAreaSqft: number | null
  ratePerSqftPaise: number | null
  linesPaise: number
  visitExtrasPaise: number
  discountPct: number
  gstPct: number
}): QuoteTotals {
  const perSqft = opts.pricingBasis === 'per_sqft'
  const basePaise = perSqft
    ? Math.round((opts.builtUpAreaSqft ?? 0) * (opts.ratePerSqftPaise ?? 0))
    : opts.linesPaise
  const extrasPaise = (perSqft ? opts.linesPaise : 0) + opts.visitExtrasPaise

  const discountable = basePaise + extrasPaise
  const discountPaise = Math.round((discountable * opts.discountPct) / 100)
  const subtotalPaise = discountable - discountPaise

  const gst = splitGst(subtotalPaise, opts.gstPct)
  const gstPaise = gst.cgstPaise + gst.sgstPaise + gst.igstPaise

  return {
    basePaise,
    extrasPaise,
    discountPaise,
    subtotalPaise,
    gstPaise,
    totalPaise: subtotalPaise + gstPaise,
  }
}

/**
 * Creates a quote (spec 6.7 routes: POST /app/crm/quotes).
 *
 * The rate comes from the effective site_packages row unless the form overrode
 * it, which is 6.7 rule 4's "prices off the live package"
 * (NCC_BUILD_SPEC.md:1930). The inclusion list is not copied onto the quote: it
 * is read from package_spec_lines at print time. What rule 4 requires is the
 * property — the list is "exactly the published specification" and "cannot
 * drift from what the site advertises" — and reading at print time is this
 * module's mechanism for it, chosen because the alternative of snapshotting the
 * lines onto the quote is the drift the rule rules out. It has a known
 * consequence — see the uq_packages_slug entry in DECISIONS.md,
 * where a unique key on slug alone prevents 6.5 rule 4's "close the row and
 * insert a new one" from working, so a rate change edits the row a sent quote
 * points at. The priced numbers are snapshotted on the quote row, so the money
 * cannot move; the wording of the inclusion list can.
 *
 * The quote opens as a draft. Nothing is priced to a client until submit runs
 * the discount through approval_limits.
 */
export async function createQuote(
  db: Db,
  actor: Actor,
  input: QuoteInput
): Promise<{ quoteId: number; quoteNo: string; totals: QuoteTotals }> {
  return db.transaction().execute(async (trx) => {
    const quoteNo = await nextNumber(trx, 'quote')
    const built = await insertPricedQuote(trx, actor, input, {
      quoteNo,
      revision: 1,
      supersedesQuoteId: null,
    })
    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_create',
      entityType: 'quote',
      entityId: built.quoteId,
      after: {
        quote_no: quoteNo,
        revision: 1,
        lead_id: input.leadId,
        pricing_basis: input.pricingBasis,
        rate_per_sqft_paise: built.ratePerSqftPaise,
        base_amount_paise: built.totals.basePaise,
        extras_amount_paise: built.totals.extrasPaise,
        discount_pct: input.discountPct,
        total_paise: built.totals.totalPaise,
      },
      ip: actor.ip,
    })
    return { quoteId: built.quoteId, quoteNo, totals: built.totals }
  })
}

/**
 * Prices a quote and writes the row and its lines.
 *
 * Shared by createQuote and reviseQuote so a revision is priced by exactly the
 * same code as the original. If the two diverged, a revision could quote a rate
 * the package no longer carries, and rule 5's "the client's copy and the
 * system's copy must match" would hold for revision 1 only.
 */
async function insertPricedQuote(
  trx: Trx,
  actor: Actor,
  input: QuoteInput,
  meta: { quoteNo: string; revision: number; supersedesQuoteId: number | null }
): Promise<{ quoteId: number; totals: QuoteTotals; ratePerSqftPaise: number | null }> {
  {
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no', 'contact_name', 'stage', 'target_built_up_sqft', 'preferred_package_id'])
      .where('id', '=', input.leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')
    if ((TERMINAL_STAGES as readonly string[]).includes(lead.stage)) {
      throw new ConflictError(`This lead is ${lead.stage}. A closed lead is not quoted.`)
    }

    // Rule 3, checked at creation as well as at send. Building a quote that
    // cannot be sent wastes the sales exec's afternoon, so the refusal comes
    // before the work rather than after it.
    if (!(await hasCompletedVisit(trx, input.leadId))) {
      throw new UnprocessableError(
        'This lead has no completed site visit with a feasibility verdict. Quoting a per-square-foot rate without seeing the plot is how a 4 ft level difference or a 12 ft approach road turns a profitable job into a loss.'
      )
    }

    let ratePerSqftPaise = input.ratePerSqftPaise
    let packageName: string | null = null
    if (input.packageId !== null) {
      const pkg = await findEffectivePackage(trx, input.packageId, input.quoteDate)
      if (!pkg) {
        throw new UnprocessableError(
          'That package has no rate in effect on the quote date. Pick another package or set the rate by hand.'
        )
      }
      packageName = pkg.name
      if (ratePerSqftPaise === null) ratePerSqftPaise = Number(pkg.rate_per_sqft_paise)
      if (
        input.builtUpAreaSqft !== null &&
        pkg.min_area_sqft !== null &&
        input.builtUpAreaSqft < Number(pkg.min_area_sqft)
      ) {
        throw new UnprocessableError(
          `${pkg.name} applies from ${Number(pkg.min_area_sqft)} sq ft. This quote is for ${input.builtUpAreaSqft} sq ft.`
        )
      }
    }

    if (input.pricingBasis === 'per_sqft' && (ratePerSqftPaise === null || ratePerSqftPaise <= 0)) {
      throw new UnprocessableError(
        'A per-square-foot quote needs a rate. Choose a package or enter the rate.'
      )
    }

    // Rule 3: the surveyor's extra-cost estimate prefills extras. The most
    // recent completed visit is the one that describes the plot as it is now.
    const visit = await trx
      .selectFrom('site_visits')
      .select(['id', 'estimated_extra_cost_paise', 'feasibility', 'conditions_notes'])
      .where('lead_id', '=', input.leadId)
      .where('status', '=', 'completed')
      .orderBy('visited_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst()
    const visitExtrasPaise =
      visit?.estimated_extra_cost_paise === null || visit?.estimated_extra_cost_paise === undefined
        ? 0
        : Number(visit.estimated_extra_cost_paise)

    const linesPaise = input.lines.reduce((sum, l) => sum + l.amountPaise, 0)
    const totals = computeQuoteTotals({
      pricingBasis: input.pricingBasis,
      builtUpAreaSqft: input.builtUpAreaSqft,
      ratePerSqftPaise,
      linesPaise,
      visitExtrasPaise,
      discountPct: input.discountPct,
      gstPct: input.gstPct,
    })

    const inserted = await trx
      .insertInto('quotes')
      .values({
        quote_no: meta.quoteNo,
        revision: meta.revision,
        supersedes_quote_id: meta.supersedesQuoteId,
        lead_id: input.leadId,
        package_id: input.packageId,
        quote_date: input.quoteDate,
        valid_until: input.validUntil,
        pricing_basis: input.pricingBasis,
        built_up_area_sqft: input.builtUpAreaSqft,
        rate_per_sqft_paise: ratePerSqftPaise,
        base_amount_paise: totals.basePaise,
        extras_amount_paise: totals.extrasPaise,
        discount_pct: input.discountPct,
        discount_amount_paise: totals.discountPaise,
        subtotal_paise: totals.subtotalPaise,
        gst_pct: input.gstPct,
        gst_paise: totals.gstPaise,
        total_paise: totals.totalPaise,
        exclusions: input.exclusions,
        payment_schedule_json: JSON.stringify(input.schedule),
        status: 'draft',
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const quoteId = Number(inserted.insertId ?? 0)
    if (!quoteId) throw new Error('Quote insert returned no id')

    await writeQuoteLines(trx, quoteId, {
      pricingBasis: input.pricingBasis,
      packageName,
      builtUpAreaSqft: input.builtUpAreaSqft,
      ratePerSqftPaise,
      basePaise: totals.basePaise,
      lines: input.lines,
      visitExtrasPaise,
      visitNote: visit?.conditions_notes ?? null,
      discountPct: input.discountPct,
      discountPaise: totals.discountPaise,
      exclusionList: input.exclusionList,
    })

    return { quoteId, totals, ratePerSqftPaise }
  }
}

/**
 * Writes the printable body of a quote.
 *
 * quote_lines is what the A4 print reads, so every figure on the page has a row
 * behind it: the base as one 'package' line, the extras, the discount as a
 * negative 'discount' line, and each exclusion as an 'exclusion_note'. The
 * exclusions are written as lines as well as kept in the TEXT column because
 * rule 4's point is that they are enumerated on the document, and a paragraph is
 * skimmed where a list is read.
 */
async function writeQuoteLines(
  trx: Trx,
  quoteId: number,
  opts: {
    pricingBasis: string
    packageName: string | null
    builtUpAreaSqft: number | null
    ratePerSqftPaise: number | null
    basePaise: number
    lines: QuoteInput['lines']
    visitExtrasPaise: number
    visitNote: string | null
    discountPct: number
    discountPaise: number
    exclusionList: readonly string[]
  }
): Promise<void> {
  let sort = 0

  if (opts.pricingBasis === 'per_sqft') {
    await trx
      .insertInto('quote_lines')
      .values({
        quote_id: quoteId,
        line_type: 'package',
        description: (opts.packageName ?? 'Construction as specified').slice(0, 300),
        qty: opts.builtUpAreaSqft,
        rate_paise: opts.ratePerSqftPaise,
        amount_paise: opts.basePaise,
        sort_order: sort++,
      })
      .execute()
  }

  for (const line of opts.lines) {
    await trx
      .insertInto('quote_lines')
      .values({
        quote_id: quoteId,
        line_type: line.lineType,
        description: line.description,
        qty: line.qty,
        unit_id: line.unitId,
        rate_paise: line.ratePaise,
        amount_paise: line.amountPaise,
        cost_head_id: line.costHeadId,
        sort_order: sort++,
      })
      .execute()
  }

  if (opts.visitExtrasPaise !== 0) {
    await trx
      .insertInto('quote_lines')
      .values({
        quote_id: quoteId,
        line_type: 'extra_work',
        description: `Site conditions from the visit${opts.visitNote ? `: ${opts.visitNote}` : ''}`.slice(0, 300),
        amount_paise: opts.visitExtrasPaise,
        sort_order: sort++,
      })
      .execute()
  }

  if (opts.discountPaise > 0) {
    // Signed, so a reader adding the amount column reaches the subtotal. The
    // column is a plain BIGINT, which is what makes that possible.
    await trx
      .insertInto('quote_lines')
      .values({
        quote_id: quoteId,
        line_type: 'discount',
        description: `Discount ${opts.discountPct}%`,
        amount_paise: -opts.discountPaise,
        sort_order: 900,
      })
      .execute()
  }

  let noteSort = 1000
  for (const text of opts.exclusionList) {
    await trx
      .insertInto('quote_lines')
      .values({
        quote_id: quoteId,
        line_type: 'exclusion_note',
        description: text.slice(0, 300),
        amount_paise: 0,
        sort_order: noteSort++,
      })
      .execute()
  }
}

/** What submitting a quote for pricing approval settled. */
export interface QuoteSubmitResult {
  quoteNo: string
  revision: number
  status: 'approved' | 'pending_approval'
  discountPct: number
  totalPaise: number
  /** The ceiling that decided it, in basis points. Null when no row applied. */
  limitBps: number | null
}

/**
 * Submits a quote for pricing approval (spec 6.7 rule 5).
 *
 * The discount is compared in basis points, because that is what
 * approval_limits.max_value holds for document_type quote_discount_pct — stated
 * in migrations/002_rbac.sql lines 91-93, so this is not an inference. 2.50%
 * becomes 250 bps.
 *
 * Three outcomes:
 *
 *   1. No discount at all. Nothing is being given away, so there is nothing to
 *      approve and the quote is approved on the spot.
 *   2. At or below the role's ceiling. Self-approves, which is rule 5 as
 *      written: "Below the sales exec's limit it self-approves". Deliberately
 *      unlike approvePo, which blocks self-approval — the difference is that a
 *      PO spends the company's money and a discount inside an agreed ceiling is
 *      the exec doing the job the ceiling defines. Above the ceiling the
 *      escalated approval in approveQuote does block self-approval.
 *   3. Above the ceiling, or no ceiling set at all. Moves to pending_approval
 *      and notifies. It escalates rather than throwing, because approval_limits
 *      is seeded empty pending open question 8.2, so today every discounted
 *      quote takes this path and a throw would make discounting impossible
 *      rather than supervised.
 */
export async function submitQuote(
  db: Db,
  actor: Actor,
  quoteId: number,
  roleKeys: readonly string[]
): Promise<QuoteSubmitResult> {
  return db.transaction().execute(async (trx) => {
    const quote = await loadQuoteForUpdate(trx, quoteId)
    if (quote.status !== 'draft') {
      throw new ConflictError(
        `This quote is ${quote.status.replace(/_/g, ' ')}. Only a draft is submitted for approval.`
      )
    }

    const discountPct = Number(quote.discount_pct)
    const totalPaise = Number(quote.total_paise)
    const bps = Math.round(discountPct * 100)
    const now = nowSqlDateTime()

    if (bps === 0) {
      await trx
        .updateTable('quotes')
        .set({ status: 'approved', approved_by: actor.userId, approved_at: now })
        .where('id', '=', quoteId)
        .execute()
      await writeAudit(trx, {
        userId: actor.userId,
        action: 'crm.quote_approve',
        entityType: 'quote',
        entityId: quoteId,
        before: { status: 'draft' },
        after: { status: 'approved', discount_pct: 0, total_paise: totalPaise },
        ip: actor.ip,
      })
      return { quoteNo: quote.quote_no, revision: quote.revision, status: 'approved', discountPct, totalPaise, limitBps: null }
    }

    const limit = await resolveApprovalLimit(trx, roleKeys, 'quote_discount_pct', today())
    const withinLimit = limit !== null && bps <= Number(limit.maxValue)

    if (withinLimit) {
      await trx
        .updateTable('quotes')
        .set({
          status: 'approved',
          discount_approved_by: actor.userId,
          approved_by: actor.userId,
          approved_at: now,
        })
        .where('id', '=', quoteId)
        .execute()
      await writeAudit(trx, {
        userId: actor.userId,
        action: 'crm.quote_self_approve',
        entityType: 'quote',
        entityId: quoteId,
        before: { status: 'draft' },
        after: {
          status: 'approved',
          discount_pct: discountPct,
          discount_bps: bps,
          limit_bps: Number(limit.maxValue),
          role_key: limit.roleKey,
          total_paise: totalPaise,
        },
        ip: actor.ip,
      })
      return {
        quoteNo: quote.quote_no,
        revision: quote.revision,
        status: 'approved',
        discountPct,
        totalPaise,
        limitBps: Number(limit.maxValue),
      }
    }

    await trx
      .updateTable('quotes')
      .set({ status: 'pending_approval' })
      .where('id', '=', quoteId)
      .execute()

    await notifyPermission(trx, PERMISSIONS.CRM_QUOTE_APPROVE, {
      actorId: actor.userId,
      kind: 'quote_discount_approval',
      title: `Quote ${quote.quote_no} rev ${quote.revision} needs a discount approval`,
      body:
        limit === null
          ? `${discountPct}% discount on ${formatPaise(totalPaise)}. No discount ceiling is set for the submitter's role.`
          : `${discountPct}% discount on ${formatPaise(totalPaise)} is above the ${Number(limit.maxValue) / 100}% ceiling for ${limit.roleKey}.`,
      linkPath: `/app/crm/quotes/${quoteId}`,
      severity: 'warn',
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_submit',
      entityType: 'quote',
      entityId: quoteId,
      before: { status: 'draft' },
      after: {
        status: 'pending_approval',
        discount_pct: discountPct,
        discount_bps: bps,
        limit_bps: limit === null ? null : Number(limit.maxValue),
        total_paise: totalPaise,
      },
      ip: actor.ip,
    })

    return {
      quoteNo: quote.quote_no,
      revision: quote.revision,
      status: 'pending_approval',
      discountPct,
      totalPaise,
      limitBps: limit === null ? null : Number(limit.maxValue),
    }
  })
}

/** The quote row every lifecycle step locks and reads. */
async function loadQuoteForUpdate(trx: Trx, quoteId: number) {
  const quote = await trx
    .selectFrom('quotes')
    .select([
      'id', 'quote_no', 'revision', 'lead_id', 'package_id', 'status',
      'quote_date', 'valid_until', 'pricing_basis', 'built_up_area_sqft',
      'rate_per_sqft_paise', 'base_amount_paise', 'extras_amount_paise',
      'discount_pct', 'discount_amount_paise', 'subtotal_paise', 'gst_pct',
      'gst_paise', 'total_paise', 'exclusions', 'payment_schedule_json',
      'approved_by', 'created_by', 'sent_at',
    ])
    .where('id', '=', quoteId)
    .forUpdate()
    .executeTakeFirst()
  if (!quote) throw new NotFoundError('That quote does not exist.')
  return quote
}

/**
 * Approves an escalated discount (spec 6.7 routes: POST /app/crm/quotes/:id/approve).
 *
 * Self-approval is blocked here, unlike in submitQuote. The two are not
 * inconsistent: submit self-approves only what the role's own ceiling already
 * permits, and this route exists precisely for the amounts that ceiling does
 * not cover. Letting the submitter clear their own escalation would make the
 * ceiling advisory.
 *
 * The approver's own limit is not re-checked. crm.quote_approve is the
 * permission for the exception, and the alternative — a chain of ceilings —
 * would deadlock the moment nobody's row covers the figure, which with
 * approval_limits seeded empty is every figure.
 */
export async function approveQuote(
  db: Db,
  actor: Actor,
  quoteId: number
): Promise<{ quoteNo: string; revision: number; totalPaise: number }> {
  return db.transaction().execute(async (trx) => {
    const quote = await loadQuoteForUpdate(trx, quoteId)
    if (quote.status !== 'pending_approval') {
      throw new ConflictError(
        `This quote is ${quote.status.replace(/_/g, ' ')}. Only one awaiting approval can be approved.`
      )
    }
    if (Number(quote.created_by) === actor.userId) {
      throw new UnprocessableError(
        'You raised this quote, so you cannot approve its discount. That is what the escalation is for.'
      )
    }

    await trx
      .updateTable('quotes')
      .set({
        status: 'approved',
        approved_by: actor.userId,
        approved_at: nowSqlDateTime(),
        discount_approved_by: actor.userId,
      })
      .where('id', '=', quoteId)
      .execute()

    await notify(trx, {
      userIds: [Number(quote.created_by)],
      exceptUserId: actor.userId,
      kind: 'quote_approved',
      title: `Quote ${quote.quote_no} rev ${quote.revision} approved`,
      body: `${Number(quote.discount_pct)}% discount cleared. ${formatPaise(Number(quote.total_paise))} can be sent.`,
      linkPath: `/app/crm/quotes/${quoteId}`,
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_approve',
      entityType: 'quote',
      entityId: quoteId,
      before: { status: 'pending_approval' },
      after: { status: 'approved', discount_pct: Number(quote.discount_pct), total_paise: Number(quote.total_paise) },
      ip: actor.ip,
    })

    return { quoteNo: quote.quote_no, revision: quote.revision, totalPaise: Number(quote.total_paise) }
  })
}

/**
 * Declines an escalated discount, returning the quote to draft.
 *
 * Not in the spec's route table, which names only /approve. A pending_approval
 * quote with no way back is a dead row: the exec cannot edit the price to
 * something the approver would accept, and cannot send it either. Declining to
 * draft is the only exit that leaves the sale alive, and the reason is written
 * to the audit log so the refusal is on the record.
 */
export async function declineQuote(
  db: Db,
  actor: Actor,
  quoteId: number,
  reason: string
): Promise<{ quoteNo: string; revision: number }> {
  return db.transaction().execute(async (trx) => {
    const quote = await loadQuoteForUpdate(trx, quoteId)
    if (quote.status !== 'pending_approval') {
      throw new ConflictError(
        `This quote is ${quote.status.replace(/_/g, ' ')}. Only one awaiting approval can be declined.`
      )
    }

    await trx
      .updateTable('quotes')
      .set({ status: 'draft', rejected_reason: reason.slice(0, 300) })
      .where('id', '=', quoteId)
      .execute()

    await notify(trx, {
      userIds: [Number(quote.created_by)],
      exceptUserId: actor.userId,
      kind: 'quote_discount_declined',
      title: `Discount on quote ${quote.quote_no} rev ${quote.revision} declined`,
      body: reason,
      linkPath: `/app/crm/quotes/${quoteId}`,
      severity: 'warn',
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_discount_decline',
      entityType: 'quote',
      entityId: quoteId,
      before: { status: 'pending_approval' },
      after: { status: 'draft', reason },
      ip: actor.ip,
    })

    return { quoteNo: quote.quote_no, revision: quote.revision }
  })
}

/** What sending a quote settled, including whether the email actually left. */
export interface QuoteSendResult {
  quoteNo: string
  revision: number
  emailed: boolean
  emailError: string | null
  recipient: string | null
  stageMoved: boolean
}

/**
 * Sends an approved quote to the client (spec 6.7 routes: POST
 * /api/crm/quotes/:id/send — "Emails the PDF-printable link, stamps sent_at").
 *
 * The database work and the email are deliberately not in one transaction. The
 * mailer opens a socket and writes an email_log row; holding a row lock on the
 * quote across an SMTP round trip is how a slow mail server becomes a stuck
 * pipeline. So the status moves and commits first, then the mail goes out on the
 * pool connection, and its outcome is reported rather than rolled back. A quote
 * marked sent whose email bounced is recoverable — the exec sees the failure and
 * resends or phones. A quote left in approved whose email did go out is not.
 */
export async function sendQuote(
  db: Db,
  actor: Actor,
  quoteId: number
): Promise<QuoteSendResult> {
  const prepared = await db.transaction().execute(async (trx) => {
    const quote = await loadQuoteForUpdate(trx, quoteId)
    if (quote.status !== 'approved') {
      throw new ConflictError(
        quote.status === 'sent' || quote.status === 'viewed'
          ? `This quote has already gone to the client. Revise it to send a changed price.`
          : `This quote is ${quote.status.replace(/_/g, ' ')}. Only an approved quote is sent.`
      )
    }
    if (quote.valid_until < today()) {
      throw new UnprocessableError(
        `This quote expired on ${quote.valid_until}. Revise it with a new validity date rather than sending a dead price.`
      )
    }

    // Rule 3 again, at the last possible moment. Approval can predate the
    // visit being reopened, and this is the point after which the client has
    // the number.
    if (!(await hasCompletedVisit(trx, Number(quote.lead_id)))) {
      throw new UnprocessableError(
        'This lead has no completed site visit with a feasibility verdict, so the rate behind this quote has not been checked against the plot.'
      )
    }

    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no', 'contact_name', 'email', 'stage', 'assigned_to'])
      .where('id', '=', Number(quote.lead_id))
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That quote points at a lead that no longer exists.')
    if ((TERMINAL_STAGES as readonly string[]).includes(lead.stage)) {
      throw new ConflictError(
        `This lead is ${lead.stage}. A closed lead is not quoted — a client who comes back is a new lead.`
      )
    }

    const now = nowSqlDateTime()
    await trx
      .updateTable('quotes')
      .set({ status: 'sent', sent_at: now })
      .where('id', '=', quoteId)
      .execute()

    // Rule 2's stage. Only forward: a second quote on a lead already in
    // negotiation must not drag it back to quote_sent.
    const stageMoved = advances(lead.stage, 'quote_sent')
    if (stageMoved) {
      await trx
        .updateTable('leads')
        .set({
          stage: 'quote_sent',
          probability_pct: STAGE_PROBABILITY['quote_sent'] ?? null,
          stage_changed_at: now,
        })
        .where('id', '=', lead.id)
        .execute()
      await trx
        .insertInto('lead_stage_history')
        .values({
          lead_id: lead.id,
          from_stage: lead.stage,
          to_stage: 'quote_sent',
          note: `Quote ${quote.quote_no} rev ${quote.revision} sent.`,
          changed_by: actor.userId,
        })
        .execute()
    }

    await trx
      .insertInto('lead_activities')
      .values({
        lead_id: lead.id,
        activity_type: 'quote_sent',
        summary: `Quote ${quote.quote_no} rev ${quote.revision} sent: ${formatPaise(Number(quote.total_paise))} including GST, valid until ${quote.valid_until}.`.slice(0, 500),
        outcome: 'positive',
        occurred_at: now,
        created_by: actor.userId,
      })
      .execute()

    await rescoreLead(trx, lead.id)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_send',
      entityType: 'quote',
      entityId: quoteId,
      before: { status: 'approved' },
      after: {
        status: 'sent',
        sent_at: now,
        to: lead.email,
        total_paise: Number(quote.total_paise),
      },
      ip: actor.ip,
    })

    return {
      quoteNo: quote.quote_no,
      revision: quote.revision,
      totalPaise: Number(quote.total_paise),
      validUntil: quote.valid_until,
      contactName: lead.contact_name,
      email: lead.email,
      stageMoved,
    }
  })

  if (prepared.email === null) {
    // Not an error. Plenty of clients here give a phone number and no email,
    // and the quote is still sent — by hand, from the printed page.
    return {
      quoteNo: prepared.quoteNo,
      revision: prepared.revision,
      emailed: false,
      emailError: 'The lead has no email address, so the quote was marked sent without one.',
      recipient: null,
      stageMoved: prepared.stageMoved,
    }
  }

  const sender = await db
    .selectFrom('users')
    .select(['full_name', 'email'])
    .where('id', '=', actor.userId)
    .executeTakeFirst()

  const body = quoteEmail({
    contactName: prepared.contactName,
    quoteNo: prepared.quoteNo,
    revision: prepared.revision,
    totalLabel: formatPaise(prepared.totalPaise),
    validUntil: formatDate(prepared.validUntil),
    link: `${env.APP_BASE_URL}/api/crm/quotes/${quoteId}/print`,
    senderName: sender?.full_name ?? 'Neelachandra Construction and Interiors',
  })

  const result = await send(db, {
    to: prepared.email,
    subject: body.subject,
    text: body.text,
    templateKey: 'crm_quote',
    entityType: 'quote',
    entityId: quoteId,
    replyTo: sender?.email,
  })

  return {
    quoteNo: prepared.quoteNo,
    revision: prepared.revision,
    emailed: result.sent,
    emailError: result.error ?? null,
    recipient: prepared.email,
    stageMoved: prepared.stageMoved,
  }
}

/**
 * Records that the client opened the quote.
 *
 * The status exists in the enum, so something has to set it. Nothing does yet:
 * with no public view of the quote there is no open to detect, and inferring
 * viewed from a staff member's own print would make the field a lie. Left as a
 * service function with no route so the one place that could ever set it is
 * written down, rather than the enum value looking like an oversight.
 */
export async function markQuoteViewed(db: Db, quoteId: number): Promise<boolean> {
  const result = await db
    .updateTable('quotes')
    .set({ status: 'viewed' })
    .where('id', '=', quoteId)
    .where('status', '=', 'sent')
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

/**
 * The client accepted (spec 6.7 rule 6's precondition).
 *
 * Accepting does not create the project. Conversion is a separate act behind
 * crm.convert_to_project, because the person who hears "yes" on the phone is not
 * always the person who should be opening a job and a site store.
 */
export async function acceptQuote(
  db: Db,
  actor: Actor,
  quoteId: number,
  note: string | null
): Promise<{ quoteNo: string; revision: number; leadId: number }> {
  return db.transaction().execute(async (trx) => {
    const quote = await loadQuoteForUpdate(trx, quoteId)
    if (quote.status !== 'sent' && quote.status !== 'viewed') {
      throw new ConflictError(
        quote.status === 'accepted'
          ? 'This quote is already accepted.'
          : `This quote is ${quote.status.replace(/_/g, ' ')}. Only one that has gone to the client can be accepted.`
      )
    }

    const leadId = Number(quote.lead_id)
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'stage'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That quote points at a lead that no longer exists.')
    if ((TERMINAL_STAGES as readonly string[]).includes(lead.stage)) {
      throw new ConflictError(`This lead is ${lead.stage}, so this acceptance has nowhere to go.`)
    }

    const now = nowSqlDateTime()
    await trx
      .updateTable('quotes')
      .set({ status: 'accepted', accepted_at: now })
      .where('id', '=', quoteId)
      .execute()

    // verbal_agreement, not won. won is reached by conversion and by nothing
    // else, which is what keeps the funnel's won count equal to the number of
    // projects that exist.
    const target = 'verbal_agreement'
    if (advances(lead.stage, target)) {
      await trx
        .updateTable('leads')
        .set({
          stage: target,
          probability_pct: STAGE_PROBABILITY[target] ?? null,
          stage_changed_at: now,
        })
        .where('id', '=', leadId)
        .execute()
      await trx
        .insertInto('lead_stage_history')
        .values({
          lead_id: leadId,
          from_stage: lead.stage,
          to_stage: target,
          note: `Quote ${quote.quote_no} rev ${quote.revision} accepted.`,
          changed_by: actor.userId,
        })
        .execute()
    }

    await trx
      .insertInto('lead_activities')
      .values({
        lead_id: leadId,
        activity_type: 'note',
        summary: `Quote ${quote.quote_no} rev ${quote.revision} accepted${note ? `: ${note}` : '.'}`.slice(0, 500),
        outcome: 'positive',
        occurred_at: now,
        created_by: actor.userId,
      })
      .execute()

    await rescoreLead(trx, leadId)

    await notifyPermission(trx, PERMISSIONS.CRM_CONVERT_TO_PROJECT, {
      actorId: actor.userId,
      kind: 'quote_accepted',
      title: `Quote ${quote.quote_no} accepted — ready to convert`,
      body: `${formatPaise(Number(quote.total_paise))} including GST. Converting opens the project, its stages and its site store.`,
      linkPath: `/app/crm/leads/${leadId}`,
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_accept',
      entityType: 'quote',
      entityId: quoteId,
      before: { status: quote.status },
      after: { status: 'accepted', accepted_at: now, total_paise: Number(quote.total_paise) },
      ip: actor.ip,
    })

    return { quoteNo: quote.quote_no, revision: quote.revision, leadId }
  })
}

/**
 * The client rejected this quote.
 *
 * Rejecting a quote is not losing the lead — the usual next move is a revision
 * at a different specification. loseLead is the separate act that closes the
 * sale, and it is the one that feeds rule 8's report.
 */
export async function rejectQuote(
  db: Db,
  actor: Actor,
  quoteId: number,
  reason: string
): Promise<{ quoteNo: string; revision: number; leadId: number }> {
  return db.transaction().execute(async (trx) => {
    const quote = await loadQuoteForUpdate(trx, quoteId)
    if (quote.status !== 'sent' && quote.status !== 'viewed') {
      throw new ConflictError(
        `This quote is ${quote.status.replace(/_/g, ' ')}. Only one that has gone to the client can be rejected.`
      )
    }

    const leadId = Number(quote.lead_id)
    await trx
      .updateTable('quotes')
      .set({ status: 'rejected', rejected_reason: reason.slice(0, 300) })
      .where('id', '=', quoteId)
      .execute()

    await trx
      .insertInto('lead_activities')
      .values({
        lead_id: leadId,
        activity_type: 'note',
        summary: `Quote ${quote.quote_no} rev ${quote.revision} rejected: ${reason}`.slice(0, 500),
        outcome: 'negative',
        occurred_at: nowSqlDateTime(),
        created_by: actor.userId,
      })
      .execute()

    await rescoreLead(trx, leadId)

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_reject',
      entityType: 'quote',
      entityId: quoteId,
      before: { status: quote.status },
      after: { status: 'rejected', reason },
      ip: actor.ip,
    })

    return { quoteNo: quote.quote_no, revision: quote.revision, leadId }
  })
}

/**
 * Revises a quote (spec 6.7 rule 5: "any change to price fields forces a new
 * revision rather than an in-place edit, and the old row goes to superseded").
 *
 * The revision keeps the quote number and increments the revision, which is what
 * uq_quote_no_rev (quote_no, revision) permits. The spec's DDL at line 1863 says
 * `quote_no VARCHAR(24) UNIQUE`, and under that key this function is impossible —
 * recorded in DECISIONS.md; the migration's composite key is the one that lets
 * rule 5 exist at all, so it is the one implemented.
 *
 * An accepted quote is not revised. It is the price the client agreed to and the
 * row conversion reads; superseding it would leave the project pointing at a
 * document whose numbers had been replaced. A change after acceptance is a fresh
 * quote and, usually, a fresh conversation.
 */
export async function reviseQuote(
  db: Db,
  actor: Actor,
  quoteId: number,
  input: QuoteInput
): Promise<{ quoteId: number; quoteNo: string; revision: number; totals: QuoteTotals }> {
  return db.transaction().execute(async (trx) => {
    const old = await loadQuoteForUpdate(trx, quoteId)
    if (old.status === 'superseded') {
      throw new ConflictError(
        'This quote has already been superseded. Revise the current revision instead.'
      )
    }
    if (old.status === 'accepted') {
      throw new ConflictError(
        'This quote has been accepted, so it is the agreed price. A change now is a new quote, not a revision of the one the client said yes to.'
      )
    }
    if (Number(old.lead_id) !== input.leadId) {
      throw new UnprocessableError('A revision stays on the same lead as the quote it revises.')
    }

    const revision = old.revision + 1
    await trx
      .updateTable('quotes')
      .set({ status: 'superseded' })
      .where('id', '=', quoteId)
      .execute()

    const built = await insertPricedQuote(trx, actor, input, {
      quoteNo: old.quote_no,
      revision,
      supersedesQuoteId: quoteId,
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.quote_revise',
      entityType: 'quote',
      entityId: built.quoteId,
      before: {
        quote_no: old.quote_no,
        revision: old.revision,
        status: old.status,
        total_paise: Number(old.total_paise),
        discount_pct: Number(old.discount_pct),
      },
      after: {
        quote_no: old.quote_no,
        revision,
        status: 'draft',
        supersedes_quote_id: quoteId,
        total_paise: built.totals.totalPaise,
        discount_pct: input.discountPct,
      },
      ip: actor.ip,
    })

    return { quoteId: built.quoteId, quoteNo: old.quote_no, revision, totals: built.totals }
  })
}

/* Closing a lead --------------------------------------------------------- */

/**
 * Loses a lead, with a reason (spec 6.7 rule 8).
 *
 * The reason is a closed list and the competitor is upserted, because rule 8 at
 * NCC_BUILD_SPEC.md:1938 exists for the pricing picture built from it: a closed
 * enum feeds `competitors.typical_rate_per_sqft_paise`, and the rule's own words
 * for the alternative are that "free-text loss notes produce no analysis". A
 * free-text reason gives ten spellings of "price" and a report nobody trusts.
 *
 * A lost lead is not reopened. A client who comes back six months later is a new
 * lead with its own source, its own first-response clock and its own quote. The
 * alternative — resurrecting the row — rewrites history the loss report has
 * already counted, so last quarter's win rate changes every time an old client
 * calls back.
 */
export async function loseLead(
  db: Db,
  actor: Actor,
  leadId: number,
  input: {
    lostReason: string
    lostToCompetitor: string | null
    lostNotes: string | null
    competitorRatePerSqftPaise: number | null
  }
): Promise<{ leadNo: string; competitorId: number | null }> {
  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no', 'stage', 'expected_value_paise'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')
    if (lead.stage === 'won') {
      throw new ConflictError(
        'This lead was won and converted to a project. Closing the project is a different act, in the projects module.'
      )
    }
    if (lead.stage === 'lost') {
      throw new ConflictError('This lead is already recorded as lost.')
    }

    const competitorId = await upsertCompetitor(
      trx,
      input.lostToCompetitor,
      input.competitorRatePerSqftPaise
    )

    const now = nowSqlDateTime()
    await trx
      .updateTable('leads')
      .set({
        stage: 'lost',
        stage_changed_at: now,
        probability_pct: 0,
        temperature: 'cold',
        lost_reason: input.lostReason as 'price',
        lost_to_competitor: input.lostToCompetitor,
        lost_notes: input.lostNotes,
        next_action: null,
        next_action_date: null,
        updated_by: actor.userId,
      })
      .where('id', '=', leadId)
      .execute()

    await trx
      .insertInto('lead_stage_history')
      .values({
        lead_id: leadId,
        from_stage: lead.stage,
        to_stage: 'lost',
        note: `${input.lostReason.replace(/_/g, ' ')}${input.lostToCompetitor ? ` — to ${input.lostToCompetitor}` : ''}`.slice(0, 300),
        changed_by: actor.userId,
      })
      .execute()

    // Any quote still with the client is dead the moment the lead is. Leaving
    // them at 'sent' would keep them in the sales_exec dashboard's "awaiting
    // client response" tile forever (spec 6.2).
    await trx
      .updateTable('quotes')
      .set({ status: 'rejected', rejected_reason: `Lead lost: ${input.lostReason.replace(/_/g, ' ')}`.slice(0, 300) })
      .where('lead_id', '=', leadId)
      .where('status', 'in', ['draft', 'pending_approval', 'approved', 'sent', 'viewed'])
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_lose',
      entityType: 'lead',
      entityId: leadId,
      before: { stage: lead.stage, expected_value_paise: Number(lead.expected_value_paise ?? 0) },
      after: {
        stage: 'lost',
        lost_reason: input.lostReason,
        lost_to_competitor: input.lostToCompetitor,
        competitor_id: competitorId,
      },
      ip: actor.ip,
    })

    return { leadNo: lead.lead_no, competitorId }
  })
}

/**
 * Finds or creates the competitor a lead was lost to.
 *
 * Matched case-insensitively on name, because the name is typed by hand every
 * time and "ABC Builders" and "abc builders" are one competitor in every sense
 * that matters to rule 8's report. The rate is recorded only when it is higher
 * than nothing known — a volunteered figure is worth keeping, and overwriting a
 * known rate with a blank because this client did not say is a loss of data.
 */
async function upsertCompetitor(
  trx: Trx,
  name: string | null,
  ratePerSqftPaise: number | null
): Promise<number | null> {
  if (name === null) return null
  const trimmed = name.trim()
  if (trimmed.length === 0) return null

  const existing = await trx
    .selectFrom('competitors')
    .select(['id', 'typical_rate_per_sqft_paise'])
    .where(sql<boolean>`LOWER(name) = LOWER(${trimmed})`)
    .executeTakeFirst()

  if (existing) {
    if (ratePerSqftPaise !== null) {
      await trx
        .updateTable('competitors')
        .set({ typical_rate_per_sqft_paise: ratePerSqftPaise })
        .where('id', '=', existing.id)
        .execute()
    }
    return Number(existing.id)
  }

  const inserted = await trx
    .insertInto('competitors')
    .values({
      name: trimmed.slice(0, 160),
      typical_rate_per_sqft_paise: ratePerSqftPaise,
    })
    .executeTakeFirst()
  return Number(inserted.insertId ?? 0) || null
}

/**
 * Overrides the probability on a lead (spec 6.7 rule 2's "editable per lead
 * during negotiation").
 *
 * The reason is mandatory and goes on the timeline. An override with no
 * explanation is a number the forecast depends on that nobody can defend, and
 * the next stage change discards it anyway (see changeStage), so the note is the
 * only durable record of why the forecast moved.
 */
export async function setProbability(
  db: Db,
  actor: Actor,
  leadId: number,
  input: { probabilityPct: number; note: string }
): Promise<{ leadNo: string; previousPct: number | null }> {
  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['id', 'lead_no', 'stage', 'probability_pct'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')
    if ((TERMINAL_STAGES as readonly string[]).includes(lead.stage)) {
      throw new ConflictError(`This lead is ${lead.stage}. A closed lead has no odds left to change.`)
    }

    const previousPct = lead.probability_pct === null ? null : Number(lead.probability_pct)

    await trx
      .updateTable('leads')
      .set({ probability_pct: input.probabilityPct, updated_by: actor.userId })
      .where('id', '=', leadId)
      .execute()

    await trx
      .insertInto('lead_activities')
      .values({
        lead_id: leadId,
        activity_type: 'note',
        summary: `Probability set to ${input.probabilityPct}%${previousPct === null ? '' : ` from ${previousPct}%`}: ${input.note}`.slice(0, 500),
        occurred_at: nowSqlDateTime(),
        created_by: actor.userId,
      })
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.lead_probability',
      entityType: 'lead',
      entityId: leadId,
      before: { probability_pct: previousPct },
      after: { probability_pct: input.probabilityPct, note: input.note },
      ip: actor.ip,
    })

    return { leadNo: lead.lead_no, previousPct }
  })
}

/* Conversion ------------------------------------------------------------- */

/** What conversion created, for the flash message and the redirect. */
export interface ConversionResult {
  projectId: number
  projectCode: string
  clientId: number
  clientCreated: boolean
  stageCount: number
  milestoneCount: number
  contractValuePaise: number
}

/**
 * enquiry_type to project_type. Only the values that name the same thing.
 *
 * consultation_only is absent on purpose: projects.project_type has no member
 * for it, and it is not an omission in the enum — a consultation is advice, not
 * a job with stages, a site store and a retention percentage. Converting one
 * would create a project that never progresses and sits in the mobilising count
 * forever.
 */
const PROJECT_TYPE_FOR_ENQUIRY: Record<string, string | null> = {
  residential_construction: 'residential_construction',
  commercial_construction: 'commercial_construction',
  industrial_construction: 'industrial_construction',
  interior_fitout: 'interior_fitout',
  renovation: 'renovation',
  equipment_rental: 'equipment_rental',
  consultation_only: null,
}

/**
 * Converts a won lead into a project (spec 6.7 rule 6), in one transaction.
 *
 * Everything rule 6 lists happens here or nothing does: the client upsert, the
 * project, its stages from the template, its milestones from the quote's payment
 * schedule, its site store, the lead's converted_project_id and stage, and the
 * audit row. A half-converted lead — a project with no stages, or a lead marked
 * won pointing at nothing — is the state that would need a human to unpick with
 * SQL, so the transaction boundary is the whole design.
 *
 * It deliberately does not call projects/service.ts createProject. That function
 * opens its own db.transaction(), and calling it from inside this one would
 * either nest or, on this pool, deadlock against the locks already held here.
 * The four steps it shares — resolveStageTemplate, instantiateStagesFromTemplate,
 * generateMilestones, ensureSiteStore — were pulled out of it as exported
 * transaction-scoped functions precisely so both callers run the same code
 * against the same transaction. The insert itself is written twice; the logic
 * that has rules in it is not.
 *
 * Refuses without an accepted quote, which is rule 6's own condition. Nothing is
 * retyped: every field on the project comes from the lead or the quote.
 */
export async function convertLeadToProject(
  db: Db,
  actor: Actor,
  leadId: number,
  overrides: { plannedStart: string | null; contractSignedOn: string | null } = {
    plannedStart: null,
    contractSignedOn: null,
  }
): Promise<ConversionResult> {
  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select([
        'id', 'lead_no', 'client_id', 'contact_name', 'phone', 'email',
        'enquiry_type', 'site_city', 'site_locality', 'survey_number',
        'plot_area_sqft', 'floors_wanted', 'jurisdiction', 'stage',
        'converted_project_id', 'assigned_to',
      ])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst()
    if (!lead) throw new NotFoundError('That lead does not exist.')

    if (lead.converted_project_id !== null) {
      throw new ConflictError(
        `This lead has already been converted. Its project is ${await projectCodeOf(trx, Number(lead.converted_project_id))}.`
      )
    }
    if (lead.stage === 'lost') {
      throw new ConflictError('This lead is recorded as lost. A client who came back is a new lead.')
    }

    const projectType = PROJECT_TYPE_FOR_ENQUIRY[lead.enquiry_type] ?? null
    if (projectType === null) {
      throw new UnprocessableError(
        'A consultation is not a project. If this became a build, raise a lead for the build with the work it covers.'
      )
    }

    const quote = await trx
      .selectFrom('quotes')
      .select([
        'id', 'quote_no', 'revision', 'package_id', 'pricing_basis',
        'built_up_area_sqft', 'rate_per_sqft_paise', 'total_paise',
        'subtotal_paise', 'gst_pct', 'payment_schedule_json', 'accepted_at',
      ])
      .where('lead_id', '=', leadId)
      .where('status', '=', 'accepted')
      .orderBy('revision', 'desc')
      .executeTakeFirst()
    if (!quote) {
      throw new UnprocessableError(
        'This lead has no accepted quote. A project is opened against the price the client agreed to, so the quote has to be marked accepted first.'
      )
    }

    if (lead.site_city === null || lead.site_city.trim().length === 0) {
      throw new UnprocessableError(
        'The lead has no site city. A project needs one: it is on the site store, on every delivery challan and on the GST invoice.'
      )
    }

    const { clientId, created: clientCreated } = await upsertClientFromLead(trx, actor, {
      clientId: lead.client_id === null ? null : Number(lead.client_id),
      contactName: lead.contact_name,
      phone: lead.phone,
      email: lead.email,
      city: lead.site_city,
      address: siteAddressOf(lead.site_locality, lead.site_city),
      enquiryType: lead.enquiry_type,
    })

    // The contract value is the quote's total excluding GST. GST is a tax
    // collected on top, held on the project as gst_pct and charged per invoice;
    // booking it into the contract value would inflate every margin figure in
    // 6.8 by 18 percent.
    const contractValuePaise = Number(quote.subtotal_paise)

    const projectCode = await nextNumber(trx, 'project')
    const templateId = await resolveStageTemplate(trx, projectType, null)

    const inserted = await trx
      .insertInto('projects')
      .values({
        code: projectCode,
        name: `${lead.contact_name} — ${lead.site_locality ?? lead.site_city}`.slice(0, 200),
        client_id: clientId,
        project_type: projectType as 'residential_construction',
        delivery_model: DELIVERY_MODEL_FOR_BASIS[
          quote.pricing_basis as keyof typeof DELIVERY_MODEL_FOR_BASIS
        ],
        package_id: quote.package_id,
        stage_template_id: templateId,
        built_up_area_sqft: quote.built_up_area_sqft,
        plot_area_sqft: lead.plot_area_sqft,
        floors_count: lead.floors_wanted,
        site_address: siteAddressOf(lead.site_locality, lead.site_city),
        city: lead.site_city,
        survey_number: lead.survey_number,
        jurisdiction: lead.jurisdiction,
        contract_value_paise: contractValuePaise,
        contract_signed_on: overrides.contractSignedOn,
        rate_per_sqft_paise: quote.rate_per_sqft_paise,
        gst_pct: quote.gst_pct,
        planned_start: overrides.plannedStart,
        status: 'mobilising',
        created_by: actor.userId,
      })
      .executeTakeFirst()

    const projectId = Number(inserted.insertId ?? 0)
    if (!projectId) throw new Error('Project insert returned no id')

    const stageCount = await instantiateStagesFromTemplate(trx, projectId, templateId)

    const schedule = parsePaymentSchedule(quote.payment_schedule_json)
    if (schedule.length === 0) {
      throw new UnprocessableError(
        `Quote ${quote.quote_no} has no payment schedule, so there is nothing to raise invoices against. Revise it with a schedule before converting.`
      )
    }
    await generateMilestones(trx, projectId, contractValuePaise, schedule)

    await ensureSiteStore(
      trx,
      projectId,
      projectCode,
      `${lead.contact_name} — ${lead.site_locality ?? lead.site_city}`,
      lead.site_city,
      siteAddressOf(lead.site_locality, lead.site_city)
    )

    const now = nowSqlDateTime()
    await trx
      .updateTable('leads')
      .set({
        stage: 'won',
        stage_changed_at: now,
        probability_pct: 100,
        temperature: 'hot',
        converted_project_id: projectId,
        client_id: clientId,
        next_action: null,
        next_action_date: null,
        updated_by: actor.userId,
      })
      .where('id', '=', leadId)
      .execute()

    await trx
      .insertInto('lead_stage_history')
      .values({
        lead_id: leadId,
        from_stage: lead.stage,
        to_stage: 'won',
        note: `Converted to project ${projectCode} against quote ${quote.quote_no} rev ${quote.revision}.`,
        changed_by: actor.userId,
      })
      .execute()

    // Every other quote on this lead is now a document for a price that was not
    // agreed. Superseded, not rejected: the client did not turn them down, they
    // were overtaken.
    await trx
      .updateTable('quotes')
      .set({ status: 'superseded' })
      .where('lead_id', '=', leadId)
      .where('id', '!=', quote.id)
      .where('status', 'in', ['draft', 'pending_approval', 'approved', 'sent', 'viewed'])
      .execute()

    await notifyPermission(trx, PERMISSIONS.PROJECTS_VIEW, {
      actorId: actor.userId,
      kind: 'project_from_lead',
      title: `Project ${projectCode} opened from lead ${lead.lead_no}`,
      body: `${lead.contact_name}, ${lead.site_locality ?? lead.site_city}. ${formatPaise(contractValuePaise)} contract value, ${stageCount} stages, ${schedule.length} payment milestones.`,
      linkPath: `/app/projects/${projectId}`,
    })

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'crm.convert_to_project',
      entityType: 'lead',
      entityId: leadId,
      before: { stage: lead.stage, converted_project_id: null },
      after: {
        stage: 'won',
        converted_project_id: projectId,
        project_code: projectCode,
        client_id: clientId,
        client_created: clientCreated,
        quote_id: Number(quote.id),
        quote_no: quote.quote_no,
        revision: quote.revision,
        contract_value_paise: contractValuePaise,
        stage_count: stageCount,
        milestone_count: schedule.length,
      },
      ip: actor.ip,
    })

    return {
      projectId,
      projectCode,
      clientId,
      clientCreated,
      stageCount,
      milestoneCount: schedule.length,
      contractValuePaise,
    }
  })
}

/** The project code behind an id, for the already-converted message. */
async function projectCodeOf(trx: Trx, projectId: number): Promise<string> {
  const row = await trx
    .selectFrom('projects')
    .select('code')
    .where('id', '=', projectId)
    .executeTakeFirst()
  return row?.code ?? `#${projectId}`
}

/**
 * The site address, from the two fields a lead actually has.
 *
 * leads has site_locality and site_city and no street line, while
 * projects.site_address is NOT NULL. This is the honest composition of what was
 * captured rather than a placeholder: the address is corrected on the project
 * once the survey and the sanction plan are in hand, and it is better for it to
 * read "Nelamangala, Bengaluru" than "TBC".
 */
function siteAddressOf(locality: string | null, city: string): string {
  const parts = [locality, city].filter((p): p is string => p !== null && p.trim().length > 0)
  return parts.join(', ')
}

/**
 * Reads the payment schedule off the quote.
 *
 * The column arrives already parsed — see src/lib/json.ts for why, and for the
 * reason there is exactly one JSON.parse in src/. This function is the shape
 * check on top of it: anything that is not an array of milestones with a name
 * and a positive percentage yields an empty schedule, and the caller refuses,
 * rather than a project with milestones invented from a malformed row.
 */
function parsePaymentSchedule(raw: unknown): MilestoneInput[] {
  const parsed = parseJsonColumnArray(raw)
  const out: MilestoneInput[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const percent = typeof row.percent === 'number' ? row.percent : Number(row.percent)
    if (name.length === 0 || !Number.isFinite(percent) || percent <= 0) continue
    const seq = row.triggerStageSeq
    out.push({
      name,
      percent,
      triggerStageSeq: typeof seq === 'number' && Number.isFinite(seq) ? seq : null,
    })
  }
  return out
}

/**
 * Finds or creates the client for a converting lead (spec 6.7 rule 6: "matching
 * on phone then GSTIN to avoid a duplicate client for a repeat customer").
 *
 * The phone half is implemented. The GSTIN half cannot be: leads has no gstin
 * column, so there is no GSTIN on this side of the match to compare. Flagged in
 * DECISIONS.md rather than worked around by adding a column the spec's own DDL
 * does not have. leads.client_id is checked first, which covers the repeat
 * customer better than either — it is set the moment someone recognises the
 * caller.
 *
 * client_type is derived from the enquiry type, not asked for. A commercial or
 * industrial build is a company until someone says otherwise, and everything
 * else defaults to individual, which is what the overwhelming majority of these
 * are. It is editable on the client record afterwards.
 */
async function upsertClientFromLead(
  trx: Trx,
  actor: Actor,
  lead: {
    clientId: number | null
    contactName: string
    phone: string
    email: string | null
    city: string
    address: string
    enquiryType: string
  }
): Promise<{ clientId: number; created: boolean }> {
  if (lead.clientId !== null) {
    const existing = await trx
      .selectFrom('clients')
      .select('id')
      .where('id', '=', lead.clientId)
      .executeTakeFirst()
    if (existing) return { clientId: Number(existing.id), created: false }
  }

  const byPhone = await trx
    .selectFrom('clients')
    .select(['id', 'status'])
    .where('primary_contact_phone', '=', lead.phone)
    .executeTakeFirst()
  if (byPhone) {
    if (byPhone.status === 'blacklisted') {
      throw new ConflictError(
        'This phone number belongs to a blacklisted client. Clear the client record before opening a project for them.'
      )
    }
    return { clientId: Number(byPhone.id), created: false }
  }

  const isCompany =
    lead.enquiryType === 'commercial_construction' || lead.enquiryType === 'industrial_construction'

  // The code is assigned after the insert, because it is derived from the id.
  // Same two-step as the rest of the tree's master records: a unique temporary
  // value first so uq_clients_code is never violated by a race, then the real
  // one.
  const inserted = await trx
    .insertInto('clients')
    .values({
      code: `TMP-${randomUUID().slice(0, 12)}`,
      name: lead.contactName,
      client_type: isCompany ? 'company' : 'individual',
      billing_address: lead.address,
      city: lead.city,
      primary_contact_name: lead.contactName,
      primary_contact_phone: lead.phone,
      primary_contact_email: lead.email,
      status: 'active',
      created_by: actor.userId,
    })
    .executeTakeFirst()

  const clientId = Number(inserted.insertId ?? 0)
  if (!clientId) throw new Error('Client insert returned no id')

  await trx
    .updateTable('clients')
    .set({ code: sequenceCode('CL', clientId) })
    .where('id', '=', clientId)
    .execute()

  return { clientId, created: true }
}

/* The follow-ups cron ---------------------------------------------------- */

/** What one run of the follow-ups cron did. Counts, so a cron log is readable. */
export interface FollowupRunResult {
  ranOn: string
  dormancyDays: number
  wentDormant: number
  quotesExpired: number
  quotesNearExpiry: number
  overdueActions: number
  unassignedEnquiries: number
  unassignedLeads: number
  notified: number
}

/**
 * The daily CRM cron (spec 6.7 routes: POST /internal/cron/crm-followups —
 * "Overdue next_action_date, unassigned enquiries, quotes near expiry", plus
 * rule 9's dormancy sweep).
 *
 * Idempotent, like every other job on this endpoint: each step is a conditional
 * UPDATE or a read, so a cron that fires twice or retries after a timeout moves
 * nothing a second time. The notifications are the exception in principle — two
 * runs would write two rows — which is why they are one digest per recipient
 * rather than one per lead, and why the digest is only written when there is
 * something in it.
 *
 * Rule 9's condition is exact: no lead_activities row for the dormancy window
 * *and* no next_action_date. A lead with a date set is not neglected, it is
 * waiting, and moving it to dormant would delete the one field saying so. The
 * window comes from settings because temperatureFor reads the same number.
 */
export async function runCrmFollowups(db: Db): Promise<FollowupRunResult> {
  const on = today()
  const dormancyDays = Number(await getSetting(db, 'crm.dormancy_days', 45))
  const warningDays = Number(await getSetting(db, 'crm.quote_expiry_warning_days', 5))
  const cutoff = addDays(on, -dormancyDays)

  const OPEN_STAGES = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'estimate_shared', 'quote_sent', 'negotiation', 'verbal_agreement'] as const

  // Rule 9. The last-touch date is MAX(occurred_at) falling back to the lead's
  // own created_at, so a lead nobody has ever logged an activity against ages
  // from the day it arrived rather than reading as touched today.
  //
  // leads.created_at is in the select list and the GROUP BY because it has to
  // be: MariaDB resolves HAVING against the grouped and selected columns only,
  // and rejects a bare column there with "Unknown column in 'HAVING'" even
  // though it is functionally dependent on leads.id. Grouping by a column of
  // the PK's own row changes no grouping.
  const stale = await db
    .selectFrom('leads')
    .leftJoin('lead_activities', 'lead_activities.lead_id', 'leads.id')
    .select(['leads.id', 'leads.lead_no', 'leads.stage', 'leads.contact_name', 'leads.assigned_to', 'leads.created_at'])
    .where('leads.stage', 'in', OPEN_STAGES)
    .where('leads.next_action_date', 'is', null)
    .groupBy(['leads.id', 'leads.lead_no', 'leads.stage', 'leads.contact_name', 'leads.assigned_to', 'leads.created_at'])
    .having(sql<boolean>`COALESCE(MAX(lead_activities.occurred_at), leads.created_at) < ${cutoff}`)
    .execute()

  if (stale.length > 0) {
    await db
      .updateTable('leads')
      .set({ stage: 'dormant', stage_changed_at: nowSqlDateTime(), temperature: 'cold', probability_pct: 0 })
      .where(
        'id',
        'in',
        stale.map((l) => Number(l.id))
      )
      .execute()

    // No lead_stage_history row for this move, and that is a conflict rather
    // than an omission: lead_stage_history.changed_by is NOT NULL with an FK to
    // users, and rule 9's mover is a cron with no user. The alternatives were a
    // synthetic system user row (a data decision open question 8.1 has not
    // settled) or making the column nullable (editing the spec's own DDL). So
    // the transition is recorded in audit_log, which takes a null user_id by
    // design, and the lead's own stage_changed_at still carries the date the
    // next days_in_previous_stage is measured from. Recorded in DECISIONS.md.
    for (const lead of stale) {
      await writeAudit(db, {
        userId: null,
        action: 'crm.lead_dormant_auto',
        entityType: 'lead',
        entityId: Number(lead.id),
        before: { stage: lead.stage },
        after: { stage: 'dormant', reason: `No activity for ${dormancyDays} days and no next action set.` },
        ip: null,
      })
    }
  }

  // A quote past its validity is not a quote. Expiring it stops it appearing in
  // the "awaiting client response" tile and stops it being sent.
  const expired = await db
    .updateTable('quotes')
    .set({ status: 'expired' })
    .where('status', 'in', ['approved', 'sent', 'viewed'])
    .where('valid_until', '<', on)
    .executeTakeFirst()
  const quotesExpired = Number(expired.numUpdatedRows)

  const nearExpiry = await db
    .selectFrom('quotes')
    .innerJoin('leads', 'leads.id', 'quotes.lead_id')
    .select([
      'quotes.id', 'quotes.quote_no', 'quotes.revision', 'quotes.valid_until',
      'quotes.total_paise', 'quotes.created_by', 'leads.contact_name', 'leads.assigned_to',
    ])
    .where('quotes.status', 'in', ['sent', 'viewed'])
    .where('quotes.valid_until', '>=', on)
    .where('quotes.valid_until', '<=', addDays(on, warningDays))
    .orderBy('quotes.valid_until')
    .execute()

  const overdue = await db
    .selectFrom('leads')
    .select(['id', 'lead_no', 'contact_name', 'next_action', 'next_action_date', 'assigned_to'])
    .where('stage', 'in', OPEN_STAGES)
    .where('next_action_date', '<', on)
    .orderBy('next_action_date')
    .execute()

  const unassignedEnquiries = await db
    .selectFrom('enquiries')
    .select(({ fn }) => [fn.countAll<number>().as('n')])
    .where('status', 'in', ['new', 'contacted'])
    .executeTakeFirst()

  const unassignedLeads = await db
    .selectFrom('leads')
    .select(({ fn }) => [fn.countAll<number>().as('n')])
    .where('stage', 'in', OPEN_STAGES)
    .where('assigned_to', 'is', null)
    .executeTakeFirst()

  const enquiryCount = Number(unassignedEnquiries?.n ?? 0)
  const leadPoolCount = Number(unassignedLeads?.n ?? 0)

  let notified = 0
  notified += await notifyPerAssignee(db, overdue, nearExpiry)

  if (enquiryCount > 0 || leadPoolCount > 0) {
    const assigners = await usersWithPermission(db, PERMISSIONS.CRM_LEAD_ASSIGN)
    const parts: string[] = []
    if (enquiryCount > 0) parts.push(`${enquiryCount} website ${enquiryCount === 1 ? 'enquiry has' : 'enquiries have'} not been promoted to a lead`)
    if (leadPoolCount > 0) parts.push(`${leadPoolCount} ${leadPoolCount === 1 ? 'lead is' : 'leads are'} in the unassigned pool`)
    await notify(db, {
      userIds: assigners,
      kind: 'crm_unassigned',
      title: 'Enquiries and leads waiting for an owner',
      body: `${parts.join(', and ')}. Nobody is working a lead that has not been given to anyone.`,
      linkPath: '/app/crm/leads?assigned=unassigned',
      severity: enquiryCount > 0 ? 'warn' : 'info',
    })
    notified += assigners.length
  }

  return {
    ranOn: on,
    dormancyDays,
    wentDormant: stale.length,
    quotesExpired,
    quotesNearExpiry: nearExpiry.length,
    overdueActions: overdue.length,
    unassignedEnquiries: enquiryCount,
    unassignedLeads: leadPoolCount,
    notified,
  }
}

/**
 * One digest per person, not one notification per lead.
 *
 * A sales exec with eleven overdue follow-ups gets one row saying eleven, which
 * is read. Eleven rows are a bell that gets muted, and a muted bell is the same
 * as no cron. Rows with no assignee are skipped here and covered by the
 * unassigned digest, which goes to whoever can actually hand them out.
 */
async function notifyPerAssignee(
  db: Db,
  overdue: ReadonlyArray<{ id: number; lead_no: string; contact_name: string; next_action: string | null; next_action_date: string | null; assigned_to: number | null }>,
  nearExpiry: ReadonlyArray<{ quote_no: string; revision: number; valid_until: string; total_paise: number; created_by: number; contact_name: string; assigned_to: number | null }>
): Promise<number> {
  const byUser = new Map<number, { overdue: string[]; quotes: string[] }>()
  const bucket = (userId: number) => {
    const found = byUser.get(userId)
    if (found) return found
    const fresh = { overdue: [] as string[], quotes: [] as string[] }
    byUser.set(userId, fresh)
    return fresh
  }

  for (const lead of overdue) {
    if (lead.assigned_to === null) continue
    bucket(Number(lead.assigned_to)).overdue.push(
      `${lead.lead_no} ${lead.contact_name} — ${lead.next_action ?? 'follow up'} (due ${lead.next_action_date ?? 'unknown'})`
    )
  }

  for (const quote of nearExpiry) {
    // The quote's author is told even when the lead has moved to someone else:
    // they are the one who set the validity date and know what it was for.
    const owner = quote.assigned_to === null ? Number(quote.created_by) : Number(quote.assigned_to)
    bucket(owner).quotes.push(
      `${quote.quote_no} rev ${quote.revision} for ${quote.contact_name}, ${formatPaise(Number(quote.total_paise))}, expires ${quote.valid_until}`
    )
  }

  let sent = 0
  for (const [userId, work] of byUser) {
    const lines: string[] = []
    if (work.overdue.length > 0) {
      lines.push(`${work.overdue.length} follow-up${work.overdue.length === 1 ? '' : 's'} overdue:`)
      lines.push(...work.overdue.slice(0, 12))
      if (work.overdue.length > 12) lines.push(`…and ${work.overdue.length - 12} more.`)
    }
    if (work.quotes.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push(`${work.quotes.length} quote${work.quotes.length === 1 ? '' : 's'} expiring:`)
      lines.push(...work.quotes.slice(0, 12))
      if (work.quotes.length > 12) lines.push(`…and ${work.quotes.length - 12} more.`)
    }
    if (lines.length === 0) continue

    await notify(db, {
      userIds: [userId],
      kind: 'crm_followups',
      title:
        work.overdue.length > 0 && work.quotes.length > 0
          ? `${work.overdue.length} follow-ups overdue and ${work.quotes.length} quotes expiring`
          : work.overdue.length > 0
            ? `${work.overdue.length} follow-up${work.overdue.length === 1 ? '' : 's'} overdue`
            : `${work.quotes.length} quote${work.quotes.length === 1 ? '' : 's'} expiring`,
      body: lines.join('\n'),
      linkPath: '/app/crm/leads?due=overdue',
      severity: 'warn',
    })
    sent += 1
  }
  return sent
}
