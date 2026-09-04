import { z } from 'zod'
import { DELIVERY_MODELS, PROJECT_TYPES } from '../projects/schemas.js'

/**
 * CRM form contracts (spec 2.6: Zod at every route boundary).
 *
 * The scalar and list helpers below are copied from
 * src/modules/inventory/schemas.ts, which copied them from
 * src/modules/projects/schemas.ts. That is deliberate and is stated in both
 * files: projects is the pattern the other modules replicate, and hoisting the
 * helpers into a shared module would be a redesign of that pattern rather than
 * a replication of it.
 *
 * Two things here are specific to CRM. The lead qualifiers are three-valued —
 * "has a sanctioned plan", "does not", and "nobody has asked yet" are three
 * different sales positions and the columns are TINYINT(1) NULL to hold all
 * three — so those flags use yesNoNull rather than the boolean yesNo. And the
 * quote grid carries two independent line lists (priced lines and the
 * exclusions) plus the payment schedule, because a quote is the one document
 * in the tree whose text matters as much as its arithmetic.
 */

/** An empty text input arrives as '', which is not the same as absent. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))

/** A date input arrives as '' when untouched. */
export const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' || v === undefined ? null : v))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Enter a date as YYYY-MM-DD.')

export const requiredDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.')

/**
 * datetime-local posts YYYY-MM-DDTHH:MM. MariaDB DATETIME takes a space, and
 * the pool runs with dateStrings, so the swap happens here rather than in the
 * service: this is the only boundary that knows what the browser sent.
 */
export const requiredDateTime = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/, 'Enter a date and time.')
  .transform((v) => (v.length === 16 ? `${v.replace('T', ' ')}:00` : v.replace('T', ' ')))

const optionalDecimal = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (v === '' || v === undefined) return null
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  })

/** Areas are DECIMAL(12,2); rounding here keeps float dust out of SQL. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Quantities are DECIMAL(14,3). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

const optionalArea = optionalDecimal.transform((v) => (v === null ? null : round2(v)))

/**
 * Rupees in the form, paise in the column.
 *
 * The conversion happens here so there is exactly one boundary where a float
 * becomes an integer, and nothing downstream ever holds a rupee float
 * (spec 2.4).
 */
export const rupeesToPaiseField = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (v === '' || v === undefined) return null
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? Math.round(n * 100) : null
  })

/** An optional foreign key from a <select>: '' means none. */
const optionalId = z
  .string()
  .optional()
  .transform((v) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isInteger(n) && n > 0 ? n : null
  })

const requiredId = (message: string) => z.coerce.number().int().positive(message)

/**
 * An optional enum from a <select> whose first option is blank.
 *
 * z.enum().optional() does not cover this: a blank option posts '', which is a
 * present value and not a member, so the field fails validation instead of
 * reading as "not answered". Checking membership after the blank is folded to
 * null keeps a hand-posted junk value an error rather than a 500 from MariaDB.
 */
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))
    .refine(
      (v) => v === null || (values as readonly string[]).includes(v),
      'That choice is not one of the options.'
    )
    .transform((v) => v as T[number] | null)

/**
 * One column of a line grid. Files are coerced to '' rather than rejected:
 * a stray file input in a grid is a template bug, not something a user can
 * fix from an error banner.
 */
const rawList = z.unknown().transform((raw): string[] => {
  if (raw === undefined || raw === null) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  return arr.map((v) => (typeof v === 'string' ? v.trim() : ''))
})

