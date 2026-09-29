// Deliberate, user-approved corrections applied on top of the golden masters.
//
// WHY THIS FILE EXISTS
// legacy/golden/ is the audit record of what the old site actually served. It
// must stay pristine: if a correction were written into it, the evidence of the
// original defect would be destroyed and there would be no way to prove what
// changed. So corrections live here as explicit, reviewable transforms that
// build-site.mjs applies on the way out. Golden stays byte-identical to the
// live site forever; the deployed root is golden plus exactly these edits.
//
// Every entry below is a decision the owner made, recorded with its reason.
// Anything not listed here is still under the design and content freeze.

import { PAGES } from './pages.mjs'

const ORIGIN = 'https://neelachandra.com'

// The genuine Google Business Profile figures, read from the rendered listing
// at https://maps.app.goo.gl/xKXFta3YY4gzuJFU6 on 2026-08-27. The star
// histogram showed 3 five-star and 1 one-star review, which is 16/4 = 4.0
// exactly, and the listing's own summary displays 4,0. This replaces the
// invented 4.8, which appeared on five pages with four mutually contradictory
// review counts (2, 4, 4, 30, 87).
export const RATING = { value: '4.0', count: '4' }

// One favicon convention for every page, per the owner's instruction. The site
// previously used five different conventions across ten pages, referencing
// favicon-96x96.png, favicon.svg, apple-touch-icon.png and six paths that
// 404ed. favicon.ico is the only icon proven to exist and resolve.
const FAVICON_BLOCK =
  '<link rel="icon" href="/favicon.ico" sizes="any">\r\n' +
  '  <link rel="shortcut icon" href="/favicon.ico">\r\n' +
  '  <link rel="apple-touch-icon" href="/favicon.ico">\r\n' +
  '  <link rel="manifest" href="/site.webmanifest">'

// Staff sign-in entry point, added to the header of every public page.
const LOGIN_LI =
  '<li class="list-item-login"><a href="/login" class="nav-link nav-link-login" rel="nofollow">Login</a></li>\r\n          '

function canonicalFor (file) {
  const page = PAGES.find(p => {
    const f = p.path === '/' ? 'index.html'
      : p.path.replace(/^\/+/, '').replace(/\/+$/, '') + '.html'
    return f === file
  })
  if (!page) return null
  return page.path === '/' ? `${ORIGIN}/` : ORIGIN + page.path
}

