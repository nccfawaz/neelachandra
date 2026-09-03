// Normalisation and extraction for the parity gate (spec 3.2).
//
// DESIGN RULE: strip only what is genuinely volatile between two renders of
// the SAME content. Anything else stays, because every masked difference is a
// regression this gate would fail to catch. When in doubt, do not strip.
//
// Deliberately NOT stripped, with reasons:
//   - attribute values other than the volatile ones below (a changed href or
//     src IS a regression)
//   - inline style attributes (a moved pixel is the thing we are testing)
//   - class values (the DOM freeze depends on them)
//   - comments (they can carry build markers that reveal accidental changes)

// Volatile patterns. Each needs a justification to exist in this list.
const VOLATILE = [
  // CSRF token: rotates every request by design (enquiry-handler.php).
  { re: /(name=["']nc_csrf["'][^>]*value=["'])[^"']*(["'])/gi, sub: '$1__VOLATILE__$2' },
  { re: /(name=["']csrf_token["'][^>]*value=["'])[^"']*(["'])/gi, sub: '$1__VOLATILE__$2' },
  // Time trap: unix timestamp of page render (nc_started).
  { re: /(name=["']nc_started["'][^>]*value=["'])[^"']*(["'])/gi, sub: '$1__VOLATILE__$2' },
  // Cache-busting query strings on assets, e.g. style.css?v=1712345678
  { re: /([?&])(v|ver|t|_)=\d{6,}/gi, sub: '$1$2=__VOLATILE__' },
  // Any literal 10-digit unix timestamp.
  { re: /\b1[6-9]\d{8}\b/g, sub: '__TS__' },
]

// NOTE ON YEARS: an earlier version of this file masked every /\b20\d{2}\b/
// so that a January cutover would not fail on a copyright footer. That was a
// mistake and it is deliberately NOT done any more. The live pages embed
// years inside CONTENT ("...in Bengaluru 2025", "foundingDate": "2018"), so
// masking years hid real copy differences and made the gate weaker than it
// looked. A dynamic copyright year is handled where it belongs, by comparing
// the footer with the year the golden master was captured, not by blanket
// masking. If a rollover false-positive appears, fix the one footer node.


export function stripVolatile (html) {
  let out = html
  for (const { re, sub } of VOLATILE) out = out.replace(re, sub)
  return out
}

// Remove script and style CONTENT but keep the tags, so a dropped block is
// still detected while JS/CSS formatting churn is not compared as text.
// JSON-LD is exempt: it is compared separately and precisely.
function blankScriptsAndStyles (html) {
  return html
    .replace(/(<script\b(?![^>]*application\/ld\+json)[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
}

/**
 * Visible text-node sequence. This is the COPY FREEZE.
 * Any added, removed or reordered visible string fails the gate.
 *
 * JSON-LD is excluded here because it is not visible text and is compared
 * precisely by jsonLdNodes() plus jsonLdPayload(). Leaving it in produced one
 * enormous 6 KB "text node" that swamped the diff and made a one-word copy
 * edit elsewhere on the page invisible in the output.
 */
export function textNodes (html) {
  const stripped = blankScriptsAndStyles(stripVolatile(html))
    // Blank ld+json too, for this check only.
    .replace(/(<script\b[^>]*application\/ld\+json[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
  const withoutTags = stripped
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\u0000')
  return withoutTags
    .split('\u0000')
    .map(s => decodeEntities(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Element and class sequence. This is the DOM FREEZE.
 * Catches a div -> section swap that changes a descendant selector, and any
 * dropped or renamed class.
 */
export function elementSequence (html) {
  const out = []
  // Include CLOSING tags. Without them, swapping <div>...</div> for
  // <section>...</div> (invalid but real) or changing nesting depth can leave
  // the opening-tag sequence identical while the tree differs.
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let m
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    if (closing) { out.push(`/${tag}`); continue }
    const rest = m[3] || ''
    out.push(fingerprint(tag, rest))
  }
  return out
}

function fingerprint (tag, attrs) {
  const cls = /class\s*=\s*["']([^"']*)["']/i.exec(attrs)
  const classes = cls ? cls[1].trim().split(/\s+/).filter(Boolean).sort().join('.') : ''
  const id = /id\s*=\s*["']([^"']*)["']/i.exec(attrs)
  return `${tag}${id ? '#' + id[1] : ''}${classes ? '.' + classes : ''}`
}

/**
 * Parsed JSON-LD blocks. Compared as node sets by @type and @id (spec 6.5
 * rule 7), so consolidating nine hand-written copies into one buildGraph()
 * is provably lossless.
 */
export function jsonLdNodes (html) {
  const nodes = []
  const re = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      nodes.push({ '@type': '__UNPARSEABLE__', raw: raw.slice(0, 200) })
      continue
    }
    const graph = parsed['@graph'] ?? parsed
    for (const n of (Array.isArray(graph) ? graph : [graph])) {
      const t = n['@type']
      nodes.push({
        '@type': Array.isArray(t) ? t.slice().sort().join('+') : (t ?? '__NO_TYPE__'),
        '@id': n['@id'] ?? null,
      })
    }
  }
  return nodes
}

/**
 * Deep JSON-LD comparison as a flat sorted set of "path=value" leaves.
 *
 * jsonLdNodes() only compares @type and @id, which proves no NODE was lost.
 * It would NOT catch a changed price, a changed ratingValue, or a reworded
 * FAQ answer, all of which are content and all of which are frozen. This
 * catches those. Array indices are included in the path, so a reordered
 * makesOffer list is reported.
 */
export function jsonLdPayload (html) {
  const leaves = []
  const re = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi
  let m, block = 0
  while ((m = re.exec(html)) !== null) {
    let parsed
    try { parsed = JSON.parse(m[1].trim()) } catch { leaves.push(`block${block}=__UNPARSEABLE__`); block++; continue }
    walk(parsed, `b${block}`, leaves)
    block++
  }
  return leaves.sort()
}

function walk (v, path, out) {
  if (v === null || typeof v !== 'object') { out.push(`${path}=${String(v)}`); return }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, out)); return }
  for (const k of Object.keys(v).sort()) walk(v[k], `${path}.${k}`, out)
}

/** Head-level SEO fields that must not drift. */
export function seoFields (html) {
  const pick = re => { const m = re.exec(html); return m ? decodeEntities(m[1]).trim() : null }
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    metaDescription: pick(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i),
    canonical: pick(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i),
    robots: pick(/<meta\b[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i),
    ogTitle: pick(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i),
    ogImage: pick(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i),
    h1: pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ') ?? null,
  }
}

/**
 * Asset references, so a renamed or dropped image is caught.
 *
 * This is also the function capture-assets.mjs uses to decide what to mirror
 * permanently before the live site is removed, so a reference mechanism missing
 * from here is not merely an unchecked axis: the file is never requested from
 * the live host and is gone for good. Four real assets were lost that way
 * (three hero WebPs behind CSS url(), and og.webp behind <meta content>), which
 * is why each mechanism below names what it exists to catch.
 *
 * Spec 3.2 point 7 enumerates img, source, link and script. That list does not
 * satisfy its own stated intent, "the full asset reference set", so this is
 * deliberately wider than the letter of 3.2. Widening adds no mask and no
 * exclusion, so the zero-tolerance rule is untouched; see DECISIONS.md 4.5.
 */
export function assetRefs (html) {
  const set = new Set()
  const add = (re, group = 1) => {
    let m
    while ((m = re.exec(html)) !== null) if (m[group]) set.add(m[group])
  }

  add(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)
  add(/<link\b[^>]*\bhref=["']([^"']+\.(?:css|ico|png|svg|webp|webmanifest))["']/gi)
  add(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)
  // <source src> is for video and audio; <source srcset> is handled below.
  add(/<source\b[^>]*\bsrc=["']([^"']+)["']/gi)

  // srcset, split into candidates. The previous version stored the whole
  // attribute as one opaque string, so a density variant that appears only in
  // srcset was never mirrored. Every value here currently duplicates its own
  // src, so this changes nothing today and stops it becoming a hole later.
  for (const m of html.matchAll(/<(?:img|source)\b[^>]*\bsrcset=["']([^"']+)["']/gi)) {
    for (const candidate of m[1].split(',')) {
      const u = candidate.trim().split(/\s+/)[0]
      if (u) set.add(u)
    }
  }

  // CSS url(), from both <style> blocks and style="" attributes. The hero
  // images on services, about, packages and projects are referenced ONLY this
  // way, as background-image on a class defined in an inline <style> block:
  //   .service-banner { background-image: linear-gradient(...), url("/x.webp") }
  // No axis inspected style-block text, so those files were invisible.
  for (const m of html.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) {
    const raw = m[1].replace(/^(?:["']|&quot;|&#0?34;|&apos;|&#0?39;)/i, '')
      .replace(/(?:["']|&quot;|&#0?34;|&apos;|&#0?39;)$/i, '').trim()
    // data: is inline content, not a reference to a file that must survive.
    if (!raw || /^data:/i.test(raw)) continue
    set.add(raw)
  }

  // Social and tile images. og.webp is referenced by nothing else on any page,
  // and spec 7.5 item 6 requires it to survive byte-identical at 1,091,756
  // bytes, so a gate that could not see it was checking the wrong set.
  // Matched tag-first rather than attribute-first so that content="" appearing
  // before property="" still resolves.
  const IMAGE_META = new Set(['og:image', 'og:image:url', 'og:image:secure_url',
    'twitter:image', 'twitter:image:src', 'msapplication-tileimage'])
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]?.toLowerCase()
    if (!key || !IMAGE_META.has(key)) continue
    const val = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1]
    if (val) set.add(val)
  }

  return [...set].sort()
}

function decodeEntities (s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
}

/** Ordered-sequence diff, reported as the first N divergences. */
export function diffSequences (expected, actual, limit = 25) {
  const diffs = []
  const max = Math.max(expected.length, actual.length)
  for (let i = 0; i < max && diffs.length < limit; i++) {
    if (expected[i] !== actual[i]) {
      diffs.push({ index: i, expected: expected[i] ?? '(missing)', actual: actual[i] ?? '(missing)' })
    }
  }
  return { count: diffs.length, truncated: diffs.length >= limit, diffs, lengthExpected: expected.length, lengthActual: actual.length }
}
