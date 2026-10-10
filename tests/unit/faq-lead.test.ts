import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * PHASE 1B gate: the seven FAQ lead rewrites. For each target the served VISIBLE
 * answer must equal the proposed text, the old wording must be gone, and the
 * JSON-LD answer must equal the visible answer (parity, markup stripped).
 */

const read = (f: string) => readFileSync(resolve(__dirname, '../../', f), 'utf8')
const dec = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function visiblePairs(h: string) {
  const out: { q: string; a: string }[] = []
  const r1 = /<h3 class="accordion-heading">\s*(?:<strong>)?\s*Q:\s*([\s\S]*?)\s*(?:<\/strong>)?\s*<\/h3>[\s\S]*?<div class="accordion-item-content">([\s\S]*?)<\/div>/gi
  let m
  while ((m = r1.exec(h))) out.push({ q: dec(m[1]), a: dec(m[2]).replace(/^A:\s*/, '') })
  return out
}
function ldPairs(h: string) {
  const out: { q: string; a: string }[] = []
  for (const m of h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let o: unknown
    try { o = JSON.parse(m[1]) } catch { continue }
    const w = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(w)
      if (n && typeof n === 'object') {
        const x = n as Record<string, any>
        if (x['@type'] === 'Question') out.push({ q: dec(String(x.name ?? '')), a: dec(String(x.acceptedAnswer?.text ?? '')) })
        Object.values(x).forEach(w)
      }
    }
    w(o)
  }
  return out
}

interface T { file: string; qContains: string; proposed: string; old: string }
const TARGETS: T[] = [
  { file: 'construction-services-in-bengaluru.html', qContains: 'Do I need BBMP plan approval', proposed: 'Structural extensions, such as adding a first or second floor to an existing building, require revised building plan sanctions from the BBMP, BMRDA, or relevant local panchayat. Internal modifications and minor repairs do not require formal approvals. Our team assists in managing this entire documentation process.', old: 'approvals. However, structural extensions' },
  { file: 'construction-packages-in-bengaluru.html', qContains: 'How much does it cost to build a house on a', proposed: 'Using our popular Gold package at ₹3,099 per sq ft, the total cost ranges from ₹55 lakhs to ₹62 lakhs for a 30x40 plot (1,200 sq ft) with a G+1 structure, which typically yields 1,800-2,000 sq ft of built-up area, complete with premium finishes and smart home automation.', old: 'with a G+1 structure typically yields' },
  { file: 'construction-packages-in-bengaluru.html', qContains: 'What is excluded from the per sq ft rate', proposed: 'Items outside the base rate include government statutory fees (BBMP/BMRDA), temporary BESCOM/BWSSB meter deposits, borewell drilling, external compound walls, and hard rock-breaking if required during excavation. We state all exclusions upfront in your detailed estimate.', old: 'detailed estimate. Items outside the base rate' },
  { file: 'construction-packages-in-bengaluru.html', qContains: 'Are BBMP or BMRDA plan approval fees included', proposed: 'Statutory fees, taxes, and government deposits are paid directly by the property owner as required by law. We handle the complete liaison, documentation, and architectural drawings required for BBMP, BMRDA, or Gram Panchayat plan sanctions.', old: 'sanctions. The actual statutory fees' },
  { file: 'construction-packages-in-bengaluru.html', qContains: 'What brands of cement and steel do you use', proposed: 'For cement we use UltraTech, ACC, or Birla Super (OPC 53 Grade for structural works), and for TMT steel JSW Neo, Tata Tiscon, or Indus (Fe500D or Fe550D), specified per package and stated in your agreement. These are exclusively Tier-1 materials.', old: 'Tier-1 materials. For cement:' },
  { file: 'about-us.html', qContains: 'What makes Neelachandra different from local building contractors', proposed: 'Neelachandra provides fixed-price contracts with no cost escalations, strict milestone-based payment timelines, an in-house team of qualified structural engineers and architects, and a legally binding 10-year structural warranty, operating as a professional turnkey company rather than an unorganized local contractor.', old: 'Unlike unorganized local contractors, Neelachandra operates' },
  { file: 'about-us.html', qContains: 'How does Neelachandra ensure the structural safety', proposed: 'Our in-house engineering team designs custom foundations based on site-specific soil testing reports, and we strictly adhere to Indian Standard (IS) codes for reinforcement detailing, concrete mix designs, and seismic factors to ensure lifelong structural durability. Structural safety is our highest priority.', old: 'highest priority. Our in-house engineering team' },
]

describe('phase 1b faq lead rewrites', () => {
  it('applies all seven targets (non-zero floor)', () => {
    expect(TARGETS.length).toBe(7)
  })
  for (const t of TARGETS) {
    it(`${t.file}: "${t.qContains.slice(0, 32)}..." leads with the proposed answer`, () => {
      const h = read(t.file)
      const vis = visiblePairs(h).find((p) => p.q.includes(t.qContains))
      const ld = ldPairs(h).find((p) => p.q.includes(t.qContains))
      expect(vis, `visible FAQ not found: ${t.qContains}`).toBeTruthy()
      expect(ld, `JSON-LD FAQ not found: ${t.qContains}`).toBeTruthy()
      // served visible answer equals the proposed text
      expect(vis!.a).toBe(t.proposed)
      // JSON-LD answer equals the visible answer
      expect(ld!.a).toBe(vis!.a)
      // the old wording is gone from the whole page
      expect(h.includes(t.old), `old wording still present: ${t.old}`).toBe(false)
    })
  }
})

