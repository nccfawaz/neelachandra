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
    // HOTFIX BATCH 2 (plan: docs/seo/STAGE2-COPY-PROPOSAL.md "Rating claims
    // removal plan"; open owner question Q11). The owner has NOT confirmed that
    // any Google rating or review count may be published, and src/content/facts.ts
    // sets displayAggregateRating:false. So every VISIBLE rating claim the golden
    // masters carry (the invented 4.8) is REMOVED here, not rewritten to the real
    // 4.0 — a figure the site may not state until Q11 is answered. The companion
    // `rating` corrector above deletes the aggregateRating JSON-LD nodes; this one
    // removes the visible stat badges and rating sentences and rewrites the two
    // Bengaluru FAQ answers so they no longer mention a rating.
    //
    // Correctors run on the GOLDEN input, which still says "4.8" / "over 8 years",
    // so every pattern targets the golden wording, not the served text. about.html
    // uses bare-LF endings in its stat region (the file is mixed CRLF/LF), so that
    // one block matches on \n; every other page matches on \r\n. [ \t]* absorbs the
    // leading indent so a mis-counted space cannot silently turn a removal into a
    // no-op — and if any removal fails to fire, the RESIDUAL tripwire below throws.
    fn (html, file) {
      let out = html

      // --- Whole stat / sentence blocks removed ---

      // Row 1  home:985  "Google Rating" hero stat card (reflow R1: the stat
      // strip drops from 4 flex cards to 3).
      out = out.replace(
        /[ \t]*<div class="scroll-col-2 gsap-stat-card">\r\n[ \t]*<p class="heading-3"><strong class="bold-text-11">4\.8★<\/strong><\/p>\r\n[ \t]*<div class="div-block-31"><div><p class="paragraph-4">Google Rating<\/p><\/div><div class="div-block-32"><img src="\/assets\/images\/home\/rating\.webp" width="48" height="48" loading="lazy" alt="Google rating icon"><\/div><\/div>\r\n[ \t]*<\/div>\r\n/,
        ''
      )

      // Row 2  home:1091  "average Google rating from N reviews" counter card
      // (reflow R2: .div-block-9 drops from 4 to 3 counters).
      out = out.replace(
        /[ \t]*<div class="div-block-8 counter-2"><div class="div-block-7"><p class="heading-7"><strong class="bold-text-22">4\.8<\/strong><\/p><p class="heading-8"><\/p><\/div><p class="paragraph-10"><strong class="bold-text-5">average Google rating from \[CLIENT TO VERIFY: number\] Google reviews<\/strong><\/p><\/div>\r\n/,
        ''
      )

      // Row 3  home:1206  testimonial numeric rating heading + sentence (reflow
      // R3). The decorative stars.webp image above it is left as-is: it is not in
      // the approved 12-row plan and carries no numeric claim.
      out = out.replace(
        /[ \t]*<div><h3 class="heading-18">4\.8 \/ 5\.0<\/h3><p class="paragraph-35">Average client rating across residential, commercial and industrial projects delivered since 2018\.<\/p><\/div>\r\n/,
        ''
      )

      // Row 8  bengaluru:491  "Avg. Verified Client Rating" bng-stat (reflow R4:
      // .bng-stats drops from 4 to 3).
      out = out.replace(
        /[ \t]*<div class="bng-stat"><span class="num">4\.8★<\/span><span class="lbl">Avg\. Verified Client Rating<\/span><\/div>\r\n/,
        ''
      )

      // Row 11  tumkur:585  "Average Client Rating" trust-card (reflow R5:
      // .trust-bar drops from 4 to 3).
      out = out.replace(
        /[ \t]*<div class="trust-card">\r\n[ \t]*<div class="trust-num">4\.8\/5<\/div>\r\n[ \t]*<div class="trust-label">Average Client Rating<\/div>\r\n[ \t]*<\/div>\r\n/,
        ''
      )

      // Row 12  about:757  "Average Rating" stat (reflow R6). about.html uses bare
      // LF line endings in this region, so this block alone matches on \n.
      out = out.replace(
        /[ \t]*<div class="scroll-col-2">\n[ \t]*<h2 class="heading-3"><strong class="bold-text-11">4\.8<\/strong><sup>★<\/sup><\/h2>\n[ \t]*<div class="div-block-31"><div><p class="paragraph-4">Average Rating<\/p><\/div><div class="div-block-32"><img src="\/assets\/images\/home\/rating\.webp" loading="lazy" alt=""><\/div><\/div>\n[ \t]*<\/div>\n/,
        ''
      )

      // --- Clause-level rewrites ---

      // Row 4  projects:1144  drop the trailing rating clause; the sentence now
      // ends at "... with over 60 acres developed."
      out = out.replace(' and a 4.8/5 average client rating.', '.')

      // Rows 5-6 (JSON-LD, bengaluru:315) and 7-8 (visible, bengaluru:700). The
      // two FAQ answers are identical but for " star" vs "★"; both become the
      // approved string F1 (no rating, never the word "verified"). The replacement
      // keeps the golden "over 8 years" wording so the founding-year corrector,
      // which runs AFTER this one, rewrites it to the single computed "N+ years"
      // figure the rest of the site carries — rather than freezing "8+" into prose
      // that would drift at the next year-rollover. Both sites therefore end
      // byte-identical F1 AND agree with the site-wide years figure.
      out = out.replace(
        /, over 8 years of proven engineering experience, and a 4\.8(?: star|★) client rating\./g,
        ' and over 8 years of proven engineering experience.'
      )

      // --- RESIDUAL tripwire, re-pointed (CLAUDE.md: a tripwire must evaluate its
      // subject and be able to go red). After removal NO rating claim may survive
      // on ANY page; each check fails the build loudly rather than ship a page
      // that states a rating in one place and nothing in another. Comments are
      // stripped first so the home.html heading-markup comment that quotes "4.8"
      // is not read as a claim.
      const scan = out.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

      // Numeric rating values. The pages carry unrelated 4.0/4.8 in CSS and SVG
      // path data (noted in scripts/test-htaccess.mjs), so a bare value is not a
      // claim — only one sitting beside a rating word is.
      for (const m of scan.match(/.{0,90}4\.[08].{0,60}/gs) || []) {
        if (/rating|star|★|review|Google/i.test(m)) {
          throw new Error(
            `rating-visible: residual numeric rating claim in ${file}:\n  ` +
            m.replace(/\s+/g, ' ').trim()
          )
        }
      }

      // Rating phrasings that are a claim on their own. The star GLYPH ★ only ever
      // appeared in the numeric badges removed above (the decorative testimonial
      // image says "star" in alt text but carries no glyph); "verified" is only
      // flagged next to a rating/review word, so benign material/payment uses pass.
      const PHRASES = [
        ['star-glyph badge ★', /★/],
        ['review-count claim', /\d+\s+(?:Google\s+)?reviews\b/i],
        ['"Avg. Verified Client Rating" label', /Avg\.\s*Verified\s*Client\s*Rating/i],
        ['"verified ... rating/review"', /verified[^.<>]{0,40}(?:rating|review)/i]
      ]
      for (const [label, re] of PHRASES) {
        const m = scan.match(re)
        if (m) {
          throw new Error(
            `rating-visible: residual ${label} in ${file}:\n  ` +
            scan.slice(Math.max(0, m.index - 50), m.index + 60).replace(/\s+/g, ' ').trim()
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
