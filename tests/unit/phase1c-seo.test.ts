import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGES } from '../../scripts/lib/pages.mjs'

/**
 * PHASE 1C gates: no CLIENT-TO-VERIFY / "[CLIENT" / TODO placeholder tokens in any
 * served file (the PLACEHOLDER gate missed these because they do not contain the
 * word PLACEHOLDER); exactly one og:url per page equal to the canonical; and no
 * malformed closing tags like "</p[".
 */

function servedFile(path: string): string {
  return path === '/' ? 'index.html' : path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
}
const read = (f: string) => readFileSync(resolve(__dirname, '../../', f), 'utf8')
const htmlFiles = PAGES.map((p: { path: string }) => servedFile(p.path))
const servedFiles = [...htmlFiles, 'sitemap.xml', 'llms.txt', 'llms-full.txt']

describe('phase 1c: no placeholder tokens in served files', () => {
  it('scans a non-empty served set (floor)', () => {
    expect(servedFiles.length).toBe(PAGES.length + 3)
  })
  for (const tok of ['CLIENT TO VERIFY', '[CLIENT', 'TODO']) {
    it(`no served file contains "${tok}"`, () => {
      const bad = servedFiles.filter((f) => read(f).includes(tok))
      expect(bad, `"${tok}" survives in: ${bad.join(', ')}`).toEqual([])
    })
  }
})

describe('phase 1c: exactly one og:url per page, equal to canonical', () => {
  for (const f of htmlFiles) {
    it(`${f}: one og:url equal to canonical`, () => {
      const h = read(f)
      const canon = h.match(/<link rel="canonical" href="([^"]+)">/i)?.[1]
      const ogs = [...h.matchAll(/<meta property="og:url" content="([^"]*)">/gi)].map((m) => m[1])
      expect(canon, `${f}: canonical missing`).toBeTruthy()
      expect(ogs.length, `${f}: og:url count is ${ogs.length}`).toBe(1)
      expect(ogs[0], `${f}: og:url empty`).not.toBe('')
      expect(ogs[0]).toBe(canon)
    })
  }
})

describe('phase 1c: no malformed closing tags', () => {
  for (const f of htmlFiles) {
    it(`${f}: no "</tag[" malformed close`, () => {
      const bad = [...read(f).matchAll(/<\/[a-zA-Z]+\[/g)].map((m) => m[0])
      expect(bad, `malformed close tags in ${f}: ${bad.join(', ')}`).toEqual([])
    })
  }
})

describe('phase 1c: no empty array or object in served JSON-LD', () => {
  function emptiesIn(h: string): string[] {
    const bad: string[] = []
    for (const m of h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let d: unknown
      try { d = JSON.parse(m[1]) } catch { continue }
      const w = (n: unknown) => {
        if (Array.isArray(n)) { if (n.length === 0) bad.push('empty array'); n.forEach(w) }
        else if (n !== null && typeof n === 'object') {
          if (Object.keys(n as object).length === 0) bad.push('empty object')
          Object.values(n as object).forEach(w)
        }
      }
      w(d)
    }
    return bad
  }
  it('reads JSON-LD from the pages (floor)', () => {
    expect(htmlFiles.filter((f) => /application\/ld\+json/.test(read(f))).length).toBeGreaterThan(5)
  })
  for (const f of htmlFiles) {
    it(`${f}: JSON-LD has no empty [] or {} value`, () => {
      const bad = emptiesIn(read(f))
      expect(bad, `${f}: ${bad.join(', ')}`).toEqual([])
    })
  }
})
