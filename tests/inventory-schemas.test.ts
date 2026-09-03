import { describe, expect, it } from 'vitest'
import {
  adjustmentSchema,
  firstError,
  itemSchema,
  openingStockSchema,
  poSchema,
  poShortCloseSchema,
  transferReceiveSchema,
  transferSchema,
  vendorRateSchema,
  vendorSchema,
  vendorStatusSchema,
} from '../src/modules/inventory/schemas.js'

/**
 * The inventory form contracts.
 *
 * Two things are being pinned here. First, rupees become paise exactly once, at
 * this boundary (spec 2.4), so a schema that returns a rupee float or converts
 * twice is a defect that reaches a BIGINT column. Second, the line grids read
 * Hono's `parseBody({ all: true })` shape, where a field that appears once is a
 * plain string and a field that appears twice is an array. A one-row purchase
 * order and an eight-row one go through different branches of rawList, and only
 * one of them is the case anybody tests by hand.
 */

/** What readBody returns for a grid with one row: scalars, not arrays. */
const oneRowGrid = {
  itemId: '7',
  qtyOrdered: '10',
  rate: '250.50',
}

/** What it returns for two rows: arrays in submission order. */
const twoRowGrid = {
  itemId: ['7', '9'],
  qtyOrdered: ['10', '2.5'],
  rate: ['250.50', '1000'],
}

const poBase = {
  vendorId: '3',
  poDate: '2026-09-03',
  deliveryLocationId: '1',
}

