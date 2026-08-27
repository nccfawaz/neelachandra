// Mirror every same-origin asset the golden pages reference.
//
// WHY THIS EXISTS
// capture-golden.mjs saves HTML, infra files and screenshots. It does NOT save
// the images, stylesheets, scripts, fonts or icons that the HTML points at.
// Those binaries live only on the Hostinger host. Removing the website to free
// the domain for Node.js is irreversible, so anything not mirrored here is
// gone permanently and the ported site cannot be rebuilt to match the golden
// masters. Run this BEFORE any removal.
//
// Output: legacy/golden/assets/<original path>  plus assets-manifest.json
// with a SHA-256 and content type per file, so a later integrity check can
// prove nothing was truncated or silently replaced.
//
// Usage:
//   node scripts/capture-assets.mjs
//   node scripts/capture-assets.mjs --origin=https://neelachandra.com
//   node scripts/capture-assets.mjs --verify   (re-check existing mirror only)

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assetRefs } from './lib/normalise.mjs'
import { ORIGIN } from './lib/pages.mjs'

const args = process.argv.slice(2)
const argOrigin = args.find(a => a.startsWith('--origin='))
const origin = argOrigin ? argOrigin.split('=')[1] : ORIGIN
const verifyOnly = args.includes('--verify')

const GOLDEN = path.resolve('legacy/golden')
const OUT = path.join(GOLDEN, 'assets')
const MANIFEST = path.join(GOLDEN, 'assets-manifest.json')

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

// Collect same-origin references from every captured page, plus the icons and
// manifest entries the infra files point at.
function collect () {
  const pages = fs.readdirSync(GOLDEN).filter(f => f.endsWith('.html'))
  const refs = new Set()
  for (const p of pages) {
    const html = fs.readFileSync(path.join(GOLDEN, p), 'utf8')
    for (const r of assetRefs(html)) {
      if (/^https?:/i.test(r) || /^data:/i.test(r) || r.startsWith('//')) continue
      if (!r || r.startsWith('#')) continue
      refs.add(r.split('#')[0])
    }
  }
  // site.webmanifest lists icon paths that no page references directly.
  const wm = path.join(GOLDEN, 'infra', 'site.webmanifest')
  if (fs.existsSync(wm)) {
    try {
      const j = JSON.parse(fs.readFileSync(wm, 'utf8'))
      for (const icon of j.icons ?? []) if (icon.src) refs.add(icon.src.split('#')[0])
    } catch { /* recorded as a content query if it will not parse */ }
  }
  return [...refs].sort()
}

// Map a URL path to a safe location under assets/, preserving structure.
function localPath (urlPath) {
  const clean = urlPath.split('?')[0]
  const rel = decodeURIComponent(clean.replace(/^\/+/, ''))
  const segs = rel.split('/').filter(s => s && s !== '.' && s !== '..')
  return path.join(OUT, ...segs)
}

async function main () {
  const refs = collect()
  console.log(`Same-origin assets referenced: ${refs.length}`)
  console.log(`Origin: ${origin}`)
  console.log(verifyOnly ? 'Mode: verify existing mirror\n' : 'Mode: download\n')

  // In verify mode, load the recorded run so that assets the live host itself
  // could not serve are reported as KNOWN 404 rather than as mirror damage.
  // Without this the check can never pass and stops being read. See CQ-5.
  let known = new Map()
  if (verifyOnly) {
    if (!fs.existsSync(MANIFEST)) {
      console.error(`No manifest at ${MANIFEST}. Run without --verify first.`)
      process.exit(1)
    }
    const prev = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    known = new Map((prev.assets ?? []).map(a => [a.path, a]))
  }

  const records = []
  let ok = 0, failed = 0, skipped = 0

  for (const ref of refs) {
    const url = new URL(ref, origin).toString()
    const dest = localPath(ref)
    const shortName = ref.length > 58 ? ref.slice(0, 55) + '...' : ref

    if (verifyOnly) {
      const rec = known.get(ref)
      if (!fs.existsSync(dest)) {
        // Absent because the live host 404d at capture time is expected.
        if (rec && rec.error) { console.log(`  known 404 ${shortName}`); skipped++ }
        else { console.log(`  MISSING  ${shortName}`); failed++ }
        continue
      }
      const buf = fs.readFileSync(dest)
      const digest = sha256(buf)
      if (rec && rec.sha256 && rec.sha256 !== digest) {
        console.log(`  CORRUPT  ${shortName}  recorded ${rec.sha256.slice(0, 12)} got ${digest.slice(0, 12)}`)
        failed++
        continue
      }
      records.push({ path: ref, bytes: buf.length, sha256: digest })
      ok++
      continue
    }

    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) {
        console.log(`  HTTP ${res.status}  ${shortName}`)
        records.push({ path: ref, status: res.status, error: 'not ok' })
        failed++
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) {
        console.log(`  EMPTY    ${shortName}`)
        records.push({ path: ref, status: res.status, error: 'zero bytes' })
        failed++
        continue
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
      records.push({
        path: ref,
        status: res.status,
        bytes: buf.length,
        contentType: res.headers.get('content-type') ?? null,
        sha256: sha256(buf)
      })
      console.log(`  ok ${String(buf.length).padStart(8)}  ${shortName}`)
      ok++
    } catch (err) {
      console.log(`  ERROR    ${shortName}  ${err.message}`)
      records.push({ path: ref, error: err.message })
      failed++
    }
  }

  if (!verifyOnly) {
    fs.writeFileSync(MANIFEST, JSON.stringify({
      capturedAt: new Date().toISOString(),
      origin,
      tool: 'capture-assets.mjs',
      note: 'Same-origin binaries referenced by the golden pages. Irreplaceable after Hostinger website removal.',
      total: refs.length,
      assets: records
    }, null, 2) + '\n')
  }

  const totalBytes = records.reduce((n, r) => n + (r.bytes ?? 0), 0)
  console.log(`\nok: ${ok}  failed: ${failed}  known 404 upstream: ${skipped}`)
  console.log(`total mirrored: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  if (!verifyOnly) console.log(`manifest: ${path.relative(process.cwd(), MANIFEST)}`)

  if (failed > 0) {
    console.log(verifyOnly
      ? '\nMirror is damaged or incomplete. Do not trust it as the reference.'
      : '\nSome assets did not mirror. Resolve before any irreversible removal.')
    process.exit(1)
  }
  if (skipped > 0) {
    console.log(`\nMirror intact. ${skipped} reference(s) 404 on the live host itself; see CQ-5.`)
  } else {
    console.log('\nAll referenced same-origin assets mirrored.')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
