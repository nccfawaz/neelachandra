#!/usr/bin/env node
/**
 * parity-check.mjs  --  THE FREEZE GATE. SPEC 3.2.
 *
 * Compares a candidate render (staging, or local dev) against the golden
 * masters captured in phase 0, on five axes:
 *
 *   1. visible text-node sequence   -> the COPY freeze
 *   2. element and class sequence   -> the DOM freeze
 *   3. JSON-LD node set             -> SEO markup preserved (spec 6.5 rule 7)
 *   4. head SEO fields + assets     -> title/canonical/og/image refs
 *   5. screenshots at 3 viewports   -> the DESIGN freeze
 *
 * Runs at the phase 1 gate, again at the phase 8 gate (after content moves to
 * MySQL), and in CI on every commit touching src/public/.
 *
 *   node scripts/parity-check.mjs --candidate=https://staging.neelachandra.com
 *   node scripts/parity-check.mjs --candidate=http://localhost:3000 --no-shots
 *   node scripts/parity-check.mjs --candidate=... --page=packages
 *
 * Exit 0 = freeze intact. Exit 1 = a difference needs a human decision.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { applyCorrections } from './lib/corrections.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAGES, VIEWPORTS, urlFor } from './lib/pages.mjs'
import { textNodes, elementSequence, jsonLdNodes, jsonLdPayload, seoFields, assetRefs, diffSequences } from './lib/normalise.mjs'

// fileURLToPath, not URL.pathname: see the note in selftest-parity.mjs. On
// Windows the raw pathname is "/C:/..." and every path built from it resolves
// to "C:\C:\...", so the gate cannot read the golden masters at all.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GOLDEN = join(ROOT, 'legacy', 'golden')
const OUT = join(ROOT, 'tests', 'parity-out')

const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const CANDIDATE = arg('candidate') ?? process.env.NCC_CANDIDATE
const ONLY = arg('page')
// Pixel tolerance. Spec 3.2 says 0. Raising this needs the sign-off owner
// named in 8.12, and the value used is printed in the report so a relaxed
// run can never be mistaken for a strict one.
const TOLERANCE = Number(arg('tolerance') ?? 0)
const noShots = process.argv.includes('--no-shots')

if (!CANDIDATE) {
  console.error('usage: node scripts/parity-check.mjs --candidate=https://staging.neelachandra.com')
  process.exit(2)
}
if (!existsSync(join(GOLDEN, 'manifest.json'))) {
  console.error(`\nNo golden masters at legacy/golden/.`)
  console.error(`Run scripts/capture-golden.mjs against the LIVE site first.`)
  console.error(`If the live site is already gone, the freeze cannot be verified. See spec 5 phase 0 step 1a.\n`)
  process.exit(2)
}

const pages = ONLY ? PAGES.filter(p => p.slug === ONLY) : PAGES
const results = []

function cmp (label, expected, actual) {
  const d = diffSequences(expected, actual)
  return { label, ok: d.count === 0 && d.lengthExpected === d.lengthActual, ...d }
}

// Filename at the web root, matching build-site.mjs, so corrections keyed on
// the deployed filename resolve to the same page.
function pageFile (path) {
  if (path === '/') return 'index.html'
  return path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
}

async function checkHtml (slug, path) {
  // The expected baseline is the golden master PLUS the owner-approved
  // corrections, not the raw golden master. legacy/golden stays pristine as the
  // audit record of the old site, so the corrections are applied here the same
  // way build-site.mjs applies them on the way out.
  //
  // Comparing against raw golden would report every approved correction as a
  // freeze violation, and the real signal, unintended drift, would be lost in
  // the noise. Comparing against golden-plus-corrections keeps the gate sharp:
  // anything that differs is something nobody approved.
  const raw = await readFile(join(GOLDEN, `${slug}.html`), 'utf8')
  const golden = applyCorrections(raw, pageFile(path)).html
  const url = urlFor(path, CANDIDATE)
  const res = await fetch(url, { redirect: 'follow',
    headers: { 'User-Agent': 'NCC-parity-check/1.0' } })
  const actual = await res.text()

  const checks = []
  if (res.status !== 200) {
    checks.push({ label: 'http status', ok: false, count: 1, diffs: [
      { index: 0, expected: '200', actual: String(res.status) }] })
    return { slug, path, checks }
  }

  checks.push(cmp('text nodes (copy freeze)', textNodes(golden), textNodes(actual)))
  checks.push(cmp('element+class sequence (dom freeze)', elementSequence(golden), elementSequence(actual)))

  // JSON-LD: compare as a SET, since node order in the graph is not
  // meaningful, but a missing node is.
  const gLd = jsonLdNodes(golden).map(n => `${n['@type']}|${n['@id'] ?? ''}`).sort()
  const aLd = jsonLdNodes(actual).map(n => `${n['@type']}|${n['@id'] ?? ''}`).sort()
  checks.push(cmp('json-ld nodes', gLd, aLd))

  // Deep payload: catches a changed price, rating or FAQ answer that leaves
  // the node set identical.
  checks.push(cmp('json-ld values', jsonLdPayload(golden), jsonLdPayload(actual)))

  // SEO head fields, compared field by field.
  const gSeo = seoFields(golden), aSeo = seoFields(actual)
  const seoKeys = Object.keys(gSeo)
  checks.push(cmp('seo head fields',
    seoKeys.map(k => `${k}=${gSeo[k] ?? ''}`),
    seoKeys.map(k => `${k}=${aSeo[k] ?? ''}`)))

  checks.push(cmp('asset references', assetRefs(golden), assetRefs(actual)))
  return { slug, path, checks }
}

async function checkShots () {
  let chromium, PNG, pixelmatch
  try {
    ({ chromium } = await import('playwright'))
    PNG = (await import('pngjs')).PNG
    pixelmatch = (await import('pixelmatch')).default
  } catch {
    return [{ slug: '(screenshots)', path: '-', checks: [{
      label: 'screenshot deps missing (playwright, pngjs, pixelmatch)',
      ok: null, count: 0, diffs: [] }] }]
  }
  await mkdir(OUT, { recursive: true })
  const out = []
  const browser = await chromium.launch()
  try {
    for (const width of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 },
        deviceScaleFactor: 1, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      for (const { slug, path } of pages) {
        const goldenShot = join(GOLDEN, 'shots', `${slug}-${width}.png`)
        if (!existsSync(goldenShot)) continue
        await page.goto(urlFor(path, CANDIDATE), { waitUntil: 'load', timeout: 60000 })
        await page.evaluate(async () => {
          await new Promise(res => { let y = 0
            const step = () => { y += window.innerHeight; window.scrollTo(0, y)
              if (y < document.body.scrollHeight) setTimeout(step, 60)
              else { window.scrollTo(0, 0); setTimeout(res, 400) } }
            step() })
        })
        await page.waitForTimeout(500)
        const buf = await page.screenshot({ fullPage: true })
        const g = PNG.sync.read(await readFile(goldenShot))
        const a = PNG.sync.read(buf)
        let diffPx, note = ''
        if (g.width !== a.width || g.height !== a.height) {
          diffPx = Infinity
          note = `size ${g.width}x${g.height} -> ${a.width}x${a.height}`
        } else {
          const diff = new PNG({ width: g.width, height: g.height })
          diffPx = pixelmatch(g.data, a.data, diff.data, g.width, g.height,
            { threshold: 0.1 })
          if (diffPx > TOLERANCE) {
            await writeFile(join(OUT, `${slug}-${width}-diff.png`), PNG.sync.write(diff))
            note = `diff image: tests/parity-out/${slug}-${width}-diff.png`
          }
        }
        out.push({ slug: `${slug} @${width}px`, path, checks: [{
          label: `pixels (tolerance ${TOLERANCE})`,
          ok: diffPx <= TOLERANCE, count: diffPx === Infinity ? 1 : diffPx,
          diffs: diffPx > TOLERANCE ? [{ index: 0,
            expected: `<= ${TOLERANCE} px`, actual: `${diffPx} px ${note}` }] : [] }] })
      }
      await ctx.close()
    }
  } finally { await browser.close() }
  return out
}

async function main () {
  console.log(`\nParity gate`)
  console.log(`  golden    legacy/golden/  (${(JSON.parse(await readFile(join(GOLDEN,'manifest.json'),'utf8'))).capturedAt})`)
  console.log(`  candidate ${CANDIDATE}`)
  console.log(`  pages     ${pages.length}${noShots ? ', screenshots skipped' : ''}\n`)

  for (const { slug, path } of pages) {
    try { results.push(await checkHtml(slug, path)) }
    catch (e) { results.push({ slug, path, checks: [{ label: 'fetch', ok: false,
      count: 1, diffs: [{ index: 0, expected: 'reachable', actual: e.message }] }] }) }
  }
  if (!noShots) results.push(...await checkShots())

  let failures = 0
  for (const r of results) {
    const bad = r.checks.filter(c => c.ok === false)
    const skipped = r.checks.filter(c => c.ok === null)
    if (bad.length === 0) {
      console.log(`  PASS  ${r.slug}${skipped.length ? '  (' + skipped.map(s => s.label).join(', ') + ')' : ''}`)
      continue
    }
    failures += bad.length
    console.log(`  FAIL  ${r.slug}`)
    for (const c of bad) {
      console.log(`          ${c.label}: ${c.count} difference(s)` +
        (c.lengthExpected !== undefined && c.lengthExpected !== c.lengthActual
          ? ` [count ${c.lengthExpected} -> ${c.lengthActual}]` : ''))
      for (const d of (c.diffs ?? []).slice(0, 5)) {
        console.log(`            [${d.index}] expected: ${String(d.expected).slice(0, 120)}`)
        console.log(`                  actual:   ${String(d.actual).slice(0, 120)}`)
      }
      if (c.truncated) console.log(`            ... more suppressed`)
    }
  }

  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'report.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), candidate: CANDIDATE,
      tolerance: TOLERANCE, results }, null, 2) + '\n', 'utf8')

  console.log(`\n  report  tests/parity-out/report.json`)
  if (failures) {
    console.log(`\n  ${failures} failing check(s). The freeze is broken, or the difference is`)
    console.log(`  intentional and needs written sign-off from the owner named in spec 8.12.\n`)
    process.exit(1)
  }
  console.log(`\n  Freeze intact.\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
