import { describe, expect, it } from 'vitest'
import {
  applyPct,
  computeRetention,
  computeTds,
  computeVoucher,
  formatPaise,
  formatPaiseCompact,
  formatRupees,
  paiseToRupees,
  parseRupeeInput,
  roundPaise,
  rupeesToPaise,
  splitGst,
  sumPaise,
  variancePct,
} from '../src/lib/money.js'

/**
 * Money is integer paise everywhere (spec 2.4). These tests exist for the
 * rounding edges, not the happy path: a rupee amount that has been through a
 * float is the defect this module is built to prevent, and the places it can
 * still creep in are negatives, halves, and the CGST/SGST split.
 */

describe('roundPaise', () => {
  it('rounds half away from zero in both directions', () => {
    // Math.round(-0.5) is -0, which would make a credit note round a different
    // magnitude from the debit it reverses.
    expect(roundPaise(0.5)).toBe(1)
    expect(roundPaise(-0.5)).toBe(-1)
    expect(roundPaise(1.5)).toBe(2)
    expect(roundPaise(-1.5)).toBe(-2)
  })
})

describe('rupeesToPaise', () => {
  it('converts numbers and comma-grouped strings', () => {
    expect(rupeesToPaise(1234.56)).toBe(123456)
    expect(rupeesToPaise('12,34,567.89')).toBe(123456789)
    expect(rupeesToPaise(' 100 ')).toBe(10000)
  })

  it('returns 0 rather than NaN for junk', () => {
    expect(rupeesToPaise('abc')).toBe(0)
    expect(rupeesToPaise('')).toBe(0)
  })

  it('survives the classic float cases', () => {
    expect(rupeesToPaise(0.07)).toBe(7)
    expect(rupeesToPaise(-1234.56)).toBe(-123456)
    expect(rupeesToPaise(2.675)).toBe(268)
  })

  it('is exact for every two-decimal input, which is all a form can produce', () => {
    for (let paise = 0; paise <= 2000; paise += 1) {
      expect(rupeesToPaise((paise / 100).toFixed(2))).toBe(paise)
    }
  })

  it('rounds a half-paisa input down, not up', () => {
    // 1.005 * 100 is 100.49999999999999 in IEEE 754, so half-up on the product
    // gives 100 rather than the 101 that decimal arithmetic would. Recorded
    // rather than fixed: paise is the smallest unit any column can hold, so a
    // half-paisa input has no exact answer, and every field that reaches this
    // helper from a form is a two-decimal rupee amount covered by the case
    // above.
    expect(rupeesToPaise(1.005)).toBe(100)
  })

  it('round-trips through paiseToRupees', () => {
    expect(paiseToRupees(rupeesToPaise('99,999.99'))).toBe(99999.99)
  })
})

describe('formatting', () => {
  it('groups the Indian way', () => {
    expect(formatPaise(123456700)).toBe('12,34,567.00')
    expect(formatRupees(123456700)).toBe('Rs 12,34,567.00')
  })

  it('renders null and undefined as empty, not as zero', () => {
    expect(formatPaise(null)).toBe('')
    expect(formatPaise(undefined)).toBe('')
    expect(formatRupees(null)).toBe('')
  })

  it('keeps the sign on a negative', () => {
    expect(formatRupees(-123456700)).toBe('Rs -12,34,567.00')
    expect(formatPaiseCompact(-1_240_000_000)).toBe('-Rs 1.24 Cr')
  })

  it('speaks crore and lakh on KPI cards', () => {
    expect(formatPaiseCompact(1_240_000_000)).toBe('Rs 1.24 Cr')
    expect(formatPaiseCompact(123_450_000)).toBe('Rs 12.35 L')
    expect(formatPaiseCompact(4_560_000)).toBe('Rs 45,600')
    expect(formatPaiseCompact(0)).toBe('Rs 0')
  })
})

describe('splitGst', () => {
  it('splits an odd tax without losing or inventing a paisa', () => {
    // 18% of 1,00,000.01 is 18,000.0018 -> 1800000 paise exactly; use an
    // amount whose tax is odd so the halves cannot both be equal.
    const split = splitGst(100_001, 18)
    expect(split.cgstPaise + split.sgstPaise).toBe(applyPct(100_001, 18))
    expect(split.cgstPaise - split.sgstPaise).toBeLessThanOrEqual(1)
    expect(split.igstPaise).toBe(0)
    expect(split.totalPaise).toBe(100_001 + split.cgstPaise + split.sgstPaise)
  })

  it('gives the remainder paisa to CGST', () => {
    const split = splitGst(100_001, 18)
    expect(split.cgstPaise).toBeGreaterThanOrEqual(split.sgstPaise)
  })

  it('puts the whole tax in IGST inter-state', () => {
    const split = splitGst(500_000, 18, true)
    expect(split.igstPaise).toBe(90_000)
    expect(split.cgstPaise).toBe(0)
    expect(split.sgstPaise).toBe(0)
  })
})

describe('computeVoucher', () => {
  it('deducts TDS on the taxable value, not on the GST-inclusive total', () => {
    const v = computeVoucher({ taxablePaise: 1_000_000, gstPct: 18, tdsPct: 2 })
    expect(v.taxablePaise).toBe(1_000_000)
    expect(v.cgstPaise + v.sgstPaise).toBe(180_000)
    expect(v.totalPaise).toBe(1_180_000)
    // 2% of the taxable 10,000, i.e. 200 rupees. Taking it on the gross would
    // give 23,600 paise and overstate every deduction by the GST rate.
    expect(v.tdsPaise).toBe(20_000)
    expect(v.netPayablePaise).toBe(1_160_000)
  })

  it('defaults TDS to zero', () => {
    const v = computeVoucher({ taxablePaise: 1_000_000, gstPct: 18 })
    expect(v.tdsPaise).toBe(0)
    expect(v.netPayablePaise).toBe(v.totalPaise)
  })
})

describe('computeTds and computeRetention', () => {
  it('are percentage of taxable, rounded to whole paise', () => {
    expect(computeTds(333_333, 1)).toBe(3333)
    expect(computeRetention(1_000_000, 5)).toBe(50_000)
  })
})

describe('sumPaise', () => {
  it('treats null and undefined columns as zero', () => {
    expect(sumPaise([100, null, 200, undefined])).toBe(300)
    expect(sumPaise([])).toBe(0)
  })
})

describe('variancePct', () => {
  it('returns null for a zero baseline rather than Infinity', () => {
    // "no norm set" and "infinitely over" are different answers and the
    // consumption report must not print the second when it means the first.
    expect(variancePct(50, 0)).toBeNull()
  })

  it('is signed', () => {
    expect(variancePct(110, 100)).toBeCloseTo(10)
    expect(variancePct(90, 100)).toBeCloseTo(-10)
  })
})

describe('parseRupeeInput', () => {
  it('accepts what a user actually types', () => {
    expect(parseRupeeInput('12,34,567.89')).toBe(123456789)
    expect(parseRupeeInput('1234567.89')).toBe(123456789)
    expect(parseRupeeInput('12 34 567')).toBe(123456700)
    expect(parseRupeeInput('Rs 500')).toBe(50_000)
  })

  it('returns null instead of silently booking zero', () => {
    expect(parseRupeeInput('')).toBeNull()
    expect(parseRupeeInput(null)).toBeNull()
    expect(parseRupeeInput('twelve')).toBeNull()
    // Three decimal places is not a rupee amount; rejecting it beats rounding
    // it behind the user's back.
    expect(parseRupeeInput('1.234')).toBeNull()
  })
})
