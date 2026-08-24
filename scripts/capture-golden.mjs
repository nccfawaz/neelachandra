#!/usr/bin/env node
/**
 * capture-golden.mjs  --  SPEC 5, PHASE 0, STEP 1a.
 *
 * Saves the live rendered HTML and screenshots of every public page to
 * legacy/golden/. This is the reference for the design and content freeze
 * (spec 3.2) and the acceptance criteria for the phase 1 and phase 8 gates.
 *
 * RUN THIS BEFORE THE HOSTINGER WEBSITE IS REMOVED.
 * Removing a website to deploy a Node app is irreversible and destroys files,
 * databases and email. After that point the live site does not exist and this
 * capture CANNOT be recreated. If it was not taken, the freeze is permanently
 * unverifiable.
 *
 *   node scripts/capture-golden.mjs                 # HTML + screenshots
 *   node scripts/capture-golden.mjs --html-only     # no browser needed
 *   NCC_ORIGIN=https://staging.neelachandra.com node scripts/capture-golden.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PAGES, VIEWPORTS, INFRA_FILES, ORIGIN, urlFor } from './lib/pages.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const GOLDEN = join(ROOT, 'legacy', 'golden')
const SHOTS = join(GOLDEN, 'shots')
const INFRA = join(GOLDEN, 'infra')
const htmlOnly = process.argv.includes('--html-only')

const sha = s => createHash('sha256').update(s).digest('hex')

async function fetchText (url, tries = 3) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'NCC-golden-capture/1.0 (+parity gate)' },
      })
      const body = await res.text()
      return { status: res.status, url: res.url, body,
        contentType: res.headers.get('content-type') ?? null }
    } catch (e) {
      lastErr = e
      if (i < tries) await new Promise(r => setTimeout(r, 700 * i))
    }
  }
  throw lastErr
}

async function main () {
  await mkdir(SHOTS, { recursive: true })
  await mkdir(INFRA, { recursive: true })

  console.log(`\nCapturing golden masters from ${ORIGIN}`)
  console.log(`${PAGES.length} pages, ${INFRA_FILES.length} infra files, ` +
    `${htmlOnly ? 'no screenshots (--html-only)' : VIEWPORTS.length + ' viewports'}\n`)

  const manifest = {
    capturedAt: new Date().toISOString(),
    origin: ORIGIN,
    tool: 'capture-golden.mjs',
    note: 'Reference for the design and content freeze. See spec 3.2. Irreplaceable after Hostinger website removal.',
    pages: [],
    infra: [],
    screenshots: [],
  }

  let failed = 0

  // ---- Pages -------------------------------------------------------------
  for (const { slug, path } of PAGES) {
    const url = urlFor(path)
    try {
      const r = await fetchText(url)
      if (r.status !== 200) {
        console.log(`  FAIL  ${slug.padEnd(10)} ${path}  status ${r.status}`)
        failed++
        continue
      }
      await writeFile(join(GOLDEN, `${slug}.html`), r.body, 'utf8')
      manifest.pages.push({ slug, path, requestUrl: url, finalUrl: r.url,
        status: r.status, bytes: Buffer.byteLength(r.body), sha256: sha(r.body) })
      console.log(`  ok    ${slug.padEnd(10)} ${String(Buffer.byteLength(r.body)).padStart(7)} bytes  ${path}`)
    } catch (e) {
      console.log(`  ERROR ${slug.padEnd(10)} ${path}  ${e.message}`)
      failed++
    }
  }

  // ---- Infra files -------------------------------------------------------
  console.log('')
  for (const path of INFRA_FILES) {
    const url = urlFor(path)
    try {
      const r = await fetchText(url)
      const name = path.replace(/^\/+/, '').replace(/\//g, '__') || 'root'
      // Record 404s too: knowing a file is absent today is as useful as the
      // file itself, because it stops someone "restoring" something that
      // never existed.
      if (r.status === 200) await writeFile(join(INFRA, name), r.body, 'utf8')
      manifest.infra.push({ path, status: r.status,
        bytes: r.status === 200 ? Buffer.byteLength(r.body) : 0,
        sha256: r.status === 200 ? sha(r.body) : null,
        contentType: r.contentType })
      console.log(`  ${r.status === 200 ? 'ok   ' : r.status}  ${path}`)
    } catch (e) {
      console.log(`  ERROR ${path}  ${e.message}`)
    }
  }

  // ---- Screenshots -------------------------------------------------------
  if (!htmlOnly) {
    console.log('')
    let chromium
    try {
      ({ chromium } = await import('playwright'))
    } catch {
      console.log('  playwright not installed, skipping screenshots.')
      console.log('  npm i -D playwright && npx playwright install chromium')
    }
    if (chromium) {
      const browser = await chromium.launch()
      try {
        for (const width of VIEWPORTS) {
          const ctx = await browser.newContext({
            viewport: { width, height: 900 },
            deviceScaleFactor: 1,
            // Freeze animation and lazy-load nondeterminism.
            reducedMotion: 'reduce',
          })
          const page = await ctx.newPage()
          for (const { slug, path } of PAGES) {
            const url = urlFor(path)
            try {
              await page.goto(url, { waitUntil: 'load', timeout: 60000 })
              // Scroll through to trigger IntersectionObserver reveals and
              // lazy images, then return to top, so the screenshot is the
              // settled page rather than a half-revealed one.
              await page.evaluate(async () => {
                await new Promise(res => {
                  let y = 0
                  const step = () => {
                    y += window.innerHeight
                    window.scrollTo(0, y)
                    if (y < document.body.scrollHeight) setTimeout(step, 60)
                    else { window.scrollTo(0, 0); setTimeout(res, 400) }
                  }
                  step()
                })
              })
              await page.waitForTimeout(500)
              const file = join(SHOTS, `${slug}-${width}.png`)
              await page.screenshot({ path: file, fullPage: true })
              manifest.screenshots.push({ slug, width, file: `shots/${slug}-${width}.png` })
              console.log(`  shot  ${slug.padEnd(10)} ${width}px`)
            } catch (e) {
              console.log(`  ERROR shot ${slug} ${width}px  ${e.message}`)
              failed++
            }
          }
          await ctx.close()
        }
      } finally {
        await browser.close()
      }
    }
  }

  await writeFile(join(GOLDEN, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(`\n${manifest.pages.length}/${PAGES.length} pages, ` +
    `${manifest.infra.filter(i => i.status === 200).length}/${INFRA_FILES.length} infra files, ` +
    `${manifest.screenshots.length} screenshots`)
  console.log(`manifest: legacy/golden/manifest.json`)

  if (failed > 0) {
    console.log(`\n${failed} failure(s). Do NOT treat this capture as complete.`)
    process.exit(1)
  }
  console.log('\nCapture complete. Commit legacy/golden/ and keep it permanently.')
}

main().catch(e => { console.error(e); process.exit(1) })
