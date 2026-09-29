import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGES } from '../../scripts/lib/pages.mjs'
import { GOOGLE_RATING, PHONE, PRICES_INCLUDE_GST } from '../../src/content/facts'

/**
 * Cross-page fact-consistency gate (DECISIONS §42, Stage 1 hotfix). The audit's
 * central finding was that the brand stated its own core facts in conflicting
 * ways on the SAME site (4.8 vs 4.0, "over a decade" vs founded-2018, three
 * different phone numbers). src/content/facts.ts is now the single source of
 * truth; this gate proves the served bytes (§29.60) agree with it and with each
 * other, so a future edit cannot reintroduce the drift.
 *
 * Every value pinned here is a repo CONSTANT (facts.ts) or a pure cross-page
 * agreement check — never the wall clock. The years figure in particular is
 * checked for INTERNAL agreement across pages (all pages say the same N), not
 * against new Date(): a gate that depends on the clock is a property of the
 * environment, not of the tree (CLAUDE.md, "a gate must not depend on
 * environment it does not set"). Year-rollover staleness is the build's job,
 * not this gate's.
 */

function servedFile(path: string): string {
  return path === '/' ? 'index.html' : path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
}

// Strip HTML and CSS comments so a documentation comment (e.g. the accessibility
// note that literally quotes "4.8") is not mistaken for a live rating claim.
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const RATING_CTX = /rating|star|★|review|Google|\/\s*5/i

const pages = PAGES.map((p: { slug: string; path: string }) => {
  const file = servedFile(p.path)
  const raw = readFileSync(resolve(__dirname, '../../', file), 'utf8')
  return { slug: p.slug, file, raw, body: stripComments(raw) }
})

// Windows of `text` around each match of `needle`, for context testing.
function windowsAround(text: string, needle: RegExp, pad = 50): string[] {
  const re = new RegExp(`.{0,${pad}}${needle.source}.{0,${pad}}`, 'gs')
  return text.match(re) ?? []
}

describe('the served pages agree with facts.ts and with each other', () => {
  it('scans the full canonical page set (non-zero floor)', () => {
    expect(pages.length).toBe(PAGES.length)
    for (const p of pages) expect(p.raw.length).toBeGreaterThan(500)
  })

  describe('rating', () => {
    const good = GOOGLE_RATING.value.toFixed(1) // 4.0, not "4" — Number(4.0) String would drop it

    it('states the real rating (4.0) in a rating context somewhere (positive floor)', () => {
      const found = pages.flatMap((p) => windowsAround(p.body, new RegExp(good.replace('.', '\\.'))))
        .filter((w) => RATING_CTX.test(w))
      expect(found.length).toBeGreaterThan(0)
    })

    it('never states the invented 4.8 in a rating context', () => {
      const bad = pages
        .filter((p) => windowsAround(p.body, /4\.8/).some((w) => RATING_CTX.test(w)))
        .map((p) => p.file)
      expect(bad, `4.8 rating claim survives in: ${bad.join(', ')}`).toEqual([])
    })
  })

  describe('aggregateRating schema node', () => {
    it('reads real JSON-LD blocks (non-zero floor) then finds no aggregateRating', () => {
      const ldBlocks = pages.reduce((n, p) => n + (p.raw.match(/application\/ld\+json/g)?.length ?? 0), 0)
      expect(ldBlocks).toBeGreaterThan(0) // else the "no aggregateRating" check is vacuous
      const withNode = pages.filter((p) => /"aggregateRating"/.test(p.raw)).map((p) => p.file)
      expect(withNode, `aggregateRating node survives in: ${withNode.join(', ')}`).toEqual([])
    })
  })

  describe('phone', () => {
    const core = PHONE.replace(/\D/g, '').slice(-10) // 7829292929, present in both display and tel:

    it('shows the canonical number somewhere (positive floor)', () => {
      const total = pages.reduce((n, p) => n + (p.raw.match(new RegExp(core, 'g'))?.length ?? 0), 0)
      expect(total).toBeGreaterThan(0)
    })

    it('shows no obsolete number', () => {
      const bad = pages.filter((p) => /8029\s*652243|6157\s*069211/.test(p.raw)).map((p) => p.file)
      expect(bad, `obsolete phone survives in: ${bad.join(', ')}`).toEqual([])
    })
  })

  describe('years in business', () => {
    it('carries no stale/contradictory duration phrase', () => {
      const bad = pages.filter((p) => /over a decade|10\+\s*years|over 8 years/i.test(p.body)).map((p) => p.file)
      expect(bad, `stale duration claim survives in: ${bad.join(', ')}`).toEqual([])
    })

    it('states one and only one "N+ years" figure across the whole site', () => {
      const values = new Set<string>()
      for (const p of pages) for (const m of p.body.matchAll(/(\d+)\+\s*years/gi)) values.add(m[1])
      expect(values.size).toBeGreaterThan(0) // positive floor: the claim is present
      expect(values.size, `pages disagree on years in business: ${[...values].join(' vs ')}`).toBe(1)
    })
  })

  describe('GST-inclusive pricing disclosure', () => {
    const PRICE_PAGES = [
      'index.html',
      'construction-packages-in-bengaluru.html',
      'best-construction-company-in-bengaluru.html',
      'construction-company-in-tumkur.html',
    ]

    it('states the disclosure on every price page (floor: 4 price pages)', () => {
      expect(PRICES_INCLUDE_GST).toBe(true)
      const priced = pages.filter((p) => PRICE_PAGES.includes(p.file))
      expect(priced.length).toBe(PRICE_PAGES.length)
      const missing = priced.filter((p) => !p.raw.includes('All prices include GST')).map((p) => p.file)
      expect(missing, `GST disclosure missing on: ${missing.join(', ')}`).toEqual([])
    })
  })
})
