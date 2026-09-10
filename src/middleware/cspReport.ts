/**
 * Content-Security-Policy-Report-Only, per §24.7's "no policy is written" —
 * with the enforcement question left to §9, this gathers real violations
 * from real browsers without breaking anything (TOLERANCE 0: nothing here
 * can change what a page executes).
 *
 * The draft policy is the enforcing policy §9 would eventually want, with
 * the two documented concessions from §24 built in:
 *  - 'unsafe-eval' on script-src for /app: the vendored Alpine standard
 *    build evaluates x- expressions through the AsyncFunction constructor
 *    (§24.3, copied out of the minified file) — genuinely required by the
 *    vendored build, NOT the CDN variant; the CSP build exists precisely to
 *    drop it.
 *  - 'unsafe-inline' on style-src: 23 of 24 public pages carry inline
 *    <style> (§24.5/§24.6).
 * Violations against this draft are the evidence §9 needs to tighten it.
 *
 * Report-Only means the browser applies nothing: every page behaves exactly
 * as today, and each violation POSTs to /api/csp-report for collection.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { parseJsonColumn } from '../lib/json.js'

export const CSP_REPORT_PATH = '/api/csp-report'

/**
 * The collector is unauthenticated by design (§29.24: reports are generated
 * by the browser, not a session, and requiring one would lose every
 * violation on a logged-out public page). That makes it an anonymous write
 * endpoint, so it carries the three controls an anonymous endpoint must
 * have (DECISIONS 29.27):
 *   1. a body size cap, refused with 413 before any parsing;
 *   2. shape validation — only the recognised CSP level-3 report shape is
 *      accepted (422 otherwise) and every string field is truncated, so no
 *      raw attacker-controlled payload reaches the log;
 *   3. a fixed-window rate limit per client IP — 30 reports per minute,
 *      refused with 429 once spent, so the log cannot be filled by loop.
 * A valid report still lands: 204, and one greppable log line.
 */
export const CSP_MAX_BODY_BYTES = 16 * 1024
const CSP_RATE_LIMIT = 30
const CSP_RATE_WINDOW_MS = 60_000
const CSP_MAX_FIELD = 200
const CSP_MAX_LOG_LINE = 1200

const CSP_STRING_FIELDS = [
  'document-uri',
  'referrer',
  'violated-directive',
  'effective-directive',
  'original-policy',
  'disposition',
  'blocked-uri',
  'status-code',
  'script-sample',
] as const

function truncate(v: unknown): string {
  const s = typeof v === 'string' ? v : String(v)
  return s.length > CSP_MAX_FIELD ? s.slice(0, CSP_MAX_FIELD) + `…(+${s.length - CSP_MAX_FIELD})` : s
}

/** Only a well-formed csp-report envelope with string-typed known fields passes. */
function parseViolation(body: string): Record<string, string> | null {
  // The one JSON reader in src/ (json.ts): parseJsonColumn returns the string
  // untouched when it is not JSON, which here means "not a report".
  const parsed = parseJsonColumn(body)
  if (typeof parsed === 'string') return null
  if (parsed === null || typeof parsed !== 'object') return null
  const envelope = parsed as Record<string, unknown>
  const report = envelope['csp-report']
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return null
  const fields = report as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of CSP_STRING_FIELDS) {
    if (key in fields) {
      const v = fields[key]
      if (typeof v !== 'string' && typeof v !== 'number') return null
      out[key] = truncate(v)
    }
  }
  // At minimum a report must say which directive was violated and where.
  if (!out['violated-directive'] && !out['effective-directive']) return null
  if (!out['document-uri']) return null
  return out
}

/** Fixed-window limiter: IP -> { count, windowStart }. Bounded by sweep. */
const rateBuckets = new Map<string, { count: number; windowStart: number }>()

/** Test seam: clears the limiter so suites start from a fresh window. */
export function resetCspRateLimit(): void {
  rateBuckets.clear()
}

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(ip)
  if (!bucket || now - bucket.windowStart >= CSP_RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now })
    // Keep the map bounded: entries older than two windows are swept.
    if (rateBuckets.size > 1000) {
      for (const [k, b] of rateBuckets) {
        if (now - b.windowStart >= 2 * CSP_RATE_WINDOW_MS) rateBuckets.delete(k)
      }
    }
    return false
  }
  bucket.count += 1
  return bucket.count > CSP_RATE_LIMIT
}

/**
 * The draft policy. Kept here rather than inlined at each mount so the
 * header and the recorded rationale cannot drift apart.
 */
export function draftCsp(): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval' for the vendored Alpine's AsyncFunction evaluator
    // (§24.3); googletagmanager for GA4 and cdnjs for GSAP on the public
    // pages (§24.6). 'unsafe-inline' on script-src covers the 51 executable
    // inline blocks and the 54 handler attributes on the frozen pages —
    // report-only, so the report will show exactly how much.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data:",
    "connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

/** Mounts the Report-Only header on every response. */
export function cspReportOnly() {
  return async function cspReportOnly(_c: unknown, next: () => Promise<void>) {
    await next()
    const c = _c as { header: (k: string, v: string) => void }
    c.header('Content-Security-Policy-Report-Only', draftCsp())
  }
}

export const cspReportRoutes = new Hono<AppEnv>()

cspReportRoutes.post('/api/csp-report', async (c) => {
  // 1. Size cap before any parsing: a huge body costs nothing but a status.
  const length = Number(c.req.header('content-length') ?? '0')
  if (length > CSP_MAX_BODY_BYTES) {
    return c.json({ error: `CSP report exceeds ${CSP_MAX_BODY_BYTES} bytes.` }, 413)
  }
  const body = await c.req.text()
  if (body.length > CSP_MAX_BODY_BYTES) {
    return c.json({ error: `CSP report exceeds ${CSP_MAX_BODY_BYTES} bytes.` }, 413)
  }

  // 3. Rate limit per client IP, after the cheap size check.
  const ip = c.get('clientIp') ?? 'unknown'
  if (rateLimited(ip)) {
    return c.json({ error: 'Too many CSP reports from this address.' }, 429)
  }

  // 2. Shape validation: log recognised fields, truncated — never raw input.
  const violation = parseViolation(body)
  if (violation === null) {
    return c.json({ error: 'Body is not a recognised CSP violation report.' }, 422)
  }

  // Greppable one-line shape: TS:CO csp-violation {...truncated fields...}
  console.log(`TS:CO csp-violation ${JSON.stringify(violation).slice(0, CSP_MAX_LOG_LINE)}`)
  return c.body(null, 204)
})
