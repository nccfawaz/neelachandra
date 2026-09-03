#!/usr/bin/env node
/**
 * selftest-parity.mjs
 *
 * Proves the parity gate actually catches violations. A gate that never fails
 * is worse than no gate, because it manufactures false confidence.
 *
 * Applies known mutations to a golden master and asserts each is detected by
 * at least one check. Every mutation is verified to have actually changed the
 * HTML before it is evaluated: a mutation whose pattern silently failed to
 * match would otherwise look like a passing test.
 *
 * A mutation may also name the `axis` that must catch it. That exists because
 * "caught by something" hid a real hole: the only asset mutation here renamed
 * a string whose first occurrence is inside JSON-LD, so it was caught by the
 * ld-values axis while the asset axis scored zero — assetRefs() had no
 * coverage at all, and three hero images plus og.webp were lost through
 * mechanisms it never scanned. Naming the axis makes that failure visible.
 *
 *   node scripts/selftest-parity.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { textNodes, elementSequence, jsonLdNodes, jsonLdPayload, seoFields, assetRefs, diffSequences }
  from './lib/normalise.mjs'

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." with
// a leading slash, which join() turns into "\C:\..." and fs resolves against
// the current drive as "C:\C:\...". The gate then cannot even find its own
// fixture. POSIX behaviour is unchanged.
const GOLDEN = join(fileURLToPath(new URL('..', import.meta.url)), 'legacy', 'golden')

const MUTATIONS = [
  { name: 'control (byte-identical)', expectCaught: false, fn: h => h },
  { name: 'copy edit in body text', expectCaught: true,
    fn: h => h.replace('Zero Hidden Costs', 'No Hidden Costs') },
  { name: 'copy edit, one word', expectCaught: true,
    fn: h => h.replace('Transparent', 'Clear') },
  { name: 'div -> section swap', expectCaught: true,
    fn: h => h.replace('<div class="accordion-item"', '<section class="accordion-item"') },
  { name: 'class renamed', expectCaught: true,
    fn: h => h.replace('class="pricing-title"', 'class="package-title"') },
  { name: 'class dropped', expectCaught: true,
    fn: h => h.replace(' class="pricing-price"', '') },
  { name: 'wrapper div added (nesting depth)', expectCaught: true,
    fn: h => h.replace('<div class="accordion-item"', '<div class="wrap"><div class="accordion-item"') },
  { name: 'json-ld node type changed', expectCaught: true,
    fn: h => h.replace('"FAQPage"', '"QAPage"') },
  { name: 'json-ld price changed', expectCaught: true,
    fn: h => h.replace('"price": "2299"', '"price": "2399"') },
  { name: 'json-ld rating changed', expectCaught: true,
    fn: h => h.replace('"ratingValue": "4.8"', '"ratingValue": "4.9"') },
  { name: 'title changed', expectCaught: true,
    fn: h => h.replace(/<title>([^<]*)<\/title>/, '<title>$1 Best</title>') },
  { name: 'meta description changed', expectCaught: true,
    fn: h => h.replace('Fixed pricing', 'Fixed price') },
  { name: 'canonical changed', expectCaught: true,
    fn: h => h.replace('rel="canonical" href="https://neelachandra.com/construction-packages-in-bengaluru"',
                       'rel="canonical" href="https://neelachandra.com/packages"') },
  { name: 'json-ld image url changed', expectCaught: true, axis: 'ldValues',
    // Renames the FIRST occurrence of logo.svg, which is inside an ImageObject
    // in the JSON-LD, not the <img src>. Named accordingly: this is not
    // coverage for the asset axis. The four mutations below are.
    fn: h => h.replace('logo.svg', 'logo-new.svg') },
  { name: 'asset: img src renamed', expectCaught: true, axis: 'assets',
    fn: h => h.replace('src="/assets/images/header/logo.svg"',
                       'src="/assets/images/header/logo-v2.svg"') },
  { name: 'asset: css url() bg image renamed', expectCaught: true, axis: 'assets',
    // The hero webp is referenced ONLY from a background-image in an inline
    // <style> block. Nothing else on the page mentions it, so this isolates
    // the CSS url() scanner: before it existed, this mutation was invisible
    // to every axis and the file was never even mirrored.
    fn: h => h.replace('url("/assets/images/packages/hero.webp")',
                       'url("/assets/images/packages/hero-v2.webp")') },
  { name: 'asset: og:image renamed', expectCaught: true, axis: 'assets',
    // og.webp is referenced by nothing but the social meta tags. Spec 7.5
    // item 6 requires it to survive byte-identical, and it too was missing
    // from the mirror until <meta content> was scanned.
    fn: h => h.replace('content="/og.webp"', 'content="/og-v2.webp"') },
  { name: 'asset: srcset candidate renamed', expectCaught: true, axis: 'assets',
    // srcset used to be stored as one opaque attribute string, so a candidate
    // swap inside it was only caught by accident.
    fn: h => h.replace('srcset="/assets/images/home/faq.webp"',
                       'srcset="/assets/images/home/faq-2x.webp"') },
  { name: 'whitespace reflow only', expectCaught: false,
    fn: h => h.replace(/>\s+</g, '>\n  <') },
  { name: 'attribute order swapped', expectCaught: false,
    fn: h => h.replace('<meta charset="UTF-8">', '<meta  charset="UTF-8" >') },
]

function checksFor (golden, actual) {
  const gLd = jsonLdNodes(golden).map(n => `${n['@type']}|${n['@id'] ?? ''}`).sort()
  const aLd = jsonLdNodes(actual).map(n => `${n['@type']}|${n['@id'] ?? ''}`).sort()
  const gSeo = seoFields(golden), aSeo = seoFields(actual)
  const keys = Object.keys(gSeo)
  return {
    text: diffSequences(textNodes(golden), textNodes(actual)).count,
    dom: diffSequences(elementSequence(golden), elementSequence(actual)).count,
    ldNodes: diffSequences(gLd, aLd).count,
    ldValues: diffSequences(jsonLdPayload(golden), jsonLdPayload(actual)).count,
    seo: diffSequences(keys.map(k => `${k}=${gSeo[k] ?? ''}`), keys.map(k => `${k}=${aSeo[k] ?? ''}`)).count,
    assets: diffSequences(assetRefs(golden), assetRefs(actual)).count,
  }
}

const golden = await readFile(join(GOLDEN, 'packages.html'), 'utf8')
let pass = 0, fail = 0

console.log('\nParity gate self-test  (fixture: legacy/golden/packages.html)\n')
console.log('  result   mutation                             text  dom  ldN  ldV  seo  ast  axis')
console.log('  ' + '-'.repeat(84))

for (const mut of MUTATIONS) {
  const actual = mut.fn(golden)

  // A mutation that did not change the HTML tells us nothing. Fail loudly
  // rather than reporting a meaningless pass.
  if (mut.expectCaught && actual === golden) {
    console.log(`  BROKEN   ${mut.name.padEnd(35)}  mutation pattern did not match the fixture`)
    fail++
    continue
  }

  const c = checksFor(golden, actual)
  const caught = Object.values(c).some(n => n > 0)
  // When a mutation names an axis, that axis must be the one that fires.
  // Otherwise an axis can lose all its coverage without any test going red.
  const axisOk = !mut.axis || c[mut.axis] > 0
  const ok = caught === mut.expectCaught && axisOk
  ok ? pass++ : fail++

  const why = !axisOk ? `   <-- ${mut.axis} axis reported 0; another axis caught it`
    : ok ? '' : `   <-- expected ${mut.expectCaught ? 'CAUGHT' : 'ignored'}`
  console.log(`  ${(ok ? 'ok' : 'FAIL').padEnd(7)}  ${mut.name.padEnd(35)}` +
    [c.text, c.dom, c.ldNodes, c.ldValues, c.seo, c.assets]
      .map(n => String(n).padStart(4)).join(' ') +
    `  ${(mut.axis ?? '-').padEnd(8)}` + why)
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
if (fail) {
  console.log('  The gate does not behave as specified. Fix it before trusting it.\n')
  process.exit(1)
}
console.log('  Gate verified: catches copy, DOM, JSON-LD, SEO and asset changes,')
console.log('  including assets referenced only from CSS url(), <meta content>')
console.log('  and srcset; ignores whitespace and attribute-order noise.\n')
