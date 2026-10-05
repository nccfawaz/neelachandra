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

  describe('rating (none published — facts.ts withholds the aggregate)', () => {
    // BASIS: src/content/facts.ts sets GOOGLE_RATING.displayAggregateRating=false.
    // The owner has not cleared ANY Google rating or review count for publication
    // (STAGE2 Q11), so no served page may state a rating in any form. This is the
    // served-bytes mirror of the rating-visible corrector's RESIDUAL tripwire.
    // The premise guard below cites that flag: if Q11 is later answered yes and the
    // flag flips, this block goes red and is revisited rather than silently passing
    // a rating the gate was written to forbid.
    it('premise: facts.ts withholds the aggregate rating (cited basis)', () => {
      expect(GOOGLE_RATING.displayAggregateRating).toBe(false)
    })

    // Non-zero floor (§28.1): an absence assertion over an empty scan passes
    // vacuously. Prove the numeric detector has real input — the pages carry the
    // 4.0/4.8 needle in CSS/SVG — and that the page corpus is the full canonical
    // set, so "no claim found" means scanned-and-clean, not scanned-nothing.
    it('scans a non-empty corpus before asserting absence', () => {
      const needleHits = pages.reduce((n, p) => n + (p.body.match(/4\.[08]/g)?.length ?? 0), 0)
      expect(needleHits).toBeGreaterThan(0)
      expect(pages.length).toBe(PAGES.length)
    })

    // Each detector is a distinct rating-claim shape (mirrors corrections.mjs
    // RESIDUAL). A bare 4.x is not a claim — CSS/SVG carry unrelated values — so
    // the numeric detector only fires on a value sitting beside a rating word.
    const CLAIMS: { name: string; find: (body: string) => boolean }[] = [
      {
        // Mirrors the rating-visible RESIDUAL: only the two values a rating claim
        // ever used (invented 4.8, genuine 4.0). A bare \d.\d is NOT a claim — geo
        // lat/long, CSS lengths and share.google carry decimals near RATING_CTX
        // words ('flex-start' contains 'star') and are not ratings.
        name: 'the 4.0/4.8 rating value in a rating context',
        find: (b) => windowsAround(b, /4\.[08]/, 90).some((w) => RATING_CTX.test(w)),
      },
      { name: 'star glyph ★', find: (b) => /★/.test(b) },
      { name: 'review-count claim (N reviews)', find: (b) => /\d+\s+(?:Google\s+)?reviews\b/i.test(b) },
      {
        name: '"Avg. Verified Client Rating" label',
        find: (b) => /Avg\.\s*Verified\s*Client\s*Rating/i.test(b),
      },
      { name: '"verified ... rating/review"', find: (b) => /verified[^.<>]{0,40}(?:rating|review)/i.test(b) },
    ]

    for (const { name, find } of CLAIMS) {
      it(`no served page carries a rating claim: ${name}`, () => {
        const bad = pages.filter((p) => find(p.body)).map((p) => p.file)
        expect(bad, `rating claim (${name}) survives in: ${bad.join(', ')}`).toEqual([])
      })
    }
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

  describe('project and area count claims (hotfix batch 3)', () => {
    // BASIS: owner decision, hotfix batch 3. The golden masters contradicted
    // each other on the delivered-project count: the tumkur page carried a
    // 60+ stat card and two 200+ claims while every other page, the meta
    // descriptions and llms-full.txt said 30+. The Mandot Steel facility was
    // "85,000+ sq ft" on the bengaluru and projects pages and a plain
    // "85,000 sq ft" on the home page and in the portfolio sections of those
    // same pages. The `count-claims` corrector aligns the served pages and
    // llms-full.txt was corrected by hand (build-site.mjs excludes the llms
    // files from the golden copy, so the build cannot drift them back). The
    // count-claims corrector has no RESIDUAL tripwire, so this gate is the
    // enforcement for the whole batch.
    //
    // llms.txt and llms-full.txt join the pages as the served corpus. Tags are
    // replaced by a space before the value scan so a count sitting in one
    // element next to its label in another (the tumkur trust card, the
    // bengaluru bng-stat spans) is still read as one "N+ label" claim; comment
    // stripping is inherited from the page corpus above so a documentation
    // note that quotes a number is not mistaken for a claim.
    const llmsFiles = ['llms.txt', 'llms-full.txt'].map((file) => ({
      file,
      body: readFileSync(resolve(__dirname, '../../', file), 'utf8'),
    }))
    const corpus = [...pages.map((p) => ({ file: p.file, body: p.body })), ...llmsFiles].map((c) => ({
      file: c.file,
      body: c.body.replace(/<[^>]+>/g, ' '),
    }))

    it('scans the served pages and both llms files (non-zero floor)', () => {
      expect(corpus.length).toBe(PAGES.length + 2)
    })

    it('states one and only one "N+ projects" figure across the whole corpus', () => {
      const values = new Set<string>()
      for (const c of corpus) for (const m of c.body.matchAll(/(\d+)\+\s*(?:completed\s+|infrastructure\s+)?projects?\b/gi)) values.add(m[1])
      expect(values.size).toBeGreaterThan(0) // positive floor: the claim is present
      expect(values.size, `corpus disagrees on project count: ${[...values].join(' vs ')}`).toBe(1)
      expect([...values][0], `project count must be 30+, found: ${[...values].join(' vs ')}`).toBe('30')
    })

    it('carries no "200+" project claim anywhere', () => {
      const bad = corpus.filter((c) => /200\+/.test(c.body)).map((c) => c.file)
      expect(bad, `"200+" survives in: ${bad.join(', ')}`).toEqual([])
    })

    it('carries no "60+ projects" claim anywhere', () => {
      const bad = corpus.filter((c) => /60\+\s*projects?/i.test(c.body)).map((c) => c.file)
      expect(bad, `"60+ projects" survives in: ${bad.join(', ')}`).toEqual([])
    })

    it('carries no "85,000+" area claim anywhere', () => {
      const bad = corpus.filter((c) => /85,000\+/.test(c.body)).map((c) => c.file)
      expect(bad, `"85,000+" survives in: ${bad.join(', ')}`).toEqual([])
    })
  })
})
