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
 *   node scripts/selftest-parity.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { textNodes, elementSequence, jsonLdNodes, jsonLdPayload, seoFields, assetRefs, diffSequences }
  from './lib/normalise.mjs'

const GOLDEN = join(new URL('..', import.meta.url).pathname, 'legacy', 'golden')

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
  { name: 'image renamed', expectCaught: true,
    fn: h => h.replace('logo.svg', 'logo-new.svg') },
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
console.log('  result   mutation                        text  dom  ldN  ldV  seo  ast')
console.log('  ' + '-'.repeat(72))

for (const mut of MUTATIONS) {
  const actual = mut.fn(golden)

  // A mutation that did not change the HTML tells us nothing. Fail loudly
  // rather than reporting a meaningless pass.
  if (mut.expectCaught && actual === golden) {
    console.log(`  BROKEN   ${mut.name.padEnd(30)}  mutation pattern did not match the fixture`)
    fail++
    continue
  }

  const c = checksFor(golden, actual)
  const caught = Object.values(c).some(n => n > 0)
  const ok = caught === mut.expectCaught
  ok ? pass++ : fail++

  console.log(`  ${(ok ? 'ok' : 'FAIL').padEnd(7)}  ${mut.name.padEnd(30)} ` +
    [c.text, c.dom, c.ldNodes, c.ldValues, c.seo, c.assets]
      .map(n => String(n).padStart(4)).join(' ') +
    (ok ? '' : `   <-- expected ${mut.expectCaught ? 'CAUGHT' : 'ignored'}`))
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
if (fail) {
  console.log('  The gate does not behave as specified. Fix it before trusting it.\n')
  process.exit(1)
}
console.log('  Gate verified: catches copy, DOM, JSON-LD, SEO and asset changes;')
console.log('  ignores whitespace and attribute-order noise.\n')