describe('poSchema line grid', () => {
  it('reads a single-row grid arriving as plain strings', () => {
    const parsed = poSchema.safeParse({ ...poBase, ...oneRowGrid })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines).toHaveLength(1)
    expect(parsed.data.lines[0]).toMatchObject({ itemId: 7, qtyOrdered: 10, ratePaise: 25_050 })
  })

  it('reads a multi-row grid arriving as arrays, in order', () => {
    const parsed = poSchema.safeParse({ ...poBase, ...twoRowGrid })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines).toHaveLength(2)
    expect(parsed.data.lines[0]).toMatchObject({ itemId: 7, qtyOrdered: 10, ratePaise: 25_050 })
    expect(parsed.data.lines[1]).toMatchObject({ itemId: 9, qtyOrdered: 2.5, ratePaise: 100_000 })
  })

  it('converts the rate to paise exactly once', () => {
    const parsed = poSchema.safeParse({ ...poBase, itemId: '7', qtyOrdered: '1', rate: '1' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    // One rupee is 100 paise. A second conversion downstream would make 10000.
    expect(parsed.data.lines[0]!.ratePaise).toBe(100)
  })

  it('accepts a comma-grouped rate', () => {
    const parsed = poSchema.safeParse({ ...poBase, itemId: '7', qtyOrdered: '1', rate: '12,34,567.89' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines[0]!.ratePaise).toBe(123_456_789)
  })

  it('skips a blank row without failing the form', () => {
    // The line grid renders spare empty rows; leaving one untouched is normal
    // use, not an error.
    const parsed = poSchema.safeParse({
      ...poBase,
      itemId: ['7', ''],
      qtyOrdered: ['10', ''],
      rate: ['250.50', ''],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines).toHaveLength(1)
  })

  it('names the line number in the message when a filled row is wrong', () => {
    const parsed = poSchema.safeParse({
      ...poBase,
      itemId: ['7', '9'],
      qtyOrdered: ['10', '0'],
      rate: ['250.50', '100'],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('Line 2: enter a quantity greater than zero.')
  })

  it('rejects a row with an item and no rate', () => {
    const parsed = poSchema.safeParse({ ...poBase, itemId: '7', qtyOrdered: '10', rate: '' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('Line 1: enter a rate greater than zero.')
  })

  it('refuses an order with no lines at all', () => {
    const parsed = poSchema.safeParse(poBase)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('Add at least one order line.')
  })

  it('defaults GST to 18 percent and freight to zero', () => {
    const parsed = poSchema.safeParse({ ...poBase, ...oneRowGrid })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines[0]!.gstPct).toBe(18)
    expect(parsed.data.freightPaise).toBe(0)
    expect(parsed.data.advancePct).toBe(0)
  })

  it('falls back to 18 for a blank GST cell but honours an explicit zero', () => {
    // Number('') is 0, which is finite and inside 0..100, so a blank cell used
    // to book the line at no tax at all. Nil-rated items still need a real 0.
    const blank = poSchema.safeParse({ ...poBase, ...oneRowGrid, gstPct: '' })
    expect(blank.success).toBe(true)
    if (blank.success) expect(blank.data.lines[0]!.gstPct).toBe(18)

    const zero = poSchema.safeParse({ ...poBase, ...oneRowGrid, gstPct: '0' })
    expect(zero.success).toBe(true)
    if (zero.success) expect(zero.data.lines[0]!.gstPct).toBe(0)

    const junk = poSchema.safeParse({ ...poBase, ...oneRowGrid, gstPct: 'eighteen' })
    expect(junk.success).toBe(true)
    if (junk.success) expect(junk.data.lines[0]!.gstPct).toBe(18)

    const outOfRange = poSchema.safeParse({ ...poBase, ...oneRowGrid, gstPct: '180' })
    expect(outOfRange.success).toBe(true)
    if (outOfRange.success) expect(outOfRange.data.lines[0]!.gstPct).toBe(18)
  })

  it('reads a per-line GST rate where one is typed', () => {
    const parsed = poSchema.safeParse({ ...poBase, ...twoRowGrid, gstPct: ['5', '28'] })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines.map((l) => l.gstPct)).toEqual([5, 28])
  })

  it('rejects an advance over 100 percent', () => {
    const parsed = poSchema.safeParse({ ...poBase, ...oneRowGrid, advancePct: '120' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('An advance over 100% is not an advance.')
  })
})

describe('transferSchema', () => {
  const base = { fromLocationId: '1', toLocationId: '2', dispatchedOn: '2026-09-03' }

  it('refuses a transfer between one store and itself', () => {
    const parsed = transferSchema.safeParse({ ...base, toLocationId: '1', itemId: '7', qtySent: '5' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('A transfer needs two different stores.')
  })

  it('rounds a quantity to three decimals to match DECIMAL(14,3)', () => {
    const parsed = transferSchema.safeParse({ ...base, itemId: '7', qtySent: '5.00049' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines[0]!.qtySent).toBe(5)
  })

  it('keeps a batch number per line', () => {
    const parsed = transferSchema.safeParse({
      ...base,
      itemId: ['7', '9'],
      qtySent: ['5', '3'],
      batchNo: ['B-1', ''],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines[0]!.batchNo).toBe('B-1')
    expect(parsed.data.lines[1]!.batchNo).toBeNull()
  })
})

describe('transferReceiveSchema', () => {
  it('accepts zero received, because nothing arriving is a real outcome', () => {
    const parsed = transferReceiveSchema.safeParse({ receivedOn: '2026-09-03', lineId: '4', qtyReceived: '0' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines).toEqual([{ lineId: 4, qtyReceived: 0 }])
  })

  it('rejects a negative received quantity', () => {
    const parsed = transferReceiveSchema.safeParse({ receivedOn: '2026-09-03', lineId: '4', qtyReceived: '-1' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('Line 1: enter a received quantity of zero or more.')
  })
})

describe('adjustmentSchema', () => {
  const base = { locationId: '1', adjustmentDate: '2026-09-03', reason: 'physical_count' }

  it('takes the counted quantity and nothing else per line', () => {
    // The system quantity is deliberately absent from the form and the POST:
    // postAdjustment reads it inside the transaction from the row it locks.
    const parsed = adjustmentSchema.safeParse({
      ...base,
      narration: 'Monthly count of the main store.',
      itemId: ['7', '9'],
      qtyPhysical: ['10', '0'],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.lines).toEqual([
      { itemId: 7, qtyPhysical: 10 },
      { itemId: 9, qtyPhysical: 0 },
    ])
  })

  it('demands a narration of at least ten characters', () => {
    const parsed = adjustmentSchema.safeParse({ ...base, narration: 'count', itemId: '7', qtyPhysical: '1' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('Explain the adjustment in at least 10 characters.')
  })

  it('caps the narration at the column width rather than at the INSERT', () => {
    const parsed = adjustmentSchema.safeParse({
      ...base,
      narration: 'x'.repeat(256),
      itemId: '7',
      qtyPhysical: '1',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown reason', () => {
    const parsed = adjustmentSchema.safeParse({
      ...base,
      reason: 'shrinkage',
      narration: 'Monthly count of the main store.',
      itemId: '7',
      qtyPhysical: '1',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('openingStockSchema', () => {
  const base = { locationId: '1', itemId: '7', asOn: '2026-04-01' }

  it('returns the rate in paise under the name the form uses', () => {
    const parsed = openingStockSchema.safeParse({ ...base, qty: '100', rate: '250.50' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.rate).toBe(25_050)
    expect(parsed.data.qty).toBe(100)
  })

  it('requires a rate, because it sets the item valuation at that store', () => {
    const parsed = openingStockSchema.safeParse({ ...base, qty: '100', rate: '' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toBe('Enter the rate this stock is valued at.')
  })

  it('rejects a zero or negative rate', () => {
    for (const rate of ['0', '-5']) {
      const parsed = openingStockSchema.safeParse({ ...base, qty: '100', rate })
      expect(parsed.success, `rate ${rate}`).toBe(false)
    }
  })

  it('rejects a zero or negative opening quantity', () => {
    for (const qty of ['0', '-1']) {
      const parsed = openingStockSchema.safeParse({ ...base, qty, rate: '250' })
      expect(parsed.success, `qty ${qty}`).toBe(false)
    }
  })
})

describe('vendorRateSchema', () => {
  it('converts the rate once and leaves validTo open', () => {
    const parsed = vendorRateSchema.safeParse({ itemId: '7', rate: '450', validFrom: '2026-09-01', validTo: '' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.rate).toBe(45_000)
    expect(parsed.data.validTo).toBeNull()
    expect(parsed.data.freightIncluded).toBe(false)
  })

  it('reads a Yes/No select as a boolean', () => {
    const parsed = vendorRateSchema.safeParse({
      itemId: '7',
      rate: '450',
      validFrom: '2026-09-01',
      freightIncluded: '1',
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.freightIncluded).toBe(true)
  })
})

describe('vendorStatusSchema', () => {
  it('requires a reason to blacklist', () => {
    const parsed = vendorStatusSchema.safeParse({ status: 'blacklisted', blacklistReason: '' })
    expect(parsed.success).toBe(false)
  })

  it('does not require one for the other statuses', () => {
    expect(vendorStatusSchema.safeParse({ status: 'on_hold' }).success).toBe(true)
    expect(vendorStatusSchema.safeParse({ status: 'active' }).success).toBe(true)
  })
})

describe('vendorSchema', () => {
  it('accepts a vendor with only the required fields', () => {
    const parsed = vendorSchema.safeParse({ name: 'Sri Ganesh Traders', vendorType: 'material' })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown vendor type', () => {
    expect(vendorSchema.safeParse({ name: 'X', vendorType: 'gardening' }).success).toBe(false)
  })
})

describe('itemSchema', () => {
  it('reads flags from Yes/No selects, since FormField has no checkbox', () => {
    const parsed = itemSchema.safeParse({
      code: 'CEM-OPC-53',
      name: 'OPC 53 grade cement',
      categoryId: '2',
      unitId: '3',
      isBatchTracked: '1',
      isActive: '0',
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.isBatchTracked).toBe(true)
    expect(parsed.data.isActive).toBe(false)
  })
})

describe('poShortCloseSchema', () => {
  it('needs a reason of at least ten characters', () => {
    expect(poShortCloseSchema.safeParse({ reason: 'no stock' }).success).toBe(false)
    expect(poShortCloseSchema.safeParse({ reason: 'Vendor cannot supply the balance.' }).success).toBe(true)
  })
})

describe('firstError', () => {
  it('returns one sentence for the banner', () => {
    const parsed = poSchema.safeParse({})
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(firstError(parsed.error)).toMatch(/\S/)
    expect(firstError(parsed.error)).not.toContain('\n')
  })
})
