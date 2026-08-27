// Exercise the .htaccess rules against a real Apache instance.
//
// WHY THIS EXISTS
// Rewrite rules are easy to write and easy to get subtly wrong: a rule that
// loops, a redirect that chains twice, a protection rule that a later rule
// undoes. Shipping them unverified to a host that publishes straight to a live
// URL is not acceptable, so every rule gets an assertion here.
//
// Requests send X-Forwarded-Proto: https because Hostinger terminates TLS
// upstream; without it the HTTPS rule in section 1 fires on every request.
//
// Usage:
//   node scripts/test-htaccess.mjs                  (default http://localhost:8081)
//   node scripts/test-htaccess.mjs --base=https://bisque-porpoise-208310.hostingersite.com

const arg = process.argv.find(a => a.startsWith('--base='))
const BASE = arg ? arg.split('=')[1] : 'http://localhost:8081'
const remote = !BASE.includes('localhost')

const HEADERS = { 'X-Forwarded-Proto': 'https', 'User-Agent': 'ncc-htaccess-test' }

let pass = 0, fail = 0
const failures = []

// One request, no redirect following, so each hop can be asserted separately.
async function head (path) {
  const res = await fetch(BASE + path, { method: 'GET', redirect: 'manual', headers: HEADERS })
  return { status: res.status, location: res.headers.get('location'), headers: res.headers }
}

// Follows redirects and returns the body, for asserting page CONTENT rather
// than routing. Used by the corrections section.
async function get (path) {
  const res = await fetch(BASE + path, { redirect: 'follow', headers: HEADERS })
  return { status: res.status, body: await res.text() }
}

