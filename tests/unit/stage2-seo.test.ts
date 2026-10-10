import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGES } from '../../scripts/lib/pages.mjs'

/**
 * Stage 2 SEO gate (pending approval). Enforces the owner-approved title/meta
 * contract and the superlative removal on the served bytes (the deployed
 * artifact, per §29.60), so a future edit cannot reintroduce an empty title,
 * the stray "Section 5 - Floating Buttons" title, an over-length tag, a
 * duplicate, a self-ranking "best" claim, or the five-star graphic.
 *
 * All values are read from the served HTML. Only the FIRST (primary head)
 * occurrence of each meta tag is the page's SEO value; the empty duplicates the
 * Webflow section concatenation leaves in the embedded widget heads are not the
 * page's claim and are not measured here.
 */

function servedFile(path: string): string {
  return path === '/' ? 'index.html' : path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim()
}

const pages = PAGES.map((p: { slug: string; path: string }) => {
  const file = servedFile(p.path)
  const raw = readFileSync(resolve(__dirname, '../../', file), 'utf8')
  const titles = [...raw.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1])
  const first = (re: RegExp) => (raw.match(re)?.[1] ?? null)
  return {
    file,
    raw,
    titles,
    title: titles[0] ?? '',
    meta: first(/<meta name="description" content="([^"]*)"/i),
    ogTitle: first(/<meta property="og:title" content="([^"]*)"/i),
    ogDesc: first(/<meta property="og:description" content="([^"]*)"/i),
    h1: (raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').replace(/<[^>]+>/g, ''),
  }
})

const WORD_BEST = /\bbest\b/i

describe('stage 2 titles and metas', () => {
  it('scans the full canonical page set (non-zero floor)', () => {
    expect(pages.length).toBe(PAGES.length)
    expect(pages.length).toBeGreaterThan(0)
  })

  for (const p of pages) {
    it(`${p.file}: exactly one <title>`, () => {
      expect(p.titles.length, `title count in ${p.file}: ${p.titles.length}`).toBe(1)
    })
    it(`${p.file}: title length 1 to 60`, () => {
      const n = [...p.title].length
      expect(n, `title "${p.title}" is ${n} chars`).toBeGreaterThanOrEqual(1)
      expect(n, `title "${p.title}" is ${n} chars`).toBeLessThanOrEqual(60)
    })
    it(`${p.file}: meta description length 50 to 155`, () => {
      expect(p.meta, `${p.file} has no meta description`).not.toBeNull()
      const n = [...(p.meta ?? '')].length
      expect(n, `meta on ${p.file} is ${n} chars`).toBeGreaterThanOrEqual(50)
      expect(n, `meta on ${p.file} is ${n} chars`).toBeLessThanOrEqual(155)
    })
  }

  it('titles are unique across all pages', () => {
    const t = pages.map((p) => p.title)
    expect(new Set(t).size, `duplicate title among: ${t.join(' | ')}`).toBe(t.length)
  })
  it('meta descriptions are unique across all pages', () => {
    const m = pages.map((p) => p.meta)
    expect(new Set(m).size, 'duplicate meta description').toBe(m.length)
  })

  const FIELDS: [string, (p: typeof pages[number]) => string | null][] = [
    ['title', (p) => p.title],
    ['meta description', (p) => p.meta],
    ['og:title', (p) => p.ogTitle],
    ['og:description', (p) => p.ogDesc],
    ['H1', (p) => p.h1],
  ]
  for (const [name, get] of FIELDS) {
    it(`no page carries the word "best" in its ${name}`, () => {
      const bad = pages.filter((p) => { const v = get(p); return v != null && WORD_BEST.test(decode(v)) }).map((p) => p.file)
      expect(bad, `"best" survives in ${name} of: ${bad.join(', ')}`).toEqual([])
    })
  }

  it('no served page references the five-star graphic', () => {
    const bad = pages.filter((p) => /stars\.webp|Five-star/i.test(p.raw)).map((p) => p.file)
    expect(bad, `stars.webp / "Five-star" survives in: ${bad.join(', ')}`).toEqual([])
  })
})

describe('stage 2 FAQ parity (JSON-LD answer equals the visible answer)', () => {
  // Rule 4: every FAQ answer rewritten in Stage 2 must read identically in the
  // JSON-LD and in the visible accordion. The site's other FAQ answers were
  // never byte-identical across the two, so this gate pins only the fragments
  // Stage 2 actually changed: each must appear, decode-normalised, in BOTH the
  // JSON-LD and the visible body of its page.
  const parts = (file: string) => {
    const raw = pages.find((p) => p.file === file)!.raw
    const ld = decode([...raw.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join(' ').replace(/<[^>]+>/g, ' '))
    const vis = decode(raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' '))
    return { ld, vis }
  }
  const REWRITTEN: [string, string][] = [
    ['best-construction-company-in-bengaluru-projects.html', 'What construction projects has Neelachandra completed in Bengaluru?'],
    ['best-construction-company-in-bengaluru.html', 'What does Neelachandra offer for turnkey builds in Bengaluru?'],
    ['best-construction-company-in-bengaluru.html', 'a full-service construction company in Bengaluru with a strict zero cost escalation policy'],
    ['about-us.html', 'Does Neelachandra build independent houses in Bengaluru?'],
    ['about-us.html', 'specializes in turnkey residential house construction, commercial complexes, and premium interiors'],
  ]
  it('pins the rewritten FAQ fragments (non-zero floor)', () => {
    expect(REWRITTEN.length).toBeGreaterThan(4)
  })
  for (const [file, snippet] of REWRITTEN) {
    it(`${file}: "${snippet.slice(0, 40)}..." identical in JSON-LD and visible`, () => {
      const { ld, vis } = parts(file)
      expect(ld.includes(snippet), `missing from JSON-LD of ${file}`).toBe(true)
      expect(vis.includes(snippet), `missing from visible text of ${file}`).toBe(true)
    })
  }
})


describe('stage 2 no "best construction" claim (visible, alt, JSON-LD; URLs excluded)', () => {
  // The slug best-construction-company-in-bengaluru uses hyphens, so it never
  // matches the space phrase; URL-bearing attributes are stripped anyway so a
  // path can never satisfy the gate. What remains is prose, alt text and JSON-LD
  // text, where no self-ranking "best construction" claim may appear.
  function stripUrls(s: string): string {
    return s
      .replace(/\s(?:href|src|srcset)="[^"]*"/gi, ' ')
      .replace(/<link[^>]*rel=["']canonical["'][^>]*>/gi, ' ')
      .replace(/<meta[^>]*property=["']og:url["'][^>]*>/gi, ' ')
      .replace(/https?:\/\/[^\s"'<>)]+/gi, ' ')
      .replace(/\]\([^)]*\)/g, '] ')
  }
  const corpus = [
    ...pages.map((p) => ({ file: p.file, text: stripUrls(p.raw) })),
    ...['llms.txt', 'llms-full.txt'].map((f) => ({
      file: f,
      text: stripUrls(readFileSync(resolve(__dirname, '../../', f), 'utf8')),
    })),
  ]
  const RE = /best\s+construction/i

  it('scans a non-empty corpus (floor)', () => {
    expect(corpus.length).toBe(pages.length + 2)
    for (const c of corpus) expect(c.text.length).toBeGreaterThan(200)
  })
  it('no page or llms file carries "best construction" outside URLs', () => {
    const bad = corpus.filter((c) => RE.test(c.text)).map((c) => c.file)
    expect(bad, `"best construction" survives in: ${bad.join(', ')}`).toEqual([])
  })
})
