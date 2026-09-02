import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../types.js'
import { loadStatic } from './staticFiles.js'
import { submitEnquiry } from './enquiry.js'
import { readBody } from '../middleware/csrf.js'
import { getSetting } from '../lib/settings.js'
import { PAGES, pageFileFor, INFRA_PATHS } from './pages.js'

/**
 * The public marketing site (spec 3.2, phase 1).
 *
 * Every one of the ten pages is served from the frozen file that
 * scripts/build-site.mjs produced. There is no template, no partial and no
 * component here on purpose: the parity gate compares the deployed bytes
 * against golden-plus-corrections, and a rendering layer in between would
 * make that comparison meaningless.
 *
 * The one piece of behaviour is the enquiry POST, because the freeze covers
 * the design and the copy, not the fact that the old form threw submissions
 * away.
 */

type Ctx = Context<AppEnv>

const publicSite = new Hono<AppEnv>()

/** Long cache for fingerprint-free assets is wrong; a day with revalidation is right. */
const ASSET_CACHE = 'public, max-age=86400, must-revalidate'
const PAGE_CACHE = 'public, max-age=300, must-revalidate'

async function serve(
  c: Ctx,
  file: string,
  cacheControl: string
): Promise<Response | null> {
  const asset = await loadStatic(file)
  if (!asset) return null

  // A conditional request on an unchanged file is the cheapest possible
  // response and it is what a returning visitor's browser actually sends.
  if (c.req.header('if-none-match') === asset.etag) {
    c.header('ETag', asset.etag)
    c.header('Cache-Control', cacheControl)
    return c.body(null, 304)
  }

  c.header('Content-Type', asset.contentType)
  c.header('ETag', asset.etag)
  c.header('Cache-Control', cacheControl)
  return c.body(new Uint8Array(asset.body))
}

/* Assets ------------------------------------------------------------------ */

// /assets/* covers the site images and CSS at the root, plus the dashboard
// CSS and vendor bundles that vite writes into public/assets. Two roots are
// tried because the marketing assets live at the repo root (where Apache
// served them) and the built ones live under public/.
publicSite.get('/assets/*', async (c) => {
  const rel = new URL(c.req.url).pathname
  const found = (await serve(c, rel, ASSET_CACHE)) ?? (await serve(c, `/public${rel}`, ASSET_CACHE))
  if (found) return found
  return c.notFound()
})

/* Infrastructure files ---------------------------------------------------- */

// robots.txt, sitemap.xml, the IndexNow key, Search Console verification,
// llms.txt and friends. These are asserted byte-identical by the freeze, so
// they are served from disk and never regenerated. The IndexNow key file in
// particular must match what the API already verified.
for (const infra of INFRA_PATHS) {
  publicSite.get(infra, async (c) => {
    const found = await serve(c, infra, ASSET_CACHE)
    return found ?? c.notFound()
  })
}

// Favicons, the manifest, the OG image and the touch icon.
for (const file of [
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-96x96.png',
  '/apple-touch-icon.png',
  '/site.webmanifest',
  '/og.webp',
]) {
  publicSite.get(file, async (c) => {
    const found = await serve(c, file, ASSET_CACHE)
    return found ?? c.notFound()
  })
}

/* The ten pages ----------------------------------------------------------- */

for (const page of PAGES) {
  publicSite.get(page.path, async (c) => {
    const found = await serve(c, pageFileFor(page), PAGE_CACHE)
    return found ?? c.notFound()
  })
}

/* Enquiry ----------------------------------------------------------------- */

/**
 * Both live forms self-POST: /contact-us posts to itself and the homepage
 * form posts to /. That is the markup the freeze preserves, so the handler
 * accepts a POST on both paths rather than moving the action attribute.
 *
 * There is no CSRF token on these forms and there cannot be one without
 * editing frozen markup. That is acceptable here and only here: the form
 * creates an enquiry row attributable to nobody and grants no authority, so
 * a forged submission is spam, which the honeypot, the time trap and the
 * rate limit already handle. Every authenticated POST does carry a token.
 */
async function handleEnquiry(
  c: Ctx
): Promise<Response> {
  const db = c.get('db')
  const body = await readBody(c)
  const sourcePage = new URL(c.req.url).pathname

  const notifyTo = await getSetting<string>(db, 'company.email_enquiry', '')

  const outcome = await submitEnquiry(db, body, {
    ip: c.get('clientIp'),
    userAgent: c.req.header('user-agent') ?? null,
    sourcePage,
    notifyTo: notifyTo || null,
  })

  // An htmx submission wants a fragment it can swap where the form was.
  if (c.req.header('hx-request')) {
    return outcome.ok
      ? c.html(
          '<div class="ncc-alert ncc-alert--ok" role="status"><strong>Thank you.</strong> Your enquiry has reached us and we will be in touch shortly.</div>'
        )
      : c.html(
          `<div class="ncc-alert ncc-alert--error" role="alert">${escapeHtml(outcome.message ?? 'Please check the form.')}</div>`,
          422
        )
  }

  // Otherwise POST/Redirect/GET, so a refresh does not resubmit. The result
  // is carried in the query string because there is no session for a public
  // visitor to hold a flash message in, and the anchor returns the reader to
  // the form they just submitted.
  const anchor = sourcePage === '/' ? '#contact' : '#email-form'
  const qs = outcome.ok ? 'enquiry=sent' : `enquiry=error&reason=${encodeURIComponent(outcome.message ?? '')}`
  return c.redirect(`${sourcePage}?${qs}${anchor}`, 303)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

publicSite.post('/contact-us', handleEnquiry)
publicSite.post('/', handleEnquiry)
publicSite.post('/best-construction-company-in-bengaluru', handleEnquiry)

export default publicSite
