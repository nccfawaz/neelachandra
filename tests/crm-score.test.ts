import { describe, expect, it } from 'vitest'
import {
  SERVED_CITIES,
  STAGE_PROBABILITY,
  STAGE_RANK,
  advances,
  computeLeadScore,
  computeQuoteTotals,
  expectedValuePaise,
  temperatureFor,
  type LeadScoreInput,
} from '../src/modules/crm/service.js'
import { LEAD_STAGES } from '../src/modules/crm/schemas.js'

/*
 * The pure half of the CRM service (spec 6.7 rules 1, 2 and 4).
 *
 * These five functions are the ones that decide a number the business acts on:
 * what a lead is worth, whether it is hot, whether a stage move is forward, and
 * what a client is charged. They take no database handle, so they are tested
 * directly rather than through a fixture — and the weights in rule 1 are my
 * apportionment, not the spec's, which is the strongest reason to pin them: a
 * silent change to a weight moves every lead's temperature at once.
 */

const BLANK: LeadScoreInput = {
  plotOwnership: null,
  hasSanctionedPlan: null,
  fundingMode: null,
  expectedStart: null,
  budgetMinPaise: null,
  budgetMaxPaise: null,
  targetBuiltUpSqft: null,
  packageRatePaise: null,
  siteCity: null,
}

function score(patch: Partial<LeadScoreInput>): number {
  return computeLeadScore({ ...BLANK, ...patch }).score
}

describe('computeLeadScore', () => {
  it('scores an empty lead zero rather than guessing', () => {
    const out = computeLeadScore(BLANK)
    expect(out.score).toBe(0)
    expect(out.signals).toHaveLength(6)
    expect(out.signals.every((s) => s.points === 0)).toBe(true)
  })

  it('the six maxima sum to 100', () => {
    const maxima = computeLeadScore(BLANK).signals.reduce((n, s) => n + s.max, 0)
    expect(maxima).toBe(100)
  })

  it('a fully qualified lead in the served area scores 100', () => {
    expect(
      score({
        plotOwnership: 'owned_clear_title',
        hasSanctionedPlan: 1,
        fundingMode: 'loan_sanctioned',
        expectedStart: 'immediate',
        targetBuiltUpSqft: 2000,
        packageRatePaise: 200000,
        budgetMaxPaise: 400000000,
        siteCity: 'Bengaluru',
      })
    ).toBe(100)
  })

  it('ranks ownership in the order rule 1 states', () => {
    const of = (plotOwnership: string) => score({ plotOwnership })
    expect(of('owned_clear_title')).toBe(25)
    expect(of('owned_under_verification')).toBe(18)
    expect(of('joint_development')).toBe(12)
    expect(of('agreement_stage')).toBe(8)
    // "Near zero, not zero": the lead is still worth calling back.
    expect(of('not_yet_purchased')).toBe(1)
  })

  it('scores an unrecognised enum member zero instead of throwing', () => {
    expect(score({ plotOwnership: 'inherited_disputed' })).toBe(0)
    expect(score({ fundingMode: 'crypto' })).toBe(0)
    expect(score({ expectedStart: 'next_decade' })).toBe(0)
  })

  it('treats a sanctioned loan and self-funding as the same certainty', () => {
    expect(score({ fundingMode: 'loan_sanctioned' })).toBe(score({ fundingMode: 'self' }))
    expect(score({ fundingMode: 'loan_applied' })).toBeLessThan(score({ fundingMode: 'home_loan' }))
  })

  it('gives no plan credit for anything but a plan in hand', () => {
    expect(score({ hasSanctionedPlan: 1 })).toBe(15)
    expect(score({ hasSanctionedPlan: 0 })).toBe(0)
    // Not asked is not the same as no, but it earns the same points: the
    // question has to be answered before it can count for anything.
    expect(score({ hasSanctionedPlan: null })).toBe(0)
  })

  describe('budget fit', () => {
    // 2000 sqft at Rs 2000/sqft needs Rs 40,00,000 = 400000000 paise.
    const need = { targetBuiltUpSqft: 2000, packageRatePaise: 200000 }

    it('is full marks when the ceiling reaches the package', () => {
      expect(score({ ...need, budgetMaxPaise: 400000000 })).toBe(15)
      expect(score({ ...need, budgetMaxPaise: 500000000 })).toBe(15)
    })

    it('tapers through the near misses', () => {
      expect(score({ ...need, budgetMaxPaise: 360000000 })).toBe(11) // 90%
      expect(score({ ...need, budgetMaxPaise: 300000000 })).toBe(6) // 75%
      expect(score({ ...need, budgetMaxPaise: 299000000 })).toBe(0) // just under
    })

    it('reads the ceiling of the range, not the floor', () => {
      expect(score({ ...need, budgetMinPaise: 100000000, budgetMaxPaise: 400000000 })).toBe(15)
      // Floor only: it is all the client has told us, so it is the ceiling.
      expect(score({ ...need, budgetMinPaise: 400000000 })).toBe(15)
      expect(score({ ...need, budgetMinPaise: 100000000 })).toBe(0)
    })

    it('scores nothing when either side of the comparison is missing', () => {
      expect(score({ budgetMaxPaise: 400000000 })).toBe(0)
      expect(score({ ...need })).toBe(0)
      expect(score({ targetBuiltUpSqft: 0, packageRatePaise: 200000, budgetMaxPaise: 1 })).toBe(0)
    })
  })

  it('matches the served area case-insensitively and on the alternate names', () => {
    expect(score({ siteCity: 'Bengaluru' })).toBe(10)
    expect(score({ siteCity: '  bangalore  ' })).toBe(10)
    expect(score({ siteCity: 'Tumkur' })).toBe(10)
    expect(score({ siteCity: 'Mysuru' })).toBe(0)
    expect(score({ siteCity: '' })).toBe(0)
  })

  it('carries the alternate spellings of every served city', () => {
    // Guards the pairing rather than the list: if a city is added to the golden
    // master with one spelling only, this says so.
    for (const city of ['bengaluru', 'bangalore', 'tumakuru', 'tumkur', 'doddaballapura', 'doddaballapur']) {
      expect(SERVED_CITIES as readonly string[]).toContain(city)
    }
  })

  it('reports what it counted, so the badge can explain itself', () => {
    const out = computeLeadScore({ ...BLANK, plotOwnership: 'owned_clear_title', siteCity: 'Tumakuru' })
    const byKey = new Map(out.signals.map((s) => [s.key, s]))
    expect(byKey.get('plot_ownership')).toEqual({
      key: 'plot_ownership',
      label: 'Plot ownership',
      points: 25,
      max: 25,
    })
    expect(byKey.get('served_area')?.points).toBe(10)
    expect(byKey.get('funding_mode')?.points).toBe(0)
    expect(out.score).toBe(35)
  })
})