function check (label, actual, expected) {
  const ok = actual === expected
  ok ? pass++ : (fail++, failures.push(`${label}\n      expected ${expected}\n      actual   ${actual}`))
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected ${expected}  actual ${actual}`)
}

// Compare only the path so the assertions hold on any host.
function loc (l) {
  if (!l) return null
  try { return new URL(l, BASE).pathname } catch { return l }
}

async function main () {
  console.log(`Base: ${BASE}\n`)

  console.log('1. Pages resolve at their clean extensionless URL')
  for (const p of ['/', '/about-us', '/contact-us', '/terms', '/privacy-policy',
    '/construction-services-in-bengaluru', '/construction-packages-in-bengaluru',
    '/best-construction-company-in-bengaluru-projects',
    '/best-construction-company-in-bengaluru', '/construction-company-in-tumkur',
    '/login']) {
    const r = await head(p)
    check(`GET ${p}`, r.status, 200)
  }

  console.log('\n2. Extensions are stripped, permanently, in one hop')
  const stripped = [
    ['/about-us.html', '/about-us'],
    ['/about-us.php', '/about-us'],
    ['/terms.html', '/terms'],
    ['/login.html', '/login'],
    ['/index.html', '/'],
    ['/index.php', '/']
  ]
  for (const [from, to] of stripped) {
    const r = await head(from)
    check(`GET ${from} -> 301`, r.status, 301)
    check(`GET ${from} -> ${to}`, loc(r.location), to)
  }

  console.log('\n3. Trailing slashes are removed')
  for (const [from, to] of [['/about-us/', '/about-us'], ['/terms/', '/terms']]) {
    const r = await head(from)
    check(`GET ${from} -> 301`, r.status, 301)
    check(`GET ${from} -> ${to}`, loc(r.location), to)
  }

  console.log('\n4. Legacy short paths redirect (linked from projects page)')
  for (const [from, to] of [['/about', '/about-us'], ['/contact', '/contact-us'],
    ['/privacy', '/privacy-policy'], ['/home', '/'], ['/index', '/']]) {
    const r = await head(from)
    check(`GET ${from} -> 301`, r.status, 301)
    check(`GET ${from} -> ${to}`, loc(r.location), to)
  }

  console.log('\n5. Legacy PHP endpoints')
  for (const p of ['/header.php', '/footer.php']) {
    const r = await head(p)
    check(`GET ${p} -> 404`, r.status, 404)
  }
  for (const p of ['/enquiry-handler.php', '/contact-form.php']) {
    const r = await head(p)
    check(`GET ${p} -> 301`, r.status, 301)
    check(`GET ${p} -> /contact-us`, loc(r.location), '/contact-us')
  }

  console.log('\n6. Repository internals are not reachable')
  for (const p of ['/NCC_BUILD_SPEC.md', '/README.md', '/package.json', '/package-lock.json',
    '/scripts/build-site.mjs', '/legacy/golden/home.html', '/legacy/CONTENT-QUERIES.md',
    '/tests/parity-out/report.json', '/.gitignore', '/.gitattributes']) {
    const r = await head(p)
    check(`GET ${p} -> 404`, r.status, 404)
  }

  console.log('\n7. Infrastructure files still serve')
  for (const p of ['/robots.txt', '/sitemap.xml', '/site.webmanifest', '/humans.txt',
    '/llms.txt', '/llms-full.txt', '/.well-known/security.txt',
    '/097ee841c58a4b25b8eb2c348ca67dce.txt', '/google9706eb5d9d6a7b15.html']) {
    const r = await head(p)
    check(`GET ${p} -> 200`, r.status, 200)
  }

  console.log('\n8. Broken manifest path from home page now resolves (CQ-5)')
  {
    const r = await head('/favicon/site.webmanifest')
    check('GET /favicon/site.webmanifest -> 200', r.status, 200)
  }

  console.log('\n9. Assets serve with the correct content type')
  for (const [p, type] of [
    ['/assets/images/home/hero1.webp', 'image/webp'],
    ['/assets/images/header/logo.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/x-icon'],
    ['/site.webmanifest', 'application/manifest+json']]) {
    const r = await head(p)
    check(`GET ${p} -> 200`, r.status, 200)
    check(`GET ${p} content-type`, (r.headers.get('content-type') || '').split(';')[0], type)
  }

  console.log('\n10. Error pages exist and are served')
  for (const c of [400, 401, 403, 404, 405, 408, 410, 429, 500, 502, 503, 504]) {
    const r = await head(`/${c}`)
    check(`GET /${c} -> 200`, r.status, 200)
  }
  {
    const r = await head('/this-page-does-not-exist-' + Date.now())
    check('unknown URL -> 404', r.status, 404)
  }

  console.log('\n11. No redirect chains: every 301 lands on a 200 in one further hop')
  for (const from of ['/about-us.html', '/about', '/terms/', '/enquiry-handler.php', '/index.php']) {
    const first = await head(from)
    if (first.status !== 301) { check(`${from} first hop is 301`, first.status, 301); continue }
    const second = await head(loc(first.location))
    check(`${from} second hop -> 200`, second.status, 200)
  }

  if (remote) {
    console.log('\n12. Staging only: indexing suppressed')
    const r = await head('/')
    const tag = r.headers.get('x-robots-tag') || ''
    check('X-Robots-Tag contains noindex', tag.includes('noindex'), true)
  }

  // The corrections from section 3 of the build are asserted here because a
  // silent regression in corrections.mjs would otherwise only be visible by
  // reading the HTML by hand.
  console.log('\n13. Approved content corrections are live')
  {
    const home = await get('/')
    check('one canonical on /', (home.body.match(/rel="canonical"/g) || []).length, 1)
    check('no empty canonical on /', /rel="canonical"\s+href="\s*"/.test(home.body), false)
    check('no fake 4.8 rating on /', /4\.8\s*(?:★|\/\s*5)/.test(home.body), false)
    check('genuine 4.0 rating on /', home.body.includes('4.0★'), true)
    check('favicon.ico is the only icon on /',
      (home.body.match(/rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*href="(?!\/favicon\.ico)/g) || []).length, 0)
    check('login link in header on /', home.body.includes('nav-link-login'), true)

    // Tests for a 4.8 next to rating wording, not for the bare string: the
    // pages contain unrelated 4.8 values in CSS and SVG path data, and one
    // CSS comment that quotes "4.8" while describing heading markup.
    const bng = await get('/best-construction-company-in-bengaluru')
    const fakeClaim = /4\.8\s*(?:\u2605|star|\/\s*5|<\/strong>)/i.test(bng.body)
    check('no fake rating claim on bengaluru', fakeClaim, false)
    check('genuine rating on bengaluru', bng.body.includes('4.0\u2605'), true)

    const login = await get('/login')
    check('login page is noindex', /name="robots"\s+content="noindex/.test(login.body), true)
    check('login form has no live action', /<form[^>]*action=""/.test(login.body), true)
  }

  console.log(`\n  ${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('\nFailures:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('\n  All .htaccess rules behave as written.')
}

main().catch(e => { console.error(e); process.exit(1) })
