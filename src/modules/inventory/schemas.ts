import { z } from 'zod'

/**
 * Inventory form contracts (spec 2.6: Zod at every route boundary).
 *
 * The scalar helpers below are copied from src/modules/projects/schemas.ts
 * rather than shared. That is deliberate: the projects module is the pattern
 * the other modules replicate, and hoisting the helpers into a shared file
 * would be a redesign of that pattern.
 *
 * The list helpers are new, because inventory is the first module with
 * multi-line documents. Hono's parseBody keeps only the last value of a
 * repeated field unless it is called with `{ all: true }`
 * (node_modules/hono/dist/utils/body.js), so csrfProtect() and readBody() pass
 * that option and the grid columns below are named plainly — `itemId`, not
 * `itemId[]`. The bracketed spelling would work too, but Hono retains the
 * brackets in the key, so the schema keys would have to be quoted to match.
 * Under `{ all: true }` a one-row grid still arrives as a single string, which
 * is why rawList normalises both shapes.
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

const optionalDecimal = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    if (v === '' || v === undefined) return null
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  })

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

/** Quantities are DECIMAL(14,3); rounding here keeps float dust out of SQL. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

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

/**
 * A percentage cell, falling back when the cell is empty or unusable.
 *
 * The empty case is checked before the Number() because Number('') is 0, which
 * is finite and inside 0..100: without the guard a blank GST cell booked a line
 * at 0 percent instead of the 18 the caller asked for, and a purchase order
 * with no tax on it looks like a cheap quote rather than a bug. An explicit '0'
 * still means zero, which nil-rated items need.
 */
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

function dateAt(col: string[], i: number): string | null {
  const v = col[i] ?? ''
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
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

export const VENDOR_TYPES = ['material', 'equipment_hire', 'subcontractor', 'service', 'transport'] as const
export const VENDOR_STATUSES = ['active', 'on_hold', 'blacklisted'] as const
export const ISSUED_TO_TYPES = ['own_labour', 'labour_contractor', 'subcontractor'] as const
export const ADJUSTMENT_REASONS = [
  'physical_count',
  'damage',
  'theft',
  'expiry',
  'wastage',
  'correction',
] as const
export const REQUISITION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'partially_ordered',
  'ordered',
  'closed',
  'rejected',
] as const
export const PO_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'partially_received',
  'received',
  'short_closed',
  'cancelled',
] as const

export const itemSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Give the item a code.')
    .max(40)
    .regex(/^[A-Za-z0-9._/-]+$/, 'Item codes take letters, digits, dot, dash, slash and underscore only.')
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(3, 'Give the item a name.').max(200),
  categoryId: requiredId('Choose a category.'),
  unitId: requiredId('Choose a unit.'),
  costHeadId: optionalId,
  specification: optionalText(1000),
  hsnCode: optionalText(12),
  gstPct: z.coerce.number().min(0).max(28, 'GST is 28% at most.').default(18),
  reorderLevel: optionalDecimal,
  wastageAllowancePct: z.coerce.number().min(0).max(100, 'A wastage allowance over 100% is not a percentage.').default(0),
  shelfLifeDays: optionalId,
  isBatchTracked: yesNo(false),
  isActive: yesNo(true),
})

export const itemBrandSchema = z.object({
  brand: z.string().trim().min(2, 'Name the brand.').max(120),
  isApproved: yesNo(true),
  note: optionalText(255),
})

/**
 * The approve / withdraw toggle on the item page.
 *
 * itemId is carried in a hidden field only to pick the redirect target, since
 * setItemBrandApproval returns void and there is no single-brand read. It is
 * validated as an id but nothing is authorised from it, and a forged value
 * lands the user on a different item page they could have opened anyway.
 */
export const brandApprovalSchema = z.object({
  approved: yesNo(false),
  itemId: optionalId,
})

export const vendorSchema = z.object({
  name: z.string().trim().min(3, 'Give the vendor a name.').max(200),
  vendorType: z.enum(VENDOR_TYPES),
  gstin: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v.toUpperCase()))
    .refine(
      (v) => v === null || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(v),
      'A GSTIN is 15 characters, for example 29ABCDE1234F1Z5.'
    ),
  pan: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v.toUpperCase()))
    .refine((v) => v === null || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), 'A PAN is 10 characters, for example ABCDE1234F.'),
  msmeUdyamNo: optionalText(30),
  contactName: optionalText(140),
  phone: optionalText(20),
  email: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v))
    .refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Enter a valid email address.'),
  address: optionalText(1000),
  city: optionalText(80),
  paymentTermsDays: z.coerce.number().int().min(0).max(365, 'Payment terms beyond a year are not terms.').default(30),
  bankAccountName: optionalText(140),
  bankAccountNo: optionalText(30),
  bankIfsc: optionalText(15),
})