// Each corrector returns the new html, or the same string if it did not apply.
const CORRECTORS = [
  {
    key: 'canonical',
    // Every page except tumkur shipped a broken canonical. Nine of the ten had
    // <link rel="canonical" href="">, and on seven of those it was a SECOND
    // canonical sitting alongside a correct one. Two canonical tags on one page
    // is self-cancelling: Google treats conflicting canonicals as a bad signal
    // and falls back to guessing, and an empty href resolves to the current URL
    // for some crawlers while being discarded by others.
    //
    // So this does not patch the empty tag in place, which would leave two
    // identical tags. It strips every canonical and inserts exactly one, in the
    // position the first one occupied, so head order is otherwise untouched.
    fn (html, file) {
      const url = canonicalFor(file)
      if (!url) return html
      const ANY = /[ \t]*<link\s+rel="canonical"[^>]*>\r?\n?/gi
      if (!ANY.test(html)) return html
      ANY.lastIndex = 0
      let first = true
      return html.replace(ANY, () => {
        if (first) { first = false; return `  <link rel="canonical" href="${url}">\r\n` }
        return ''
      })
    }
  },
  {
    key: 'rating',
    // DELETE every aggregateRating node. With only 4 Google reviews, the
    // listing does not display an aggregate rating publicly, so claiming one in
    // Schema.org structured data is false. Two passes handle both positions the
    // node takes: mid-object (followed by a comma) and last-property (preceded
    // by a comma). Removing the node with its adjacent comma keeps the
    // surrounding JSON valid in both cases — proven by json-ld parse in the
    // fact-consistency gate.
    fn (html) {
      // The aggregateRating object is always flat (no nested braces), so
      // [^{}]* stops at its own closing brace. A greedy/[\s\S] body would skip
      // past it to the parent object's brace when the node is the last property
      // (no trailing comma), swallowing the parent's close and corrupting JSON.
      // Node followed by a comma (not the last property in its object).
      let out = html.replace(/"aggregateRating"\s*:\s*\{[^{}]*\}\s*,/g, '')
      // Node preceded by a comma (the last property in its object).
      out = out.replace(/,\s*"aggregateRating"\s*:\s*\{[^{}]*\}/g, '')
      return out
    }
  },
  {
    key: 'rating-visible',
    // The rating also appears as VISIBLE text in three places: a stat card on
    // the homepage ("Google Rating"), a stat card on the Bengaluru page
    // ("Avg. Verified Client Rating"), and one sentence of FAQ prose on the
    // same page. Correcting only the JSON-LD would leave each page
    // contradicting its own structured data, which is the exact mismatch
    // Google penalises, and would leave a false claim in the visible copy.
    //
    // These are the only visible-copy changes in this file. They exist because
    // the owner confirmed the 4.8 was not genuine, so leaving it on screen was
    // not an option.
    fn (html) {
      // The claim appears in SEVEN visible formats across four pages, each
      // worded differently: "4.8★", "4.8</strong><sup>★</sup>", "4.8 / 5.0",
      // "4.8/5", "4.8 star client rating" and two stat cards. Searching only
      // for "4.8★" found two of them, which is why this is pattern-by-pattern
      // and ends with an assertion instead of a single global replace.
      //
      // ORDER MATTERS: the prose rewrites run before the bare-number swaps,
      // otherwise the number changes first and the longer phrases no longer
      // match. Getting this wrong produced the truncated string
      // "and a verified 4." on the first attempt.
      let out = html

      // 1. Prose claims. Swapping the digits alone would offer a 4.0 as
      //    evidence of being "widely recognized as leading", so each clause is
      //    restated as a plain, checkable fact.
      // The Bengaluru FAQ answer exists TWICE: once as visible <details>
      //  markup using "4.8★" and once inside the FAQPage JSON-LD using
      // "4.8 star". Both copies have to read identically or the page and its
      // structured data disagree, so the pattern accepts either spelling and
      // the replace is global.
      out = out.replace(
        /and a 4\.8(?:★| star) client rating\./g,
        `and a verified ${RATING.value}-star Google rating from ${RATING.count} reviews.`
      )
      out = out.replace(
        /and a 4\.8\/5 average client rating\./,
        `and a verified ${RATING.value}-star Google rating from ${RATING.count} reviews.`
      )

      // 2. Display figures. The surrounding label already says what it is, so
      //    only the number is corrected, preserving each page's own format.
      out = out.replace(/4\.8 \/ 5\.0/g, `${RATING.value} / 5.0`)
      out = out.replace(/4\.8\/5(?!\.)/g, `${RATING.value}/5`)
      out = out.replace(/4\.8★/g, `${RATING.value}★`)
      out = out.replace(/>4\.8<\/strong><sup>★<\/sup>/g,
        `>${RATING.value}</strong><sup>★</sup>`)
      // Home page line 1091: bare 4.8 in a stat card with empty label
      out = out.replace(
        /(<strong class="bold-text-22">)4\.8(<\/strong><\/p><p class="heading-8"><\/p>)/g,
        `$1${RATING.value}$2`
      )
      // The review-count is now confirmed (4), so the stat card's label
      // placeholder can be filled from the genuine GBP figure.
      out = out.replace(
        /Google rating from \[CLIENT TO VERIFY: number\] Google reviews/g,
        `Google rating from ${RATING.count} Google reviews`
      )

      // 3. Prove nothing was missed. A leftover 4.8 next to a rating word
      //    means a new format was introduced upstream and this corrector needs
      //    extending. Failing loudly is the only safe outcome: a half
      //    corrected page states two different ratings at once.
      const RESIDUAL = /.{0,90}4\.8.{0,60}/gs
      for (const m of out.match(RESIDUAL) || []) {
        if (/Numeric stat displays/.test(m)) continue  // a CSS comment, not a claim
        if (/rating|Rating|star|★|review|Review|Google/.test(m)) {
          throw new Error(
            'Uncorrected 4.8 rating claim remains after correction:\n  ' +
            m.replace(/\s+/g, ' ').trim()
          )
        }
      }
      return out
    }
  },
  {
    key: 'favicon',
    // Collapse every icon and manifest link into the single convention.
    fn (html) {
      const ICON_LINK =
        /[ \t]*<link\s+rel="(?:icon|shortcut icon|apple-touch-icon|mask-icon|manifest)"[^>]*>\r?\n?/gi
      if (!ICON_LINK.test(html)) return html
      ICON_LINK.lastIndex = 0
      let first = true
      return html.replace(ICON_LINK, () => {
        if (first) { first = false; return `  ${FAVICON_BLOCK}\r\n` }
        return ''
      })
    }
  },
  {
    key: 'login',
    // Insert the staff sign-in link immediately before the header CTA, so it
    // sits at the end of the nav list and the existing CTA keeps its position.
    fn (html) {
      if (html.includes('nav-link-login')) return html
      const anchor = '<li>\r\n              <div class="nav-button-wrapper">'
      if (!html.includes(anchor)) return html
      return html.replace(anchor, LOGIN_LI + anchor)
    }
  },
  {
    key: 'phone',
    // Normalize all phone numbers to the single canonical number. The site
    // previously displayed three different numbers (7829292929, 8029652243,
    // 6157069211) plus a placeholder (+91-XXXXXXXXXX), creating confusion about
    // which was correct. All instances are replaced with +91 7829292929 in
    // various display formats, and tel: hrefs are normalized to the digits-only
    // form that ensures reliable click-to-call behavior.
    fn (html) {
      let out = html
      // Replace the obsolete numbers and placeholder with canonical
      out = out.replace(/8029652243|80296\s*52243/g, '7829292929')
      out = out.replace(/6157069211|61570\s*69211/g, '7829292929')
      out = out.replace(/\+91-XXXXXXXXXX/g, '+91 7829292929')
      // Normalize tel: hrefs to remove spaces/formatting for reliable dialing
      out = out.replace(/tel:\+?91[\s-]?78292[\s-]?92929/g, 'tel:+917829292929')
      out = out.replace(/tel:\+?91[\s-]?7829292929/g, 'tel:+917829292929')
      return out
    }
  },
  {
    key: 'internal-links',
    // Fix broken internal links. Projects page linked to /about and /contact,
    // which 404 because the actual routes are /about-us and /contact-us.
    fn (html, file) {
      if (!file.includes('projects')) return html
      return html
        .replace(/href="\/about"/g, 'href="/about-us"')
        .replace(/href="\/contact"/g, 'href="/contact-us"')
    }
  },
  {
    key: 'malformed-tag',
    // Fix malformed <34> tag in home.html accordion. The opening tag was
    // corrupted to <34 class="..."> while the closing tag remained </h3>,
    // breaking HTML validity.
    fn (html, file) {
      if (!file.includes('index')) return html
      return html.replace(/<34 class="accordion-heading">/g, '<h3 class="accordion-heading">')
    }
  },
  {
    key: 'founder-placeholder',
    // Replace founder name placeholder with the actual name: Chandrashekar T.
    // The second placeholder (commercial project example) is removed entirely
    // by deleting its sentence, per owner instruction.
    fn (html, file) {
      if (!file.includes('projects')) return html
      let out = html
      out = out.replace(/\[PLACEHOLDER: Founder full name\]/g, 'Chandrashekar T')
      // Remove the commercial project placeholder sentence. It sits at the end
      // of a paragraph, so remove from "Our commercial work" through the
      // placeholder and restore the sentence that should conclude the paragraph.
      out = out.replace(
        /Our commercial work applies the same structural discipline, material traceability and milestone-based delivery proven on OEM-grade industrial projects such as Honda Cars India — ensuring functional, durable, high-value business spaces delivered on schedule\. \[PLACEHOLDER: replace with a specific named commercial project — client, location, sq ft — once cleared for public use\.\]/g,
        'Our commercial work applies the same structural discipline, material traceability and milestone-based delivery proven on OEM-grade industrial projects such as Honda Cars India.'
      )
      return out
    }
  },
  {
    key: 'rupee-symbol',
    // Replace "Rs" with the proper rupee symbol ₹ in the packages page
    // (meta description, schema, H1, and body copy).
    fn (html, file) {
      if (!file.includes('packages')) return html
      return html.replace(/\bRs\b/g, '₹')
    }
  },
  {
    key: 'gst-disclosure',
    // Add explicit GST-inclusive disclosure next to every price table. Prices
    // include GST, but this was never stated, causing customer confusion.
    fn (html, file) {
      // Exact filenames — substring matching would fire the bengaluru branch on
      // construction-packages-in-bengaluru.html (which also contains "bengaluru").
      const PRICE_PAGES = [
        'index.html',
        'construction-packages-in-bengaluru.html',
        'best-construction-company-in-bengaluru.html',
        'construction-company-in-tumkur.html'
      ]
      if (!PRICE_PAGES.includes(file)) return html
      // Skip if already present
      if (html.includes('All prices include GST')) return html

      let out = html
      // Home page: after the pricing section heading
      if (file === 'index.html') {
        out = out.replace(
          /(<h2 class="heading-4"><strong>House Construction Cost in Bengaluru: ₹2,299 to ₹3,499 per sqft<\/strong><\/h2>)/,
          '$1\r\n    <p class="paragraph-note" style="margin-top: 0.75rem; font-size: 0.9rem; color: #666;">All prices include GST.<\/p>'
        )
      }
      // Packages page: after the main H1
      if (file === 'construction-packages-in-bengaluru.html') {
        out = out.replace(
          /(<h1 class="heading-35">How much does house construction cost in Bengaluru\?[^<]*<\/h1>)/,
          '$1\r\n      <p class="paragraph-note" style="margin-top: 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; color: #666;">All prices include GST.<\/p>'
        )
      }
      // Bengaluru page: before the pricing card grid
      if (file === 'best-construction-company-in-bengaluru.html') {
        out = out.replace(
          /(<div class="pricing-wrapper">)/,
          '<p class="paragraph-note" style="margin-bottom: 1.5rem; font-size: 0.9rem; color: #666;">All prices include GST.<\/p>\r\n      $1'
        )
      }
      // Tumkur page: after the per-sq-ft cost heading
      if (file === 'construction-company-in-tumkur.html') {
        out = out.replace(
          /(<h3>Cost per Sq Ft in Tumkur by Package<\/h3>)/,
          '$1\r\n    <p class="paragraph-note" style="margin-top: 0.5rem; margin-bottom: 1rem; font-size: 0.9rem; color: #666;">All prices include GST.<\/p>'
        )
      }
      return out
    }
  },
  {
    key: 'founding-year',
    // Anchor all duration claims to the verified founding year (2018) so they
    // stay accurate and can't drift. Replaces vague/contradictory claims like
    // "over a decade" (false in 2026), "10+ years" (false), "over 8 years"
    // (will become false in 2027) with the current, computable figure.
    fn (html) {
      const now = new Date()
      const years = now.getFullYear() - 2018
      const yearsText = `${years}+ years`

      let out = html
      // "over a decade" appears in about.html and tumkur.html
      out = out.replace(/over a decade/gi, yearsText)
      // "10+ Years" in tumkur.html stat card
      out = out.replace(/10\+\s*Years/gi, yearsText)
      // "over 8 years" in bengaluru.html (3 instances)
      out = out.replace(/over 8 years/gi, yearsText)

      return out
    }
  }
]

export function applyCorrections (html, file) {
  const applied = []
  let out = html
  for (const c of CORRECTORS) {
    const next = c.fn(out, file)
    if (next !== out) { applied.push(c.key); out = next }
  }
  return { html: out, applied }
}

export const CORRECTION_KEYS = CORRECTORS.map(c => c.key)
