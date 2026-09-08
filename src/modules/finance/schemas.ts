import { z } from 'zod'

/**
 * Finance input contracts (spec 6.8).
 *
 * Rule 1 is enforced here by shape: the create schema carries no
 * source_table/source_id fields at all, so a manual expense cannot
 * accidentally claim an upstream document. Rows produced by other modules
 * (GRN, contractor bill, equipment deployment, campaign spend) are written by
 * those modules' own code paths, never by this form.
 *
 * Rupees in the form, paise in the column, same as HR (spec 2.4).
 */

const requiredDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.')

const rupeesToPaise = z
  .string()
  .trim()
  .min(1, 'Enter an amount.')
  .transform((v) => {
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN
  })
  .refine((n) => Number.isFinite(n) && n > 0, 'Enter the amount in rupees.')

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))

const optionalId = z
  .string()
  .optional()
  .transform((v) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isInteger(n) && n > 0 ? n : null
  })

export const EXPENSE_TYPES = [
  'material_purchase',
  'labour_contractor',
  'subcontract',
  'equipment_hire',
  'equipment_fuel',
  'transport',
  'statutory_fee',
  'professional_fee',
  'salary',
  'site_overhead',
  'office_overhead',
  'marketing',
  'travel',
  'utilities',
  'repair_maintenance',
  'insurance',
  'interest',
  'other',
] as const

export const PAYEE_TYPES = ['vendor', 'contractor', 'employee', 'authority', 'other'] as const

export const expenseCreateSchema = z.object({
  expenseDate: requiredDate,
  projectId: optionalId,
  expenseType: z.enum(EXPENSE_TYPES),
  payeeType: z.enum(PAYEE_TYPES),
  payeeName: optionalText(180),
  narration: optionalText(500),
  lines: z
    .array(
      z.object({
        costHeadId: z.string().transform((v) => {
          const n = Number.parseInt(v, 10)
          return Number.isInteger(n) && n > 0 ? n : Number.NaN
        }),
        description: optionalText(300),
        amountPaise: rupeesToPaise,
      })
    )
    .min(1, 'An expense needs at least one line.')
    .max(50, 'One expense can carry at most 50 lines.'),
})

export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>

export function firstError(err: z.ZodError): string {
  const issue = err.issues[0]
  return issue ? issue.message : 'That submission was not valid.'
}

/* Payments (spec 6.8, slice 2) --------------------------------------------- */

const PAYMENT_MODES = ['bank_transfer', 'neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash', 'card', 'adjustment'] as const

export const paymentCreateSchema = z.object({
  paymentDate: requiredDate,
  direction: z.enum(['outgoing', 'incoming']),
  mode: z.enum(PAYMENT_MODES),
  amountPaise: rupeesToPaise,
  payeeOrPayer: z.string().trim().min(1, 'Name the payee or payer.').max(180),
  bankAccountId: optionalId,
  referenceNo: optionalText(60),
  narration: optionalText(300),
  // Allocations are optional at creation: an unallocated payment is a real
  // thing (an advance against future bills) and the allocator screen exists
  // to settle them later.
  allocations: z
    .array(
      z.object({
        documentType: z.enum(['expense', 'contractor_bill', 'client_invoice', 'advance']),
        documentId: z.string().transform((v) => {
          const n = Number.parseInt(v, 10)
          return Number.isInteger(n) && n > 0 ? n : Number.NaN
        }),
        allocatedPaise: rupeesToPaise,
      })
    )
    .max(50, 'One payment can carry at most 50 allocations.'),
})

export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>

export const paymentAllocateSchema = z.object({
  allocations: z
    .array(
      z.object({
        documentType: z.enum(['expense', 'contractor_bill', 'client_invoice', 'advance']),
        documentId: z.string().transform((v) => {
          const n = Number.parseInt(v, 10)
          return Number.isInteger(n) && n > 0 ? n : Number.NaN
        }),
        allocatedPaise: rupeesToPaise,
      })
    )
    .min(1, 'Name at least one document to allocate against.'),
})

export type PaymentAllocateInput = z.infer<typeof paymentAllocateSchema>