export const vendorStatusSchema = z
  .object({
    status: z.enum(VENDOR_STATUSES),
    blacklistReason: optionalText(500),
  })
  .refine(
    (v) => v.status !== 'blacklisted' || v.blacklistReason !== null,
    'Blacklisting a vendor needs a reason on the record.'
  )

export const vendorRatingSchema = z.object({
  ratingQuality: z.coerce.number().min(1, 'Rate from 1 to 5.').max(5, 'Rate from 1 to 5.'),
  ratingTimeliness: z.coerce.number().min(1, 'Rate from 1 to 5.').max(5, 'Rate from 1 to 5.'),
})

export const vendorRateSchema = z.object({
  itemId: requiredId('Choose an item.'),
  rate: z
    .string()
    .trim()
    .min(1, 'Enter the rate.')
    .transform((v) => Math.round(Number(v.replace(/,/g, '')) * 100))
    .refine((v) => Number.isFinite(v) && v > 0, 'Enter a rate greater than zero.'),
  validFrom: requiredDate,
  validTo: optionalDate,
  freightIncluded: yesNo(false),
  minOrderQty: optionalDecimal,
})

export interface RequisitionLineInput {
  itemId: number
  qtyRequested: number
  remarks: string | null
}

export const requisitionSchema = z
  .object({
    projectId: requiredId('Choose a project.'),
    projectStageId: optionalId,
    requiredByDate: optionalDate,
    remarks: optionalText(2000),
    itemId: rawList,
    qtyRequested: rawList,
    lineRemarks: rawList,
  })
  .transform((v, ctx) => {
    const lines: RequisitionLineInput[] = []
    for (let i = 0; i < v.itemId.length; i += 1) {
      const itemId = idAt(v.itemId, i)
      if (itemId === null) continue
      const qty = qtyAt(v.qtyRequested, i)
      if (qty === null || qty <= 0) {
        badLine(ctx, i, 'enter a quantity greater than zero.')
        continue
      }
      lines.push({ itemId, qtyRequested: qty, remarks: textAt(v.lineRemarks, i, 255) })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one item line.' })
    return {
      projectId: v.projectId,
      projectStageId: v.projectStageId,
      requiredByDate: v.requiredByDate,
      remarks: v.remarks,
      lines,
    }
  })

export interface ApprovedLineInput {
  lineId: number
  qtyApproved: number
}

/** Approval can cut a quantity but not invent one, so 0 is allowed. */
export const requisitionApproveSchema = z
  .object({
    lineId: rawList,
    qtyApproved: rawList,
    remarks: optionalText(500),
  })
  .transform((v, ctx) => {
    const lines: ApprovedLineInput[] = []
    for (let i = 0; i < v.lineId.length; i += 1) {
      const lineId = idAt(v.lineId, i)
      if (lineId === null) continue
      const qty = qtyAt(v.qtyApproved, i)
      if (qty === null || qty < 0) {
        badLine(ctx, i, 'enter an approved quantity of zero or more.')
        continue
      }
      lines.push({ lineId, qtyApproved: qty })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Nothing to approve.' })
    return { lines, remarks: v.remarks }
  })

export const rejectSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it is rejected.').max(500),
})

export interface PoLineInput {
  itemId: number
  brand: string | null
  qtyOrdered: number
  ratePaise: number
  gstPct: number
  costHeadId: number | null
  remarks: string | null
}

