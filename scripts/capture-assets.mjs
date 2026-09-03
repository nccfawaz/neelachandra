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
//   node scripts/capture-assets.mjs --missing  (fetch only what is absent, merge)
//
// --missing exists because a plain re-run rewrites assets-manifest.json wholesale
// with a new capturedAt, which would destroy the record of what the live host
// served on the original capture date. That record is the evidence base for the
// content queries, so amendments are merged and dated instead of overwriting.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assetRefs } from './lib/normalise.mjs'
import { ORIGIN } from './lib/pages.mjs'

const args = process.argv.slice(2)
const argOrigin = args.find(a => a.startsWith('--origin='))
const origin = argOrigin ? argOrigin.split('=')[1] : ORIGIN
const verifyOnly = args.includes('--verify')
const missingOnly = args.includes('--missing')

if (verifyOnly && missingOnly) {
  console.error('--verify and --missing are mutually exclusive.')
  process.exit(2)
}

const GOLDEN = path.resolve('legacy/golden')
const OUT = path.join(GOLDEN, 'assets')
const MANIFEST = path.join(GOLDEN, 'assets-manifest.json')

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

// Collect same-origin references from every captured page, plus the icons and
// manifest entries the infra files point at.
function collect () {
  const pages = fs.readdirSync(GOLDEN).filter(f => f.endsWith('.html'))
  const refs = new Set()
  const originHost = new URL(origin).host
  for (const p of pages) {
    const html = fs.readFileSync(path.join(GOLDEN, p), 'utf8')
    for (const r of assetRefs(html)) {
      if (!r || r.startsWith('#') || /^data:/i.test(r)) continue
      // Same-origin decided by comparing hosts, not by the syntactic form of
      // the reference. og.webp is emitted as "/og.webp" on five pages and as
      // "https://neelachandra.com/og.webp" on the other five; skipping every
      // absolute URL meant a file referenced ONLY in the absolute form would
      // never be mirrored.
      let ref = r
      if (/^\/\//.test(ref)) ref = 'https:' + ref
      if (/^https?:/i.test(ref)) {
        let u
        try { u = new URL(ref) } catch { continue }
        if (u.host !== originHost) continue
        ref = u.pathname + u.search
      }
      refs.add(ref.split('#')[0])
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
  console.log(verifyOnly ? 'Mode: verify existing mirror\n'
    : missingOnly ? 'Mode: fetch absent references only, merge into manifest\n'
    : 'Mode: download\n')

  // In verify mode, load the recorded run so that assets the live host itself
  // could not serve are reported as KNOWN 404 rather than as mirror damage.
  // Without this the check can never pass and stops being read. See CQ-5.
  let known = new Map()
  let prev = null
  if (verifyOnly || missingOnly) {
    if (!fs.existsSync(MANIFEST)) {
      console.error(`No manifest at ${MANIFEST}. Run without --verify/--missing first.`)
      process.exit(1)
    }
    prev = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    known = new Map((prev.assets ?? []).map(a => [a.path, a]))
  }

  const records = []
  const added = []
  let ok = 0, failed = 0, skipped = 0, untouched = 0

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

    if (missingOnly) {
      const rec = known.get(ref)
      // Already mirrored: keep the original record untouched. Re-hashing and
      // rewriting it would make an amendment run look like a fresh capture.
      if (fs.existsSync(dest)) { untouched++; continue }
      // Recorded as a 404 on the live host at capture time. Not retried: the
      // recorded status is evidence cited by CQ-5, and silently converting it
      // would erase the finding. Retry explicitly with a full run if wanted.
      if (rec && rec.error) { console.log(`  known 404, not retried  ${shortName}`); skipped++; continue }
      // Everything else is a genuine gap: no file, no record.
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
      const record = {
        path: ref,
        status: res.status,
        bytes: buf.length,
        contentType: res.headers.get('content-type') ?? null,
        sha256: sha256(buf)
      }
      if (missingOnly) record.capturedAt = new Date().toISOString()
      records.push(record)
      if (missingOnly) added.push(ref)
      console.log(`  ok ${String(buf.length).padStart(8)}  ${shortName}`)
      ok++
    } catch (err) {
      console.log(`  ERROR    ${shortName}  ${err.message}`)
      records.push({ path: ref, error: err.message })
      failed++
    }
  }

  if (missingOnly) {
    // Merge, never replace. The original capturedAt is the date the live site
    // was mirrored and is cited as evidence elsewhere, so it is preserved and
    // each amendment is appended to an audit trail with its own date and the
    // reason the reference had been invisible.
    const merged = new Map((prev.assets ?? []).map(a => [a.path, a]))
    for (const r of records) merged.set(r.path, r)
    const assets = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path))
    const amendments = [...(prev.amendments ?? [])]
    if (records.length) {
      amendments.push({
        at: new Date().toISOString(),
        origin,
        reason: 'assetRefs() did not scan CSS url() or <meta content>, so these '
          + 'references were never requested at capture time. See DECISIONS.md 5.1.',
        added: records.map(r => ({ path: r.path, bytes: r.bytes ?? null, error: r.error ?? null }))
      })
    }
    fs.writeFileSync(MANIFEST, JSON.stringify({
      capturedAt: prev.capturedAt,
      origin: prev.origin ?? origin,
      tool: 'capture-assets.mjs',
      note: prev.note,
      total: refs.length,
      amendments,
      assets
    }, null, 2) + '\n')
  } else if (!verifyOnly) {
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
  console.log(`\nok: ${ok}  failed: ${failed}  known 404 upstream: ${skipped}` +
    (missingOnly ? `  already mirrored: ${untouched}` : ''))
  console.log(missingOnly
    ? `newly mirrored: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`
    : `total mirrored: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  if (!verifyOnly) console.log(`manifest: ${path.relative(process.cwd(), MANIFEST)}`)

  if (failed > 0) {
    console.log(verifyOnly
      ? '\nMirror is damaged or incomplete. Do not trust it as the reference.'
      : '\nSome assets did not mirror. Resolve before any irreversible removal.')
    process.exit(1)
  }
  if (missingOnly) {
    console.log(added.length
      ? `\n${added.length} previously invisible reference(s) mirrored. Run --verify next.`
      : '\nNothing missing. Every reference already has a file or a recorded 404.')
    return
  }
  if (skipped > 0) {
    console.log(`\nMirror intact. ${skipped} reference(s) 404 on the live host itself; see CQ-5.`)
  } else {
    console.log('\nAll referenced same-origin assets mirrored.')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
