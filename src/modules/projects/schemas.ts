import { z } from 'zod'

/** Zod at every route boundary (spec 2.6). */

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

export const requiredDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.')

const optionalDecimal = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (v === '' || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  })

/**
 * Rupees in the form, paise in the column.
 *
 * The conversion happens here rather than in the service so there is exactly
 * one boundary where a float becomes an integer, and nothing downstream ever
 * holds a rupee float (spec 2.4).
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

export const PROJECT_TYPES = [
  'residential_construction',
  'commercial_construction',
  'industrial_construction',
  'interior_fitout',
  'civil_infrastructure',
  'machine_foundation',
  'renovation',
  'equipment_rental',
] as const

export const DELIVERY_MODELS = [
  'package_per_sqft',
  'item_rate',
  'lumpsum',
  'cost_plus',
  'labour_only',
] as const

export const JURISDICTIONS = ['BBMP', 'BMRDA', 'BDA', 'Gram Panchayat', 'TUDA', 'KIADB', 'Other'] as const

export const createProjectSchema = z.object({
  clientId: z.coerce.number().int().positive('Choose a client.'),
  name: z.string().trim().min(3, 'Give the project a name.').max(200),
  projectType: z.enum(PROJECT_TYPES),
  deliveryModel: z.enum(DELIVERY_MODELS),
  siteAddress: z.string().trim().min(5, 'Enter the site address.').max(1000),
  city: z.string().trim().min(2, 'Enter the city.').max(80),
  jurisdiction: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))
    .refine(
      (v) => v === null || (JURISDICTIONS as readonly string[]).includes(v),
      'Choose a valid planning authority.'
    ),
  builtUpAreaSqft: optionalDecimal,
  plotAreaSqft: optionalDecimal,
  scopeOfWork: optionalText(2000),
  plannedStart: optionalDate,
  plannedEnd: optionalDate,
  contractValuePaise: rupeesToPaiseField,
  ratePerSqftPaise: rupeesToPaiseField,
  contractSignedOn: optionalDate,
  stageTemplateId: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) && n > 0 ? n : null
    }),
})

export const projectStatusSchema = z.object({
  status: z.enum([
    'prospect',
    'mobilising',
    'in_progress',
    'on_hold',
    'snagging',
    'handed_over',
    'defect_liability',
    'closed',
    'cancelled',
  ]),
  reason: optionalText(255),
})

export const stageProgressSchema = z.object({
  progressPct: z.coerce.number().min(0, 'Progress cannot be negative.').max(100, 'Progress cannot exceed 100.'),
  override: optionalText(500),
})

export const dprSchema = z.object({
  reportDate: requiredDate,
  weather: z.enum(['clear', 'cloudy', 'light_rain', 'heavy_rain', 'unworkable']),
  workStoppedHours: z.coerce.number().min(0).max(24, 'A day has 24 hours.').default(0),
  stoppageReason: z.enum([
    'none',
    'rain',
    'material_shortage',
    'labour_shortage',
    'power_failure',
    'client_instruction',
    'statutory',
    'equipment_breakdown',
    'safety_incident',
  ]),
  labourSkilled: z.coerce.number().int().min(0).max(9999).default(0),
  labourUnskilled: z.coerce.number().int().min(0).max(9999).default(0),
  // The whole point of a DPR is the narrative. A one-word entry defeats it,
  // so the floor is a real sentence.
  workDone: z.string().trim().min(10, 'Describe the work done, in at least 10 characters.').max(4000),
  issues: optionalText(2000),
  instructionsReceived: optionalText(2000),
})

export const qualityCheckSchema = z.object({
  projectStageId: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) && n > 0 ? n : null
    }),
  checkType: z.enum([
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
  ]),
  referenceNo: optionalText(60),
  sampleTakenOn: optionalDate,
  testedOn: optionalDate,
  targetValue: optionalDecimal,
  actualValue: optionalDecimal,
  unit: optionalText(20),
  result: z.enum(['pass', 'fail', 'pending', 'retest']),
  labName: optionalText(140),
})

export const snagSchema = z.object({
  location: z.string().trim().min(3, 'Say where the defect is.').max(160),
  trade: z.enum([
    'civil',
    'plaster',
    'painting',
    'electrical',
    'plumbing',
    'carpentry',
    'flooring',
    'waterproofing',
    'fabrication',
    'other',
  ]),
  description: z.string().trim().min(5, 'Describe the defect.').max(2000),
  severity: z.enum(['cosmetic', 'functional', 'structural', 'safety']),
  raisedSource: z.enum(['internal', 'client', 'consultant']),
  assignedTo: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) && n > 0 ? n : null
    }),
  targetDate: optionalDate,
})

export const snagStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'verified', 'rejected', 'deferred']),
})

export const approvalSchema = z.object({
  authority: z.enum([
    'BBMP',
    'BMRDA',
    'BDA',
    'Gram Panchayat',
    'TUDA',
    'KIADB',
    'BESCOM',
    'BWSSB',
    'KSPCB',
    'Fire',
    'Lift Inspectorate',
    'Other',
  ]),
  approvalType: z.string().trim().min(3, 'Name the approval.').max(140),
  referenceNo: optionalText(80),
  appliedOn: optionalDate,
  receivedOn: optionalDate,
  validUntil: optionalDate,
  feePaise: rupeesToPaiseField,
  status: z.enum(['not_started', 'applied', 'queried', 'received', 'rejected', 'expired']),
  blocksStageId: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) && n > 0 ? n : null
    }),
})

export const teamSchema = z.object({
  members: z.string().trim().optional(),
})

/** Turns the first Zod issue into one sentence for the banner. */
export function firstError(err: z.ZodError): string {
  const issue = err.issues[0]
  return issue ? issue.message : 'That submission was not valid.'
}
