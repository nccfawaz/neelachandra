import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGES } from '../../scripts/lib/pages.mjs'

/**
 * Placeholder / breakage regression gate for the served public pages
 * (DECISIONS §42, Stage 1 hotfix). The 10 root HTML files ARE the deployed
 * bytes (Hostinger serves the repo root, §29.54); this gate reads those bytes,
 * not the golden source (§29.60: assert served, not source).
 *
 * SCOPE (deliberately narrow, per §"A sweep must state its scope"): this pins
 * the specific breakage CLASSES the hotfix repaired, so they cannot silently
 * come back. It is NOT an absolute "no placeholder" assertion — the open
 * owner-fact markers `[CLIENT TO VERIFY: …]` (identity/registration, gallery
 * alts, map dims) legitimately remain in index.html, deferred to Stage 2. An
 * absolute zero-placeholder gate would be red for the wrong reason and the
 * cheapest way to green it would be to invent facts. So each pattern below is a
 * defect that was actually removed, and nothing else.
 */

// Derive the served filename from the canonical page list exactly as
// scripts/lib/corrections.mjs does — the file set is grounded in PAGES, not
// hand-listed, so a page added there is covered here too.
function servedFile(path: string): string {
  return path === '/' ? 'index.html' : path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
}

const pages = PAGES.map((p: { slug: string; path: string }) => {
  const file = servedFile(p.path)
  return { slug: p.slug, file, html: readFileSync(resolve(__dirname, '../../', file), 'utf8') }
})

// Each entry: a defect class this hotfix removed, and the regex that finds it.
const BREAKAGE: { name: string; re: RegExp }[] = [
  { name: 'unfilled [PLACEHOLDER: …] marker', re: /\[PLACEHOLDER[:\]]/ },
  { name: 'phone placeholder +91-XXXXXXXXXX', re: /\+91-X{5,}/ },
  { name: 'obsolete phone 8029652243', re: /8029\s*652243|8029652243/ },
  { name: 'obsolete phone 6157069211', re: /6157\s*069211|6157069211/ },
  { name: 'malformed numeric opening tag (e.g. <34 …>)', re: /<\d+[\s>]/ },
  { name: 'broken link href="/about" (should be /about-us)', re: /href="\/about"/ },
  { name: 'broken link href="/contact" (should be /contact-us)', re: /href="\/contact"/ },
  { name: '"Rs" instead of the ₹ symbol', re: /\bRs\b/ },
]

describe('served public pages carry none of the repaired breakage classes', () => {
  it('scans the full canonical page set (non-zero floor)', () => {
    // §28.1: prove the enumeration is non-empty before asserting over it, and
    // that it is the size we expect — an empty or short scan would pass every
    // "no defect" check below vacuously.
    expect(pages.length).toBe(PAGES.length)
    expect(pages.length).toBeGreaterThan(0)
    for (const p of pages) expect(p.html.length).toBeGreaterThan(500)
  })

  for (const { name, re } of BREAKAGE) {
    it(`no page contains: ${name}`, () => {
      const hits = pages.filter((p) => re.test(p.html)).map((p) => p.file)
      expect(hits, `${name} still present in: ${hits.join(', ')}`).toEqual([])
    })
  }
})