export const poSchema = z
  .object({
    vendorId: requiredId('Choose a vendor.'),
    projectId: optionalId,
    requisitionId: optionalId,
    poDate: requiredDate,
    expectedDelivery: optionalDate,
    deliveryLocationId: requiredId('Choose where it is delivered.'),
    freight: rupeesToPaiseField,
    paymentTermsDays: optionalId,
    advancePct: z.coerce.number().min(0).max(100, 'An advance over 100% is not an advance.').default(0),
    terms: optionalText(4000),
    itemId: rawList,
    brand: rawList,
    qtyOrdered: rawList,
    rate: rawList,
    gstPct: rawList,
    costHeadId: rawList,
    lineRemarks: rawList,
  })
  .transform((v, ctx) => {
    const lines: PoLineInput[] = []
    for (let i = 0; i < v.itemId.length; i += 1) {
      const itemId = idAt(v.itemId, i)
      if (itemId === null) continue
      const qty = qtyAt(v.qtyOrdered, i)
      const ratePaise = paiseAt(v.rate, i)
      if (qty === null || qty <= 0) {
        badLine(ctx, i, 'enter a quantity greater than zero.')
        continue
      }
      if (ratePaise === null || ratePaise <= 0) {
        badLine(ctx, i, 'enter a rate greater than zero.')
        continue
      }
      lines.push({
        itemId,
        brand: textAt(v.brand, i, 120),
        qtyOrdered: qty,
        ratePaise,
        gstPct: pctAt(v.gstPct, i, 18),
        costHeadId: idAt(v.costHeadId, i),
        remarks: textAt(v.lineRemarks, i, 255),
      })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one order line.' })
    return {
      vendorId: v.vendorId,
      projectId: v.projectId,
      requisitionId: v.requisitionId,
      poDate: v.poDate,
      expectedDelivery: v.expectedDelivery,
      deliveryLocationId: v.deliveryLocationId,
      freightPaise: v.freight ?? 0,
      paymentTermsDays: v.paymentTermsDays,
      advancePct: v.advancePct,
      terms: v.terms,
      lines,
    }
  })

export const poShortCloseSchema = z.object({
  reason: z.string().trim().min(10, 'A short close needs a reason of at least 10 characters.').max(500),
})

export interface GrnLineInput {
  poLineId: number | null
  itemId: number
  brand: string | null
  qtyChallan: number
  qtyReceived: number
  qtyAccepted: number
  qtyRejected: number
  rejectionReason: string | null
  batchNo: string | null
  manufactureDate: string | null
  expiryDate: string | null
  ratePaise: number
}

/**
 * Three separate numbers on receipt (spec 6.4 rule 3). Challan, received and
 * accepted are entered independently and never defaulted from each other,
 * because the whole value of the three-way match is that a mismatch is
 * visible rather than reconciled by the form.
 */
export const grnSchema = z
  .object({
    poId: optionalId,
    vendorId: requiredId('Choose the vendor.'),
    locationId: requiredId('Choose the receiving store.'),
    projectId: optionalId,
    receivedOn: requiredDate,
    vehicleNo: optionalText(20),
    invoiceNo: optionalText(60),
    invoiceDate: optionalDate,
    invoiceAmount: rupeesToPaiseField,
    weighbridgeSlipNo: optionalText(40),
    gateEntryNo: optionalText(40),
    inspectedBy: optionalId,
    poLineId: rawList,
    itemId: rawList,
    brand: rawList,
    qtyChallan: rawList,
    qtyReceived: rawList,
    qtyAccepted: rawList,
    rejectionReason: rawList,
    batchNo: rawList,
    manufactureDate: rawList,
    expiryDate: rawList,
    rate: rawList,
  })
  .transform((v, ctx) => {
    const lines: GrnLineInput[] = []
    for (let i = 0; i < v.itemId.length; i += 1) {
      const itemId = idAt(v.itemId, i)
      if (itemId === null) continue
      const qtyChallan = qtyAt(v.qtyChallan, i)
      const qtyReceived = qtyAt(v.qtyReceived, i)
      const qtyAccepted = qtyAt(v.qtyAccepted, i)
      const ratePaise = paiseAt(v.rate, i)
      if (qtyChallan === null || qtyChallan < 0) {
        badLine(ctx, i, 'enter the challan quantity.')
        continue
      }
      if (qtyReceived === null || qtyReceived < 0) {
        badLine(ctx, i, 'enter the quantity received.')
        continue
      }
      if (qtyAccepted === null || qtyAccepted < 0) {
        badLine(ctx, i, 'enter the quantity accepted.')
        continue
      }
      if (ratePaise === null || ratePaise < 0) {
        badLine(ctx, i, 'enter the rate.')
        continue
      }
      if (qtyAccepted > qtyReceived) {
        badLine(ctx, i, 'more cannot be accepted than was received.')
        continue
      }
      lines.push({
        poLineId: idAt(v.poLineId, i),
        itemId,
        brand: textAt(v.brand, i, 120),
        qtyChallan,
        qtyReceived,
        qtyAccepted,
        qtyRejected: round3(qtyReceived - qtyAccepted),
        rejectionReason: textAt(v.rejectionReason, i, 500),
        batchNo: textAt(v.batchNo, i, 60),
        manufactureDate: dateAt(v.manufactureDate, i),
        expiryDate: dateAt(v.expiryDate, i),
        ratePaise,
      })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one receipt line.' })
    return {
      poId: v.poId,
      vendorId: v.vendorId,
      locationId: v.locationId,
      projectId: v.projectId,
      receivedOn: v.receivedOn,
      vehicleNo: v.vehicleNo,
      invoiceNo: v.invoiceNo,
      invoiceDate: v.invoiceDate,
      invoiceAmountPaise: v.invoiceAmount,
      weighbridgeSlipNo: v.weighbridgeSlipNo,
      gateEntryNo: v.gateEntryNo,
      inspectedBy: v.inspectedBy,
      lines,
    }
  })

export interface IssueLineInput {
  itemId: number
  qtyIssued: number
  batchNo: string | null
  costHeadId: number | null
}

export const issueSchema = z
  .object({
    locationId: requiredId('Choose the issuing store.'),
    projectId: requiredId('Choose the project the material is for.'),
    projectStageId: optionalId,
    issuedOn: requiredDate,
    issuedToType: z.enum(ISSUED_TO_TYPES),
    labourContractorId: optionalId,
    receivedByName: optionalText(140),
    purpose: optionalText(500),
    itemId: rawList,
    qtyIssued: rawList,
    batchNo: rawList,
    costHeadId: rawList,
  })
  .transform((v, ctx) => {
    const lines: IssueLineInput[] = []
    for (let i = 0; i < v.itemId.length; i += 1) {
      const itemId = idAt(v.itemId, i)
      if (itemId === null) continue
      const qty = qtyAt(v.qtyIssued, i)
      if (qty === null || qty <= 0) {
        badLine(ctx, i, 'enter a quantity greater than zero.')
        continue
      }
      lines.push({
        itemId,
        qtyIssued: qty,
        batchNo: textAt(v.batchNo, i, 60),
        costHeadId: idAt(v.costHeadId, i),
      })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one issue line.' })
    if (v.issuedToType === 'labour_contractor' && v.labourContractorId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Name the labour contractor the material went to.' })
    }
    return {
      locationId: v.locationId,
      projectId: v.projectId,
      projectStageId: v.projectStageId,
      issuedOn: v.issuedOn,
      issuedToType: v.issuedToType,
      labourContractorId: v.labourContractorId,
      receivedByName: v.receivedByName,
      purpose: v.purpose,
      lines,
    }
  })

export interface ReturnLineInput {
  issueLineId: number
  qtyReturned: number
}

export const issueReturnSchema = z
  .object({
    returnedOn: requiredDate,
    issueLineId: rawList,
    qtyReturned: rawList,
  })
  .transform((v, ctx) => {
    const lines: ReturnLineInput[] = []
    for (let i = 0; i < v.issueLineId.length; i += 1) {
      const issueLineId = idAt(v.issueLineId, i)
      if (issueLineId === null) continue
      const qty = qtyAt(v.qtyReturned, i)
      if (qty === null || qty < 0) {
        badLine(ctx, i, 'enter a returned quantity of zero or more.')
        continue
      }
      if (qty > 0) lines.push({ issueLineId, qtyReturned: qty })
    }
    if (lines.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a returned quantity on at least one line.' })
    }
    return { returnedOn: v.returnedOn, lines }
  })

export interface TransferLineInput {
  itemId: number
  qtySent: number
  batchNo: string | null
}

export const transferSchema = z
  .object({
    fromLocationId: requiredId('Choose the sending store.'),
    toLocationId: requiredId('Choose the receiving store.'),
    dispatchedOn: requiredDate,
    vehicleNo: optionalText(20),
    itemId: rawList,
    qtySent: rawList,
    batchNo: rawList,
  })
  .transform((v, ctx) => {
    const lines: TransferLineInput[] = []
    for (let i = 0; i < v.itemId.length; i += 1) {
      const itemId = idAt(v.itemId, i)
      if (itemId === null) continue
      const qty = qtyAt(v.qtySent, i)
      if (qty === null || qty <= 0) {
        badLine(ctx, i, 'enter a quantity greater than zero.')
        continue
      }
      lines.push({ itemId, qtySent: qty, batchNo: textAt(v.batchNo, i, 60) })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one transfer line.' })
    if (v.fromLocationId === v.toLocationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A transfer needs two different stores.' })
    }
    return {
      fromLocationId: v.fromLocationId,
      toLocationId: v.toLocationId,
      dispatchedOn: v.dispatchedOn,
      vehicleNo: v.vehicleNo,
      lines,
    }
  })

export interface TransferReceiveLineInput {
  lineId: number
  qtyReceived: number
}

export const transferReceiveSchema = z
  .object({
    receivedOn: requiredDate,
    lineId: rawList,
    qtyReceived: rawList,
  })
  .transform((v, ctx) => {
    const lines: TransferReceiveLineInput[] = []
    for (let i = 0; i < v.lineId.length; i += 1) {
      const lineId = idAt(v.lineId, i)
      if (lineId === null) continue
      const qty = qtyAt(v.qtyReceived, i)
      if (qty === null || qty < 0) {
        badLine(ctx, i, 'enter a received quantity of zero or more.')
        continue
      }
      lines.push({ lineId, qtyReceived: qty })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Nothing to receive.' })
    return { receivedOn: v.receivedOn, lines }
  })

export interface AdjustmentLineInput {
  itemId: number
  qtyPhysical: number
}

/**
 * The physical count is the only number entered. qty_system is read from
 * item_stock inside the posting transaction, because a system quantity typed
 * on a form is a number the operator can make agree with the count.
 */
export const adjustmentSchema = z
  .object({
    locationId: requiredId('Choose the store.'),
    adjustmentDate: requiredDate,
    reason: z.enum(ADJUSTMENT_REASONS),
    // 255, not 2000: stock_adjustments.narration is VARCHAR(255). A longer
    // limit here would pass validation and then fail at the INSERT with a
    // truncation error the operator cannot read.
    narration: z.string().trim().min(10, 'Explain the adjustment in at least 10 characters.').max(255),
    itemId: rawList,
    qtyPhysical: rawList,
  })
  .transform((v, ctx) => {
    const lines: AdjustmentLineInput[] = []
    for (let i = 0; i < v.itemId.length; i += 1) {
      const itemId = idAt(v.itemId, i)
      if (itemId === null) continue
      const qty = qtyAt(v.qtyPhysical, i)
      if (qty === null || qty < 0) {
        badLine(ctx, i, 'enter the counted quantity, zero or more.')
        continue
      }
      lines.push({ itemId, qtyPhysical: qty })
    }
    if (lines.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one counted item.' })
    return {
      locationId: v.locationId,
      adjustmentDate: v.adjustmentDate,
      reason: v.reason,
      narration: v.narration,
      lines,
    }
  })

export const openingStockSchema = z.object({
  locationId: requiredId('Choose the store.'),
  itemId: requiredId('Choose an item.'),
  qty: z
    .string()
    .trim()
    .min(1, 'Enter the opening quantity.')
    .transform((v) => round3(Number(v.replace(/,/g, ''))))
    .refine((v) => Number.isFinite(v) && v > 0, 'Enter an opening quantity greater than zero.'),
  // Required, not rupeesToPaiseField: an opening balance without a rate has no
  // value, and this rate becomes the item's weighted average at that store, so
  // there is nothing sensible for postOpeningStock to fall back on.
  rate: z
    .string()
    .trim()
    .min(1, 'Enter the rate this stock is valued at.')
    .transform((v) => Math.round(Number(v.replace(/,/g, '')) * 100))
    .refine((v) => Number.isFinite(v) && v > 0, 'Enter a rate greater than zero.'),
  batchNo: optionalText(60),
  asOn: requiredDate,
})

export const equipmentDeploySchema = z.object({
  projectId: requiredId('Choose a project.'),
  fromDate: requiredDate,
  meterStart: optionalDecimal,
  operatorName: optionalText(140),
})

export const equipmentReturnSchema = z.object({
  toDate: requiredDate,
  meterEnd: optionalDecimal,
  locationId: optionalId,
})

/** Turns the first Zod issue into one sentence for the banner. */
export function firstError(err: z.ZodError): string {
  const issue = err.issues[0]
  return issue ? issue.message : 'That submission was not valid.'
}