describe('temperatureFor', () => {
  it('is cold past the staleness window whatever the score', () => {
    expect(temperatureFor(100, 31)).toBe('cold')
    expect(temperatureFor(100, 400)).toBe('cold')
  })

  it('needs a high score and a recent touch to be hot', () => {
    expect(temperatureFor(70, 14)).toBe('hot')
    expect(temperatureFor(70, 0)).toBe('hot')
    expect(temperatureFor(69, 1)).toBe('warm')
    expect(temperatureFor(70, 15)).toBe('warm')
  })

  it('is cold below 40 and warm in between', () => {
    expect(temperatureFor(39, 1)).toBe('cold')
    expect(temperatureFor(40, 1)).toBe('warm')
    expect(temperatureFor(69, 20)).toBe('warm')
  })

  it('treats no activity at all as not stale and not fresh', () => {
    // A lead created an hour ago has no activity row yet. It must not read cold
    // for that, and it must not read hot either.
    expect(temperatureFor(100, null)).toBe('warm')
    expect(temperatureFor(10, null)).toBe('cold')
  })
})

describe('advances', () => {
  it('is true going forward and false going back or standing still', () => {
    expect(advances('qualified', 'quote_sent')).toBe(true)
    expect(advances('quote_sent', 'qualified')).toBe(false)
    expect(advances('quote_sent', 'quote_sent')).toBe(false)
  })

  it('lets a late implied stage stay where it is', () => {
    // A second site visit during negotiation must not walk the lead back to
    // site_visit_done and reset its probability to 35.
    expect(advances('negotiation', 'site_visit_done')).toBe(false)
    expect(advances('verbal_agreement', 'quote_sent')).toBe(false)
  })

  it('lets a revived off-pipeline lead advance', () => {
    expect(advances('dormant', 'contacted')).toBe(true)
    expect(advances('lost', 'quote_sent')).toBe(true)
    expect(advances('disqualified', 'new')).toBe(true)
  })

  it('ranks every stage the schema allows', () => {
    for (const stage of LEAD_STAGES) {
      expect(STAGE_RANK[stage], stage).toBeTypeOf('number')
      expect(STAGE_PROBABILITY, stage).toHaveProperty(stage)
    }
  })

  it('keeps the probabilities rule 2 names and no others', () => {
    expect(STAGE_PROBABILITY.qualified).toBe(20)
    expect(STAGE_PROBABILITY.site_visit_done).toBe(35)
    expect(STAGE_PROBABILITY.quote_sent).toBe(50)
    expect(STAGE_PROBABILITY.negotiation).toBe(70)
    expect(STAGE_PROBABILITY.verbal_agreement).toBe(85)
    expect(STAGE_PROBABILITY.won).toBe(100)
    // Unnamed stages are null, not an invented figure: nothing is forecast off
    // a lead that has only been contacted.
    expect(STAGE_PROBABILITY.new).toBeNull()
    expect(STAGE_PROBABILITY.contacted).toBeNull()
    expect(STAGE_PROBABILITY.site_visit_scheduled).toBeNull()
    expect(STAGE_PROBABILITY.estimate_shared).toBeNull()
    expect(STAGE_PROBABILITY.lost).toBe(0)
  })
})

