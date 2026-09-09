import { describe, expect, it } from 'vitest'
import {
  applyPct,
  computeRetention,
  computeTds,
  computeVoucher,
  formatPaiseAsRupees,
  formatPaiseAsRupeesCompact,
  formatPaiseAsRupeesWithRs,
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
    expect(formatPaiseAsRupees(123456700)).toBe('12,34,567.00')
    expect(formatPaiseAsRupeesWithRs(123456700)).toBe('Rs 12,34,567.00')
  })

  it('renders null and undefined as empty, not as zero', () => {
    expect(formatPaiseAsRupees(null)).toBe('')
    expect(formatPaiseAsRupees(undefined)).toBe('')
    expect(formatPaiseAsRupeesWithRs(null)).toBe('')
  })

  it('keeps the sign on a negative', () => {
    expect(formatPaiseAsRupeesWithRs(-123456700)).toBe('Rs -12,34,567.00')
    expect(formatPaiseAsRupeesCompact(-1_240_000_000)).toBe('-Rs 1.24 Cr')
  })

  it('speaks crore and lakh on KPI cards', () => {
    expect(formatPaiseAsRupeesCompact(1_240_000_000)).toBe('Rs 1.24 Cr')
    expect(formatPaiseAsRupeesCompact(123_450_000)).toBe('Rs 12.35 L')
    expect(formatPaiseAsRupeesCompact(4_560_000)).toBe('Rs 45,600')
    expect(formatPaiseAsRupeesCompact(0)).toBe('Rs 0')
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

  it('rounds the total tax HALF-UP at the exact half-paisa (roundPaise, not floor)', () => {
    // 9% of 2,00,001 paise (GST 9+9): 18000.09 — no tie. The tie needs a
    // fraction of exactly .5: 18% of 1,00,000.25/100… instead take a taxable
    // whose tax ends in .5 paise exactly. 18% of 37,807.50… construct:
    // taxable 20,803 paise × 0.18 = 3744.54. taxable 20,797 × 0.18 =
    // 3743.46. A tax of x.5 arises when taxable × pct / 100 has fraction .5,
    // e.g. 18% of 12,475 = 2245.5 exactly — the half-paisa tie.
    const tax = applyPct(12_475, 18)
    expect(tax).toBe(2246) // Math.round(2245.5) = 2246 — half goes UP

    // The mirror: a negative amount (a credit note) rounds half away from
    // zero, not toward it — roundPaise(-2245.5) = -2246.
    expect(roundPaise(-2245.5)).toBe(-2246)
    expect(roundPaise(2245.5)).toBe(2246)
  })

  it('gives the single odd paisa to CGST, so cgst − sgst ∈ {0, 1} and never negative', () => {
    // 18% of 12,475 = 2245.5 → rounds to 2246 (odd total). Half of 2246 is
    // 1123 exactly, so no remainder there; use a taxable whose ROUNDED tax
    // is odd: 18% of 12,476 = 2245.68 → 2246, even again. 18% of 12,477 =
    // 2245.86 → 2246. Use 18% of 12,486 = 2247.48 → 2247, odd: the split
    // must be 1124/1123, CGST taking the extra paisa.
    const split = splitGst(12_486, 18)
    expect(split.cgstPaise).toBe(1124)
    expect(split.sgstPaise).toBe(1123)
    expect(split.cgstPaise - split.sgstPaise).toBe(1)

    // And a large value keeps the same invariant: 18% of 99,99,999 paise is
    // 17,99,999.82 → 18,00,000 (even, equal halves).
    const big = splitGst(9_999_999, 18)
    expect(big.cgstPaise).toBe(900_000)
    expect(big.sgstPaise).toBe(900_000)
    expect(big.cgstPaise - big.sgstPaise).toBe(0)
  })

  it('never loses or invents a paisa across odd, half and large shapes', () => {
    for (const taxable of [12_475, 12_486, 9_999_999, 100_001, 1]) {
      const split = splitGst(taxable, 18)
      expect(split.cgstPaise + split.sgstPaise).toBe(applyPct(taxable, 18))
      expect(split.totalPaise).toBe(taxable + applyPct(taxable, 18))
      const inter = splitGst(taxable, 18, true)
      expect(inter.igstPaise).toBe(applyPct(taxable, 18))
      expect(inter.totalPaise).toBe(taxable + inter.igstPaise)
    }
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
