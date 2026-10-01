import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOOGLE_RATING } from '../../src/content/facts'

/**
 * llms.txt / llms-full.txt rating-free gate (Stage 2, batch 2b).
 *
 * The two LLM-facing index files are served at the repository root and are
 * hand-maintained (build-site.mjs excludes them from the verbatim golden/infra
 * copy, exactly as robots.txt is, because batch 2b corrected them). The
 * served-pages fact-consistency gate iterates PAGES only and never scans these
 * two files, so a rating claim could survive here while every HTML page is
 * clean. This gate closes that gap: it is the llms mirror of the rating-claim
 * detectors in served-fact-consistency.test.ts.
 *
 * BASIS: src/content/facts.ts sets GOOGLE_RATING.displayAggregateRating=false and
 * the owner has cleared no rating for publication (STAGE2 Q11). The premise guard
 * below cites that flag: if Q11 is answered yes and the flag flips, this block
 * goes red and is revisited rather than silently passing a rating.
 */

const FILES = ['llms.txt', 'llms-full.txt']

const docs = FILES.map((file) => {
  const raw = readFileSync(resolve(__dirname, '../../', file), 'utf8')
  return { file, raw }
})

const RATING_CTX = /rating|star|★|review|Google|\/\s*5/i

// Windows of `text` around each match of `needle`, for context testing.
function windowsAround(text: string, needle: RegExp, pad = 90): string[] {
  const re = new RegExp(`.{0,${pad}}${needle.source}.{0,${pad}}`, 'gs')
  return text.match(re) ?? []
}

describe('llms.txt / llms-full.txt carry no rating claim', () => {
  it('premise: facts.ts withholds the aggregate rating (cited basis)', () => {
    expect(GOOGLE_RATING.displayAggregateRating).toBe(false)
  })

  // Non-zero floor (§28.1): an absence assertion over an empty scan passes
  // vacuously. Prove the scan has real input — both files exist, are substantial,
  // and the full declared set was read — so "no claim found" means scanned-and-
  // clean, not scanned-nothing.
  it('scans a non-empty corpus before asserting absence', () => {
    expect(docs.length).toBe(FILES.length)
    for (const d of docs) expect(d.raw.length).toBeGreaterThan(500)
  })

  // Each detector is a distinct rating-claim shape, mirroring the served-pages
  // gate. A bare 4.x is not a claim on its own — but unlike the HTML pages these
  // plain-text files carry no CSS/SVG decimals, so any 4.0/4.8 sitting beside a
  // rating word is a live claim.
  const CLAIMS: { name: string; find: (body: string) => boolean }[] = [
    {
      name: 'the 4.0/4.8 rating value in a rating context',
      find: (b) => windowsAround(b, /4\.[08]/).some((w) => RATING_CTX.test(w)),
    },
    { name: 'star glyph ★', find: (b) => /★/.test(b) },
    { name: 'review-count claim (N reviews)', find: (b) => /\d+\s+(?:Google\s+)?reviews\b/i.test(b) },
    { name: '"client rating" phrase', find: (b) => /client rating/i.test(b) },
    { name: '"average rating" phrase', find: (b) => /average rating/i.test(b) },
    { name: '"verified ... rating/review"', find: (b) => /verified[^.<>\n]{0,40}(?:rating|review)/i.test(b) },
  ]

  for (const { name, find } of CLAIMS) {
    it(`no llms file carries a rating claim: ${name}`, () => {
      const bad = docs.filter((d) => find(d.raw)).map((d) => d.file)
      expect(bad, `rating claim (${name}) survives in: ${bad.join(', ')}`).toEqual([])
    })
  }

  // Obsolete phone numbers must not reappear here either (facts.ts canonical
  // number is 7829292929); batch 2b replaced the 8029652243 landline.
  it('shows no obsolete phone number', () => {
    const bad = docs.filter((d) => /8029\s*652243|6157\s*069211/.test(d.raw)).map((d) => d.file)
    expect(bad, `obsolete phone survives in: ${bad.join(', ')}`).toEqual([])
  })
})