describe('expectedValuePaise', () => {
  const blank = {
    targetBuiltUpSqft: null,
    packageRatePaise: null,
    budgetMinPaise: null,
    budgetMaxPaise: null,
  }

  it('prefers area times the package rate', () => {
    expect(
      expectedValuePaise({ ...blank, targetBuiltUpSqft: 2400, packageRatePaise: 212500, budgetMaxPaise: 1 })
    ).toBe(510000000)
  })

  it('falls back to the midpoint of the budget range', () => {
    expect(expectedValuePaise({ ...blank, budgetMinPaise: 300000000, budgetMaxPaise: 400000000 })).toBe(350000000)
  })

  it('takes whichever side of the range it has', () => {
    expect(expectedValuePaise({ ...blank, budgetMinPaise: 300000000 })).toBe(300000000)
    expect(expectedValuePaise({ ...blank, budgetMaxPaise: 400000000 })).toBe(400000000)
  })

  it('is null when nothing is known, rather than zero', () => {
    // A pipeline total that silently counts an unknown lead as zero reads as a
    // forecast. Null makes the gap visible.
    expect(expectedValuePaise(blank)).toBeNull()
    expect(expectedValuePaise({ ...blank, targetBuiltUpSqft: 2400 })).toBeNull()
    expect(expectedValuePaise({ ...blank, packageRatePaise: 212500 })).toBeNull()
  })

  it('ignores a zero area rather than valuing the lead at nothing', () => {
    expect(
      expectedValuePaise({ ...blank, targetBuiltUpSqft: 0, packageRatePaise: 212500, budgetMinPaise: 5 })
    ).toBe(5)
  })

  it('returns whole paise', () => {
    const v = expectedValuePaise({ ...blank, targetBuiltUpSqft: 1234.5, packageRatePaise: 212533 })
    expect(Number.isInteger(v)).toBe(true)
  })
})

describe('computeQuoteTotals', () => {
  const base = {
    pricingBasis: 'per_sqft',
    builtUpAreaSqft: 2000,
    ratePerSqftPaise: 200000,
    linesPaise: 0,
    visitExtrasPaise: 0,
    discountPct: 0,
    gstPct: 18,
  }

  it('prices per square foot off area times rate', () => {
    const t = computeQuoteTotals(base)
    expect(t.basePaise).toBe(400000000)
    expect(t.extrasPaise).toBe(0)
    expect(t.discountPaise).toBe(0)
    expect(t.subtotalPaise).toBe(400000000)
    expect(t.gstPaise).toBe(72000000)
    expect(t.totalPaise).toBe(472000000)
  })

  it('adds the lines as extras on a per-sqft quote', () => {
    const t = computeQuoteTotals({ ...base, linesPaise: 50000000 })
    expect(t.basePaise).toBe(400000000)
    expect(t.extrasPaise).toBe(50000000)
    expect(t.subtotalPaise).toBe(450000000)
  })

  it('makes the lines the base on a lumpsum or item-rate quote', () => {
    for (const pricingBasis of ['lumpsum', 'item_rate']) {
      const t = computeQuoteTotals({ ...base, pricingBasis, linesPaise: 380000000 })
      // The area and rate on the row are ignored, so a leftover 2000 sqft from
      // a switched basis cannot silently double the price.
      expect(t.basePaise).toBe(380000000)
      expect(t.extrasPaise).toBe(0)
    }
  })

  it('carries the site-visit extra cost into the extras either way', () => {
    expect(computeQuoteTotals({ ...base, visitExtrasPaise: 7500000 }).extrasPaise).toBe(7500000)
    expect(
      computeQuoteTotals({ ...base, pricingBasis: 'lumpsum', linesPaise: 1, visitExtrasPaise: 7500000 }).extrasPaise
    ).toBe(7500000)
  })

  it('discounts the base and the extras together, before GST', () => {
    const t = computeQuoteTotals({ ...base, linesPaise: 100000000, discountPct: 10 })
    expect(t.discountPaise).toBe(50000000)
    expect(t.subtotalPaise).toBe(450000000)
    expect(t.gstPaise).toBe(81000000)
    expect(t.totalPaise).toBe(531000000)
  })

  it('keeps every figure a whole number of paise', () => {
    const t = computeQuoteTotals({
      ...base,
      builtUpAreaSqft: 1337.5,
      ratePerSqftPaise: 212533,
      linesPaise: 333333,
      discountPct: 7.5,
      gstPct: 18,
    })
    for (const [key, v] of Object.entries(t)) {
      expect(Number.isInteger(v), key).toBe(true)
    }
    expect(t.subtotalPaise + t.gstPaise).toBe(t.totalPaise)
    expect(t.basePaise + t.extrasPaise - t.discountPaise).toBe(t.subtotalPaise)
  })

  it('treats a missing area or rate as nothing rather than NaN', () => {
    const t = computeQuoteTotals({ ...base, builtUpAreaSqft: null, ratePerSqftPaise: null })
    expect(t.basePaise).toBe(0)
    expect(t.totalPaise).toBe(0)
  })
})
