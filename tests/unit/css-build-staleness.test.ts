import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The build-artifact staleness tripwire (DECISIONS 29.61).
 *
 * The /app stylesheet is vite's minified build of src/dashboard/assets/css/
 * into public/assets/css/ (vite.config.ts). The artifact is COMMITTED, because
 * the production deployment copies repo files and runs nothing — an uncommitted
 * artifact would leave the deploy serving whatever the last committer happened
 * to have built. Committed artifacts rot in a specific way: the source moves
 * and the artifact does not. This test fails the moment they diverge.
 *
 * Matching must survive minification, which legitimately rewrites syntax
 * without changing meaning: `#ffffff` becomes `#fff`, single quotes become
 * double, whitespace collapses. Both sides are therefore normalised (hex
 * colours expanded to six digits, quotes unified, whitespace collapsed) before
 * comparison. A declaration in the source that is absent from the build after
 * normalisation means the build is stale — proven red by editing the source
 * without rebuilding.
 */
const src = readFileSync(resolve(__dirname, '../../src/dashboard/assets/css/dashboard.css'), 'utf8')
const built = readFileSync(resolve(__dirname, '../../public/assets/css/dashboard.css'), 'utf8')

/** Minify-equivalent normalisation: expand 3-digit hex, unify quotes, drop whitespace except inside values that need a separator (e.g. '0 0.5rem'). */
function normalise(s: string): string {
  return s
    .replace(/#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])\b/g, (_, r, g, b) => `#${r}${r}${g}${g}${b}${b}`.toLowerCase())
    .replace(/'/g, '"')
    .replace(/\s*:\s*/g, ':')   // colon spacing never survives minify
    .replace(/([\s:,(])0\./g, '$1.') // 0.5rem -> .5rem, the minifier's zero-trim
    .replace(/([\s:,(])-0\./g, '$1-.') // -0.01em -> -.01em
    .replace(/,\s*/g, ',')   // minify eats the space after a comma
    .replace(/\s*!\s*important/g, '!important')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** Every `prop: value` declaration in the source, comments stripped first. */
function declarations(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const block of noComments.matchAll(/\{([^{}]*)\}/g)) {
    for (const decl of block[1].split(';')) {
      const d = decl.trim().replace(/\s*:\s*/, ':').replace(/\s+/g, ' ')
      if (d && d.includes(':')) out.push(d)
    }
  }
  return out
}

describe('the committed stylesheet build is not stale', () => {
  const srcDecls = declarations(src).map(normalise)
  const builtCss = normalise(built)

  it('finds a real number of declarations in the source (non-zero floor)', () => {
    expect(srcDecls.length).toBeGreaterThan(50)
  })

  it('carries every source declaration into the built artifact', () => {
    const missing = srcDecls.filter((d) => !builtCss.includes(d))
    expect(
      missing,
      `public/assets/css/dashboard.css is STALE — ${missing.length} declaration(s) in the source are absent from the build. Run: node node_modules/vite/bin/vite.js build`,
    ).toEqual([])
  })
})
