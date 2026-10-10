import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGES, ORIGIN } from '../../scripts/lib/pages.mjs'

/**
 * PHASE 1A gates: og:url == canonical, the hand-maintained root sitemap, internal
 * inbound-link coverage, and JSON-LD/visible FAQ parity. All read the served bytes
 * (the deployed artifact), the sitemap from the repo root.
 */

function servedFile(path: string): string {
  return path === '/' ? 'index.html' : path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
}
const read = (f: string) => readFileSync(resolve(__dirname, '../../', f), 'utf8')
const pages = PAGES.map((p: { slug: string; path: string }) => ({ slug: p.slug, path: p.path, file: servedFile(p.path), raw: read(servedFile(p.path)) }))
const PATHS = new Set<string>(PAGES.map((p: { path: string }) => p.path))

describe('phase 1a: og:url equals canonical', () => {
  for (const p of pages) {
    it(`${p.file}: primary og:url equals canonical`, () => {
      const canon = p.raw.match(/<link rel="canonical" href="([^"]+)">/i)?.[1]
      const ogurl = p.raw.match(/<meta property="og:url" content="(https:\/\/[^"]+)">/i)?.[1]
      expect(canon, `${p.file} canonical missing`).toBeTruthy()
      expect(ogurl, `${p.file} filled og:url missing`).toBe(canon)
    })
  }
})

describe('phase 1a: root sitemap.xml', () => {
  const sm = read('sitemap.xml')
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  const urls = [...sm.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0])

  it('lists exactly the PAGES set as https://neelachandra.com/<path>', () => {
    const expected = new Set([...PATHS].map((pt) => (pt === '/' ? `${ORIGIN}/` : `${ORIGIN}${pt}`)))
    expect(new Set(locs)).toEqual(expected)
    expect(locs.length).toBe(PAGES.length)
  })
  it('every lastmod is YYYY-MM-DD and not in the future', () => {
    const today = new Date().toISOString().slice(0, 10)
    const mods = urls.map((u) => u.match(/<lastmod>([^<]*)<\/lastmod>/)?.[1] ?? '')
    expect(mods.length).toBe(PAGES.length)
    for (const d of mods) {
      expect(d, `bad lastmod "${d}"`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(d <= today, `lastmod ${d} is in the future (today ${today})`).toBe(true)
    }
  })
})

describe('phase 1a: internal link coverage', () => {
  const ALIAS: Record<string, string> = { '/about': '/about-us', '/contact': '/contact-us', '/privacy': '/privacy-policy', '/home': '/', '/index': '/' }
  // Known non-page internal targets. /login is allowed FOR NOW, pending decision.
  const INFRA = new Set(['/robots.txt', '/sitemap.xml', '/site.webmanifest', '/humans.txt', '/llms.txt', '/llms-full.txt', '/security.txt', '/.well-known/security.txt', '/login'])
  function norm(h: string): string | null {
    let s = h.trim().replace(/^https?:\/\/(www\.)?neelachandra\.com/i, '')
    if (/^(tel:|mailto:|https?:|javascript:|#)/i.test(s)) return null
    if (!s.startsWith('/')) return null
    s = s.split('#')[0].split('?')[0].replace(/\.html$/i, '')
    if (s !== '/' && s.endsWith('/')) s = s.replace(/\/+$/, '')
    if (s === '') s = '/'
    return ALIAS[s] ?? s
  }
  const inbound: Record<string, number> = {}
  for (const pt of PATHS) inbound[pt] = 0
  const broken: string[] = []
  for (const p of pages) {
    for (const m of p.raw.matchAll(/<a\s[^>]*href="([^"]*)"/gi)) {
      const t = norm(m[1])
      if (t === null) continue
      if (PATHS.has(t)) { if (t !== p.path) inbound[t]++ }
      else if (!INFRA.has(t)) broken.push(`${p.file} -> ${m[1]}`)
    }
  }
  it('every internal href resolves to a PAGES path or a known infra file', () => {
    expect(broken, `unresolved internal links:\n${broken.join('\n')}`).toEqual([])
  })
  it('every page has at least 3 inbound internal links from other pages', () => {
    const low = Object.entries(inbound).filter(([, n]) => n < 3).map(([pt, n]) => `${pt}: ${n}`)
    expect(low, `pages under 3 inbound:\n${low.join('\n')}`).toEqual([])
  })
})

describe('phase 1a: FAQ parity (JSON-LD FAQPage equals the visible accordion)', () => {
  const dec = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  function visiblePairs(h: string) {
    const out: { q: string; a: string }[] = []
    const r1 = /<h3 class="accordion-heading">\s*(?:<strong>)?\s*Q:\s*([\s\S]*?)\s*(?:<\/strong>)?\s*<\/h3>[\s\S]*?<div class="accordion-item-content">([\s\S]*?)<\/div>/gi
    const r2 = /<details[^>]*class="faq-item"[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-answer">([\s\S]*?)<\/div>/gi
    const r3 = /<details[^>]*class="bng-faq-item"[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/gi
    let m
    while ((m = r1.exec(h))) out.push({ q: dec(m[1]), a: dec(m[2]).replace(/^A:\s*/, '') })
    while ((m = r2.exec(h))) out.push({ q: dec(m[1]), a: dec(m[2]) })
    while ((m = r3.exec(h))) out.push({ q: dec(m[1]), a: dec(m[2]) })
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
  // Non-zero floor: at least one page carries FAQs, so the parity check has real input.
  it('finds FAQ pages to check (floor)', () => {
    expect(pages.filter((p) => ldPairs(p.raw).length > 0).length).toBeGreaterThan(3)
  })
  for (const p of pages) {
    it(`${p.file}: JSON-LD FAQ set and answers match the visible accordion`, () => {
      const ld = ldPairs(p.raw)
      const vis = visiblePairs(p.raw)
      const lk = new Set(ld.map((x) => key(x.q)))
      const vk = new Set(vis.map((x) => key(x.q)))
      expect([...lk].filter((k) => !vk.has(k)), `${p.file}: JSON-LD-only questions`).toEqual([])
      expect([...vk].filter((k) => !lk.has(k)), `${p.file}: visible-only questions`).toEqual([])
      const vmap = new Map(vis.map((x) => [key(x.q), x.a]))
      const mism = ld.filter((x) => vmap.has(key(x.q)) && vmap.get(key(x.q)) !== x.a).map((x) => x.q)
      expect(mism, `${p.file}: answers differ between JSON-LD and visible`).toEqual([])
    })
  }
})


