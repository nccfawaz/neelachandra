// Assemble the deployable static site at the repository root.
//
// WHY THE ROOT
// Hostinger serves this repository's root directory as the web root on the
// staging domain. Probing it confirmed /NCC_BUILD_SPEC.md and
// /legacy/golden/home.html both returned 200, so the specification, the golden
// masters and the tooling were publicly downloadable and no site existed.
// Page files therefore have to sit at the root, and .htaccess has to deny
// everything that is not part of the site.
//
// FREEZE
// Pages are copied byte-for-byte from legacy/golden. No markup, copy, CSS or
// asset is rewritten here. The only page-level transform is the filename:
// home.html becomes index.html so the server resolves "/". Anything that
// changes bytes must go through a content query, not this script.
//
// Usage:
//   node scripts/build-site.mjs
//   node scripts/build-site.mjs --check   (verify deployed files match golden)

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PAGES } from './lib/pages.mjs'

const checkOnly = process.argv.includes('--check')
const GOLDEN = path.resolve('legacy/golden')
const ROOT = path.resolve('.')
const sha = b => crypto.createHash('sha256').update(b).digest('hex')

// Filename at the web root, derived from the page's PUBLIC URL, not its
// internal slug. The two differ for most pages: slug "about" is served at
// /about-us, slug "projects" at /best-construction-company-in-bengaluru-projects.
//
// An earlier version named files after the slug. The extensionless rewrite maps
// /about-us to about-us.html, so eight of the ten pages 404d; only terms and
// privacy-policy happened to line up. Caught by scripts/test-htaccess.mjs.
function pageFile (page) {
  if (page.path === '/') return 'index.html'
  return page.path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
}

function copy (from, to, label, results) {
  if (!fs.existsSync(from)) { results.missing.push(label); return }
  const src = fs.readFileSync(from)
  if (checkOnly) {
    if (!fs.existsSync(to)) { results.missing.push(label); return }
    sha(fs.readFileSync(to)) === sha(src) ? results.ok.push(label) : results.differs.push(label)
    return
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, src)
  results.ok.push(label)
}

const results = { ok: [], differs: [], missing: [], skipped: [] }

// 1. Pages, verbatim from the golden masters.
for (const p of PAGES) {
  copy(path.join(GOLDEN, `${p.slug}.html`), path.join(ROOT, pageFile(p)),
    `page ${p.slug} -> ${pageFile(p)}`, results)
}

// 2. Mirrored same-origin assets, preserving their original URL paths.
//
// site.webmanifest is deliberately NOT copied from the mirror. The captured
// original points both of its icons at /favicon.ico/web-app-manifest-*.png,
// treating a 15 KB icon file as a directory, so both 404 and the site has no
// working PWA icons (CQ-5). The corrected file is maintained by hand at the
// repository root. Copying the mirror over it would silently reintroduce the
// defect on every build.
const SKIP_FROM_MIRROR = new Set(['site.webmanifest'])

const ASSETS = path.join(GOLDEN, 'assets')
function walk (dir, rel = '') {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue }
    if (SKIP_FROM_MIRROR.has(r)) { results.skipped.push(`/${r} (corrected by hand, CQ-5)`); continue }
    copy(path.join(dir, e.name), path.join(ROOT, r), `asset /${r}`, results)
  }
}
walk(ASSETS)

// 3. Infrastructure files. Names map back to the URL they are served from.
// robots.txt and site.webmanifest are written by hand elsewhere in the tree
// because both needed correcting (CQ-2, CQ-5); everything else is verbatim.
const INFRA = [
  ['sitemap.xml', 'sitemap.xml'],
  ['humans.txt', 'humans.txt'],
  ['llms.txt', 'llms.txt'],
  ['llms-full.txt', 'llms-full.txt'],
  ['097ee841c58a4b25b8eb2c348ca67dce.txt', '097ee841c58a4b25b8eb2c348ca67dce.txt'],
  ['google9706eb5d9d6a7b15.html', 'google9706eb5d9d6a7b15.html'],
  ['.well-known__security.txt', '.well-known/security.txt']
]
for (const [src, dest] of INFRA) {
  copy(path.join(GOLDEN, 'infra', src), path.join(ROOT, dest), `infra /${dest}`, results)
}

console.log(checkOnly ? 'Mode: check\n' : 'Mode: write\n')
console.log(`ok: ${results.ok.length}  differs: ${results.differs.length}  missing: ${results.missing.length}  skipped: ${results.skipped.length}`)
for (const d of results.differs) console.log(`  DIFFERS  ${d}`)
for (const m of results.missing) console.log(`  MISSING  ${m}`)
for (const s of results.skipped) console.log(`  skipped  ${s}`)

if (results.differs.length || results.missing.length) {
  console.log(checkOnly
    ? '\nDeployed files do not match the golden masters. The freeze is broken.'
    : '\nSome sources were absent. Investigate before deploying.')
  process.exit(1)
}
console.log(checkOnly
  ? '\nEvery deployed page and asset is byte-identical to the golden master.'
  : '\nSite assembled at the repository root.')