function idAt(col: string[], i: number): number | null {
  const n = Number.parseInt(col[i] ?? '', 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

function qtyAt(col: string[], i: number): number | null {
  const raw = (col[i] ?? '').replace(/,/g, '')
  if (raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? round3(n) : null
}

function paiseAt(col: string[], i: number): number | null {
  const raw = (col[i] ?? '').replace(/,/g, '')
  if (raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function pctAt(col: string[], i: number, fallback: number): number {
  const raw = (col[i] ?? '').trim()
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback
}

function textAt(col: string[], i: number, max: number): string | null {
  const v = (col[i] ?? '').slice(0, max)
  return v === '' ? null : v
}

function badLine(ctx: z.RefinementCtx, i: number, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Line ${i + 1}: ${message}` })
}

/**
 * FormField renders a select, a textarea or an <input type>, and has no
 * checkbox case. Flags are therefore Yes/No selects, which also removes the
 * unchecked-box-is-absent ambiguity: the field is always submitted.
 */
const yesNo = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === '1' || v === 'true' || v === 'on'))

/**
 * The three-valued form of the same thing, for the TINYINT(1) NULL qualifiers.
 *
 * A lead whose plan status nobody has asked about yet is not a lead without a
 * plan: the first scores zero on that signal because the answer is unknown, the
 * second scores zero because the answer is no, and only the second is a reason
 * to stop chasing it. Collapsing the two would quietly disqualify every lead
 * taken down in a hurry.
 */
const yesNoNull = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v === '') return null
    return v === '1' || v === 'true' || v === 'on' ? 1 : 0
  })

/*
 * The enum members below are transcribed from migrations/008_crm.sql. They are
 * repeated here rather than derived from src/db/types.ts because a <select> has
 * to enumerate them anyway, and a route that accepts a value the column will
 * reject is a 500 where a validation message belongs.
 */

export const ENQUIRY_TYPES = [
  'residential_construction',
  'commercial_construction',
  'industrial_construction',
  'interior_fitout',
  'renovation',
  'equipment_rental',
  'consultation_only',
] as const

export const JURISDICTIONS = ['BBMP', 'BMRDA', 'BDA', 'Gram Panchayat', 'TUDA', 'KIADB', 'Other'] as const

export const PLOT_OWNERSHIPS = [
  'owned_clear_title',
  'owned_under_verification',
  'agreement_stage',
  'joint_development',
  'not_yet_purchased',
] as const

export const FUNDING_MODES = ['self', 'home_loan', 'loan_sanctioned', 'loan_applied', 'company_capex'] as const

export const EXPECTED_STARTS = [
  'immediate',
  'within_1_month',
  '1_to_3_months',
  '3_to_6_months',
  'beyond_6_months',
  'exploring',
] as const

export const LEAD_STAGES = [
  'new',
  'contacted',
  'qualified',
  'site_visit_scheduled',
  'site_visit_done',
  'estimate_shared',
  'quote_sent',
  'negotiation',
  'verbal_agreement',
  'won',
  'lost',
  'dormant',
  'disqualified',
] as const

export type LeadStage = (typeof LEAD_STAGES)[number]

/**
 * The stages a user may post directly.
 *
 * 'won' is excluded because winning a lead is what conversion does, and setting
 * the stage by hand would leave converted_project_id null — a won lead with no
 * project is the one state the pipeline board cannot explain. 'lost' is
 * excluded because it needs a reason (rule 8), which has its own route and its
 * own form.
 */
export const POSTABLE_STAGES = LEAD_STAGES.filter((s) => s !== 'won' && s !== 'lost')

export const ACTIVITY_TYPES = [
  'call_out',
  'call_in',
  'whatsapp',
  'email',
  'meeting',
  'site_visit',
  'quote_sent',
  'follow_up',
  'note',
  'status_change',
] as const

export const ACTIVITY_OUTCOMES = [
  'connected',
  'no_answer',
  'busy',
  'wrong_number',
  'call_back_later',
  'not_interested',
  'positive',
  'negative',
  'neutral',
] as const

export const VISIT_STATUSES = ['scheduled', 'completed', 'client_no_show', 'rescheduled', 'cancelled'] as const

export const ROAD_ACCESS = ['good', 'narrow', 'no_access'] as const

export const WATER_AVAILABILITY = ['borewell', 'corporation', 'tanker', 'none'] as const

export const FEASIBILITIES = ['feasible', 'feasible_with_conditions', 'not_feasible'] as const

export const LOST_REASONS = [
  'price',
  'timeline',
  'competitor',
  'plot_issue',
  'loan_rejected',
  'postponed',
  'no_response',
  'out_of_scope',
  'duplicate',
  'other',
] as const

export const PRICING_BASES = ['per_sqft', 'item_rate', 'lumpsum'] as const

export const QUOTE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'viewed',
  'accepted',
  'rejected',
  'expired',
  'superseded',
] as const

/**
 * A lead.
 *
 * Only the contact name, the phone and the enquiry type are required, because a
 * lead is often typed while the caller is still on the line. Everything the
 * score reads (rule 1) is optional and unknown until someone asks — which is
 * the point of the score: it says how much is known, not how good the lead is.
 */
export const leadSchema = z.object({
  contactName: z.string().trim().min(3, 'Give the contact a name.').max(140),
  phone: z.string().trim().min(6, 'Give a contact number.').max(20),
  altPhone: optionalText(20),
  email: z
    .string()
    .trim()
    .max(190)
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))
    .refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'That email address is not valid.'),
  clientId: optionalId,
  leadSourceId: optionalId,
  campaignId: optionalId,
  referredByClientId: optionalId,
  enquiryType: z.enum(ENQUIRY_TYPES).default('residential_construction'),
  siteCity: optionalText(80),
  siteLocality: optionalText(120),
  surveyNumber: optionalText(60),
  plotAreaSqft: optionalArea,
  plotDimensions: optionalText(40),
  targetBuiltUpSqft: optionalArea,
  floorsWanted: optionalId,
  jurisdiction: optionalEnum(JURISDICTIONS),
  plotOwnership: optionalEnum(PLOT_OWNERSHIPS),
  hasSanctionedPlan: yesNoNull,
  hasArchitect: yesNoNull,
  architectName: optionalText(140),
  budgetMinPaise: rupeesToPaiseField,
  budgetMaxPaise: rupeesToPaiseField,
  preferredPackageId: optionalId,
  fundingMode: optionalEnum(FUNDING_MODES),
  expectedStart: optionalEnum(EXPECTED_STARTS),
  nextAction: optionalText(200),
  nextActionDate: optionalDate,
})
  .refine(
    (v) => v.budgetMinPaise === null || v.budgetMaxPaise === null || v.budgetMaxPaise >= v.budgetMinPaise,
    'The budget ceiling is below the floor.'
  )

export type LeadInput = z.infer<typeof leadSchema>

/**
 * Creating a lead from an enquiry (spec 6.7).
 *
 * The enquiry supplies the contact details, so the form only asks for the
 * qualifiers a phone call adds. Everything else is copied from the enquiry row
 * inside the transaction, where it cannot be tampered with in the post body.
 */
export const leadFromEnquirySchema = z.object({
  enquiryId: requiredId('Choose an enquiry.'),
  assignedTo: optionalId,
})

export const stageSchema = z.object({
  stage: z.enum(LEAD_STAGES),
  note: optionalText(300),
})

/** '' unassigns, which returns the lead to the pool rather than erroring. */
export const assignSchema = z.object({
  assignedTo: optionalId,
  note: optionalText(300),
})

export const activitySchema = z.object({
  activityType: z.enum(ACTIVITY_TYPES),
  occurredAt: requiredDateTime,
  durationMinutes: optionalId,
  outcome: optionalEnum(ACTIVITY_OUTCOMES),
  summary: z.string().trim().min(3, 'Say what happened.').max(500),
  nextAction: optionalText(200),
  nextActionDate: optionalDate,
})

export const visitScheduleSchema = z.object({
  leadId: requiredId('Choose a lead.'),
  scheduledAt: requiredDateTime,
  visitedBy: optionalId,
})

/**
 * The completed site visit.
 *
 * These are the fields that decide whether the plot can be built on at the
 * quoted rate, which is why rule 3 will not let a quote go out without one.
 * feasibility is required on completion: a visit that recorded no verdict is
 * the same as no visit for the purposes of that gate.
 */
export const visitCompleteSchema = z.object({
  visitedAt: requiredDateTime,
  visitedBy: optionalId,
  soilType: optionalText(80),
  roadAccess: optionalEnum(ROAD_ACCESS),
  waterAvailability: optionalEnum(WATER_AVAILABILITY),
  powerAvailability: yesNoNull,
  neighbouringStructures: optionalText(2000),
  levelDifferenceFt: optionalDecimal,
  demolitionRequired: yesNoNull,
  treeCuttingPermissionNeeded: yesNoNull,
  accessConstraints: optionalText(2000),
  feasibility: z.enum(FEASIBILITIES),
  conditionsNotes: optionalText(2000),
  estimatedExtraCostPaise: rupeesToPaiseField,
})

export const visitStatusSchema = z.object({
  status: z.enum(VISIT_STATUSES),
  scheduledAt: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v.length === 16 ? `${v.replace('T', ' ')}:00` : v.replace('T', ' '))),
})

/** The line types a user may enter. The rest are generated by the service. */
export const QUOTE_LINE_TYPES = ['addon', 'extra_work'] as const

export interface QuoteLineInput {
  lineType: (typeof QUOTE_LINE_TYPES)[number]
  description: string
  qty: number | null
  unitId: number | null
  ratePaise: number | null
  amountPaise: number
  costHeadId: number | null
}

export interface MilestoneInput {
  name: string
  percent: number
  triggerStageSeq: number | null
}

/**
 * A quote (spec 6.7 rule 4).
 *
 * The base amount, the discount, GST and the total are absent from this schema
 * on purpose: they are computed in the service from the package rate and the
 * lines below, so a hand-posted total is not a number the system can be made to
 * believe. What arrives here is the area, the rate override, the discount
 * percentage and the lines — the inputs to the arithmetic, never its result.
 *
 * The payment schedule is required and must sum to 100, which is stricter than
 * the column (payment_schedule_json is NULL-able). The reason is rule 6:
 * conversion generates the project's milestones from this JSON through
 * generateMilestones(), which throws unless the weightages sum to exactly 100.
 * The only person who can fix a bad schedule is the sales executive writing the
 * quote, so this is the last boundary where the error is actionable.
 */
export const quoteSchema = z
  .object({
    leadId: requiredId('Choose a lead.'),
    packageId: optionalId,
    quoteDate: requiredDate,
    validUntil: requiredDate,
    pricingBasis: z.enum(PRICING_BASES).default('per_sqft'),
    builtUpAreaSqft: optionalArea,
    ratePerSqft: rupeesToPaiseField,
    discountPct: z.coerce.number().min(0).max(100, 'A discount over 100% is not a discount.').default(0),
    gstPct: z.coerce.number().min(0).max(28, 'GST is 28% at most.').default(18),
    exclusions: z
      .string()
      .trim()
      .min(10, 'List what the quote excludes. One per line.')
      .max(4000),
    lineType: rawList,
    lineDescription: rawList,
    lineQty: rawList,
    lineUnitId: rawList,
    lineRate: rawList,
    lineCostHeadId: rawList,
    scheduleName: rawList,
    schedulePercent: rawList,
    scheduleStageSeq: rawList,
  })
  .transform((v, ctx) => {
    const lines: QuoteLineInput[] = []
    for (let i = 0; i < v.lineDescription.length; i += 1) {
      const description = textAt(v.lineDescription, i, 300)
      if (description === null) continue
      const kind = (v.lineType[i] ?? 'addon') as (typeof QUOTE_LINE_TYPES)[number]
      if (!(QUOTE_LINE_TYPES as readonly string[]).includes(kind)) {
        badLine(ctx, i, 'that line type is not one of the options.')
        continue
      }
      const qty = qtyAt(v.lineQty, i)
      const ratePaise = paiseAt(v.lineRate, i)
      if (ratePaise === null) {
        badLine(ctx, i, 'enter an amount for the line.')
        continue
      }
      // A line with no quantity is a lump sum, so the rate cell is the amount.
      const amountPaise = qty === null ? ratePaise : Math.round(qty * ratePaise)
      lines.push({
        lineType: kind,
        description,
        qty,
        unitId: idAt(v.lineUnitId, i),
        ratePaise,
        amountPaise,
        costHeadId: idAt(v.lineCostHeadId, i),
      })
    }

    const schedule: MilestoneInput[] = []
    for (let i = 0; i < v.scheduleName.length; i += 1) {
      const name = textAt(v.scheduleName, i, 120)
      if (name === null) continue
      const percent = pctAt(v.schedulePercent, i, -1)
      if (percent <= 0) {
        badLine(ctx, i, 'a milestone needs a percentage above zero.')
        continue
      }
      schedule.push({ name, percent, triggerStageSeq: idAt(v.scheduleStageSeq, i) })
    }
    if (v.validUntil <= v.quoteDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The validity date must be after the quote date.' })
    }
    if (v.pricingBasis === 'per_sqft' && (v.builtUpAreaSqft === null || v.builtUpAreaSqft <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A per-square-foot quote needs a built-up area.' })
    }
    if (v.pricingBasis !== 'per_sqft' && lines.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An item-rate or lumpsum quote needs at least one line.' })
    }
    if (schedule.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give the payment schedule at least one milestone.' })
    } else {
      const sum = Math.round(schedule.reduce((acc, m) => acc + m.percent, 0) * 100) / 100
      if (sum !== 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `The payment schedule sums to ${sum}%, not 100%.`,
        })
      }
    }

    return {
      leadId: v.leadId,
      packageId: v.packageId,
      quoteDate: v.quoteDate,
      validUntil: v.validUntil,
      pricingBasis: v.pricingBasis,
      builtUpAreaSqft: v.builtUpAreaSqft,
      ratePerSqftPaise: v.ratePerSqft,
      discountPct: v.discountPct,
      gstPct: v.gstPct,
      exclusions: v.exclusions,
      // The TEXT column keeps the text as typed; the exclusion_note lines below
      // are what the printed quote enumerates.
      exclusionList: v.exclusions
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/^[-*•]\s*/, ''))
        .filter((s) => s.length > 0)
        .slice(0, 60),
      lines,
      schedule,
    }
  })

export type QuoteInput = z.infer<typeof quoteSchema>

export const noteSchema = z.object({
  note: optionalText(300),
})

export const reasonSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason.').max(300),
})

/**
 * Losing a lead (spec 6.7 rule 8).
 *
 * The reason is a closed list because the whole point of rule 8 is the report
 * built from it, and a free-text reason produces ten spellings of "price". The
 * competitor's rate is optional and in rupees per square foot: it is the one
 * number that populates competitors.typical_rate_per_sqft_paise, and it is only
 * ever known when the client volunteers it.
 */
export const loseSchema = z.object({
  lostReason: z.enum(LOST_REASONS),
  lostToCompetitor: optionalText(140),
  lostNotes: optionalText(500),
  competitorRatePerSqft: rupeesToPaiseField,
})

/** The negotiation override. probability_pct is TINYINT UNSIGNED. */
export const probabilitySchema = z.object({
  probabilityPct: z.coerce.number().int().min(0).max(100, 'A probability over 100% is not a probability.'),
  note: z.string().trim().min(5, 'Say why the odds changed.').max(300),
})

/**
 * The quote's pricing basis is the project's delivery model.
 *
 * Converting a per-square-foot quote into a cost-plus project would silently
 * change what the client agreed to, so this is a lookup rather than a field on
 * the conversion form.
 */
export const DELIVERY_MODEL_FOR_BASIS: Record<
  (typeof PRICING_BASES)[number],
  (typeof DELIVERY_MODELS)[number]
> = {
  per_sqft: 'package_per_sqft',
  item_rate: 'item_rate',
  lumpsum: 'lumpsum',
}

/**
 * Conversion (spec 6.7 rule 6).
 *
 * PROJECT_TYPES and DELIVERY_MODELS are imported from the projects module rather
 * than restated. That is a dependency in the direction section 5 sets — projects
 * is the hub and CRM is downstream of it — and the lists have to agree exactly,
 * because the row this form creates is a projects row. The helper functions are
 * still copied, per the note at the top of this file: the difference is that a
 * helper is a local idiom and an enum is a shared fact.
 *
 * Only the fields the lead and the quote cannot supply are asked for. The
 * contract value, the rate, the built-up area and the delivery model all come
 * from the accepted quote inside the transaction, so the number the client
 * signed is the number the project carries.
 */
export const convertSchema = z.object({
  quoteId: requiredId('Choose the accepted quote.'),
  name: z.string().trim().min(3, 'Give the project a name.').max(200),
  projectType: z.enum(PROJECT_TYPES),
  siteAddress: z.string().trim().min(5, 'Enter the site address.').max(1000),
  city: z.string().trim().min(2, 'Enter the city.').max(80),
  jurisdiction: optionalEnum(JURISDICTIONS),
  scopeOfWork: optionalText(2000),
  plannedStart: optionalDate,
  plannedEnd: optionalDate,
  contractSignedOn: optionalDate,
  stageTemplateId: optionalId,
})

/**
 * What the conversion route actually posts.
 *
 * convertLeadToProject takes two overrides and derives everything else — the
 * name, the project type, the address, the jurisdiction, the contract value,
 * the rate, the built-up area, the delivery model and the stage template — from
 * the lead and the accepted quote, inside the transaction. That is rule 6's
 * "nothing is retyped": the number the client signed is the number the project
 * carries, and a conversion form that let any of it be re-entered would be a
 * form that let it be changed.
 *
 * convertSchema above is therefore wider than the service accepts. It is left
 * in place rather than narrowed because narrowing it is a decision about the
 * service's signature, not about this boundary; the mismatch is recorded in
 * DECISIONS.md and in the header of routes.tsx.
 */
export const convertOverridesSchema = z.object({
  plannedStart: optionalDate,
  contractSignedOn: optionalDate,
})

export function firstError(err: z.ZodError): string {
  const issue = err.issues[0]
  return issue ? issue.message : 'That submission was not valid.'
}
