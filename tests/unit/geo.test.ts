import { describe, expect, it } from 'vitest'
import { SITE_FAR_THRESHOLD_M, distanceMeters, isFarFromSite, isValidReading } from '../../src/lib/geo.js'

describe('isValidReading', () => {
  it('accepts a real position', () => {
    expect(isValidReading({ lat: 12.9716, lng: 77.5946 })).toBe(true)
  })

  it('rejects 0,0 — a GPS failure serialises there, and it is the ocean off Ghana', () => {
    expect(isValidReading({ lat: 0, lng: 0 })).toBe(false)
  })

  it('rejects out-of-range and non-finite values', () => {
    expect(isValidReading({ lat: 91, lng: 0 })).toBe(false)
    expect(isValidReading({ lat: 0, lng: 181 })).toBe(false)
    expect(isValidReading({ lat: Number.NaN, lng: 0 })).toBe(false)
    expect(isValidReading({ lat: Number.POSITIVE_INFINITY, lng: 0 })).toBe(false)
  })

  it('accepts legitimate non-zero edge coordinates (0 latitude is real)', () => {
    // Quito sits on the equator: lat 0 with a real longitude is valid. Only
    // the (0,0) PAIR is the failure signature.
    expect(isValidReading({ lat: 0, lng: -78.4678 })).toBe(true)
  })
})

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    const p = { lat: 12.9716, lng: 77.5946 }
    expect(distanceMeters(p, p)).toBeCloseTo(0, 5)
  })

  it('measures a known short span', () => {
    // ~111 m per degree of latitude, so one thousandth of a degree ≈ 111 m.
    const a = { lat: 12.9716, lng: 77.5946 }
    const b = { lat: 12.9726, lng: 77.5946 }
    const d = distanceMeters(a, b)
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(120)
  })

  it('measures east-west spans, scaled by the cosine of latitude', () => {
    // 0.011° of longitude is ~1.22 km at the equator and ~1.19 km at ~13°N
    // (cos 13° ≈ 0.974); a flat-earth formula at the reference latitude would
    // quietly differ on long spans.
    const a = { lat: 12.9716, lng: 77.5946 }
    const b = { lat: 12.9716, lng: 77.6056 }
    const equator = distanceMeters({ lat: 0, lng: a.lng }, { lat: 0, lng: b.lng })
    const d = distanceMeters(a, b)
    expect(d).toBeGreaterThan(1100)
    expect(d).toBeLessThan(1250)
    expect(d).toBeLessThan(equator) // cosine scaling, not a flat projection
  })
})

describe('isFarFromSite', () => {
  const site = { lat: 12.9716, lng: 77.5946 }

  it('is false just inside the threshold', () => {
    // ~45 m north of the site.
    const near = { lat: site.lat + 0.0004, lng: site.lng }
    expect(isFarFromSite(near, site)).toBe(false)
  })

  it('is true beyond the threshold (boundary excluded)', () => {
    // ~110 m north is inside; ~560 m north is outside. The threshold is 500 m.
    const inside = { lat: site.lat + 0.001, lng: site.lng }
    const outside = { lat: site.lat + 0.005, lng: site.lng }
    expect(isFarFromSite(inside, site)).toBe(false)
    expect(isFarFromSite(outside, site)).toBe(true)
    expect(SITE_FAR_THRESHOLD_M).toBe(500)
  })

  it('is false when the site has no coordinates, not true', () => {
    const anywhere = { lat: site.lat + 0.5, lng: site.lng }
    expect(isFarFromSite(anywhere, null)).toBe(false)
  })
})
