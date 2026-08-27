// Generate the error pages the .htaccess ErrorDocument directives point at.
//
// WHY GENERATED RATHER THAN HAND WRITTEN
// The design and content freeze forbids inventing a look. So the chrome for
// these pages is lifted verbatim out of a captured golden page: the same top
// social bar, the same Google Fonts links, the same GA4 snippet, the same
// <header> and <footer> markup, the same inline <style> blocks. Only the
// middle of the page is new, and it reuses existing class names.
//
// terms.html is the donor because it is the smallest captured page and carries
// the full site chrome with the least page-specific styling.
//
// These pages are additive infrastructure. They do not alter any of the ten
// real pages, so they sit in freeze category 2.
//
// Usage: node scripts/build-error-pages.mjs

import fs from 'node:fs'
import path from 'node:path'
import { applyCorrections } from './lib/corrections.mjs'

const DONOR = 'legacy/golden/terms.html'
const html = fs.readFileSync(DONOR, 'utf8')

function extract (re, label) {
  const m = html.match(re)
  if (!m) throw new Error(`Could not extract ${label} from ${DONOR}. Refusing to invent it.`)
  return m[0]
}

const socialBar = extract(/<div class="top-social-bar">[\s\S]*?<\/div>/i, 'top social bar')
// The donor chrome was captured before the Login link was added, so the same
// correction the public pages get is applied here. Without this, the header on
// the generated pages would silently lack a nav item the rest of the site has.
const header = applyCorrections(
  extract(/<header[\s\S]*?<\/header>/i, 'header'), '__chrome__').html
const footer = extract(/<footer[\s\S]*?<\/footer>/i, 'footer')
const gaBlock = extract(/<!-- Google tag \(gtag\.js\) -->[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/i, 'GA4 block')
const styleBlocks = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].map(m => m[0]).join('\n')
const fontLinks = [...html.matchAll(/<link[^>]*fonts\.googleapis[^>]*>/gi)].map(m => m[0]).join('\n    ')

// Errors worth a real page. Wording is factual and states the next action.
const ERRORS = [
  { code: 400, title: 'Bad request', body: 'The request could not be understood. Check the address and try again.' },
  { code: 401, title: 'Sign in required', body: 'This area needs valid credentials.' },
  { code: 403, title: 'Access denied', body: 'You do not have permission to view this resource.' },
  { code: 404, title: 'Page not found', body: 'The page you asked for does not exist, or it has moved. The links below cover everything on the site.' },
  { code: 405, title: 'Method not allowed', body: 'That action is not supported on this address.' },
  { code: 408, title: 'Request timed out', body: 'The connection took too long. Please try again.' },
  { code: 410, title: 'Page removed', body: 'This page has been permanently removed.' },
  { code: 429, title: 'Too many requests', body: 'Please wait a moment before trying again.' },
  { code: 500, title: 'Something went wrong', body: 'An error occurred on our side. Please try again shortly.' },
  { code: 502, title: 'Bad gateway', body: 'A server upstream returned an invalid response. Please try again shortly.' },
  { code: 503, title: 'Temporarily unavailable', body: 'The site is briefly unavailable, usually for maintenance. Please try again shortly.' },
  { code: 504, title: 'Gateway timed out', body: 'A server upstream took too long to respond. Please try again shortly.' }
]

const NAV = [
  ['/', 'Home'],
  ['/construction-services-in-bengaluru', 'Services'],
  ['/construction-packages-in-bengaluru', 'Packages'],
  ['/best-construction-company-in-bengaluru-projects', 'Projects'],
  ['/best-construction-company-in-bengaluru', 'Bengaluru'],
  ['/construction-company-in-tumkur', 'Tumkur'],
  ['/about-us', 'About us'],
  ['/contact-us', 'Contact us']
]

// Scoped to .ncc-error so it cannot alter any existing page's cascade.
const ERROR_CSS = `<style>
    .ncc-error{max-width:820px;margin:0 auto;padding:96px 24px 120px;text-align:center;
      font-family:'Outfit',system-ui,-apple-system,'Segoe UI',sans-serif}
    .ncc-error__code{display:block;font-size:clamp(72px,14vw,148px);line-height:1;
      font-weight:800;letter-spacing:-.04em;color:#0b3a67;margin:0 0 8px}
    .ncc-error__title{font-size:clamp(22px,4vw,34px);font-weight:700;color:#12263f;margin:0 0 14px}
    .ncc-error__body{font-size:17px;line-height:1.65;color:#4a5768;margin:0 auto 34px;max-width:56ch}
    .ncc-error__links{display:flex;flex-wrap:wrap;gap:10px 14px;justify-content:center;
      list-style:none;padding:0;margin:0 0 36px}
    .ncc-error__links a{display:inline-block;padding:9px 18px;border:1px solid #d7dee8;
      border-radius:999px;text-decoration:none;color:#0b3a67;font-size:15px;font-weight:500;
      transition:background-color .15s ease,border-color .15s ease}
    .ncc-error__links a:hover,.ncc-error__links a:focus{background:#0b3a67;border-color:#0b3a67;color:#fff}
    .ncc-error__cta{display:inline-block;padding:14px 30px;border-radius:8px;background:#e8a33d;
      color:#12263f;font-weight:700;font-size:16px;text-decoration:none}
    .ncc-error__cta:hover,.ncc-error__cta:focus{background:#d4912f}
    @media (max-width:520px){.ncc-error{padding:64px 18px 88px}}
  </style>`

function page ({ code, title, body }) {
  const links = NAV.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('\n        ')
  // Well formed, unlike the captured pages: doctype first and charset as the
  // first thing in <head>. The originals put the social bar before <head>,
  // pushing charset past byte 1024, which is where browsers stop looking, so
  // the en dash in the footer address rendered as mojibake. The ten real pages
  // keep that fault under the freeze; these generated pages do not inherit it.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    ${gaBlock}
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${code} ${title} | Neelachandra Construction</title>
    <meta name="description" content="${body}">
    <meta name="robots" content="noindex, follow">
    <!-- One favicon convention across the whole site, per the owner's
         instruction. favicon.ico is the only icon proven to resolve. -->
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel="apple-touch-icon" href="/favicon.ico">
    <link rel="manifest" href="/site.webmanifest">
    ${fontLinks}
${styleBlocks}
${ERROR_CSS}
  </head>
  <body>
${socialBar}
${header}
    <main class="ncc-error" id="error-${code}">
      <span class="ncc-error__code">${code}</span>
      <h1 class="ncc-error__title">${title}</h1>
      <p class="ncc-error__body">${body}</p>
      <ul class="ncc-error__links">
        ${links}
      </ul>
      <a class="ncc-error__cta" href="/contact-us">Talk to our team</a>
    </main>
${footer}
  </body>
</html>
`
}

let written = 0
for (const e of ERRORS) {
  const file = path.resolve(`${e.code}.html`)
  fs.writeFileSync(file, page(e))
  console.log(`  ${e.code}.html  ${String(fs.statSync(file).size).padStart(7)} bytes  ${e.title}`)
  written++
}
console.log(`\n${written} error pages written, chrome lifted verbatim from ${DONOR}.`)
