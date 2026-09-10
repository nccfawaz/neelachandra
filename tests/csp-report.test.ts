import { describe, expect, it } from 'vitest'
import { draftCsp, CSP_REPORT_PATH } from '../src/middleware/cspReport.js'

/**
 * The CSP Report-Only header and the violation collector (§24, DECISIONS
 * 29.24). TOLERANCE 0: the header is Report-Only, so nothing here can change
 * what a page executes — the test pins that the header is SENT, that it is
 * the Report-Only variant and not the enforcing one, and that the draft
 * policy carries exactly the two documented concessions ('unsafe-eval' for
 * the vendored Alpine build, 'unsafe-inline' on style-src for the frozen
 * pages) without a nonce that would be ignored anyway.
 */

// The middleware is a plain Hono middleware; exercise it on a scratch app so
// the test does not depend on app.ts's full route tree (which needs env/db).
import { Hono } from 'hono'
import { cspReportOnly, cspReportRoutes } from '../src/middleware/cspReport.js'

const probe = new Hono()
probe.use('*', cspReportOnly())
probe.get('/anywhere', (c) => c.text('ok'))
probe.route('/', cspReportRoutes)

describe('CSP Report-Only (§29.24)', () => {
  it('stamps Content-Security-Policy-Report-Only on every response, and never the enforcing header', async () => {
    const res = await probe.fetch(new Request('http://localhost/anywhere'))
    expect(res.status).toBe(200)
    const reportOnly = res.headers.get('content-security-policy-report-only')
    expect(reportOnly, 'the Report-Only header is missing — violations would go uncollected').toBeTruthy()
    // The enforcing header must stay absent: TOLERANCE 0 forbids a policy
    // that changes what executes.
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('the draft policy carries the two documented concessions and no nonce', () => {
    const p = draftCsp()
    expect(p).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    // The vendored Alpine standard build needs 'unsafe-eval' (§24.3); if it
    // is ever dropped, the CSP build must be vendored first.
    expect(p).toContain("'unsafe-eval'")
    expect(p).toContain("style-src 'self' 'unsafe-inline'")
    // A nonce alongside 'unsafe-inline' is ignored by browsers — the two are
    // mutually exclusive — so the draft must not carry one.
    expect(p).not.toMatch(/'nonce-/)
    expect(p).toContain("default-src 'self'")
  })

  it('the collector accepts a violation report and answers 204', async () => {
    const violation = {
      'csp-report': {
        'document-uri': 'http://localhost/app/dashboard',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
        'original-policy': draftCsp(),
        'blocked-uri': 'inline',
        'source-file': 'http://localhost/app/hr/attendance',
        'line-number': 1430,
      },
    }
    const res = await probe.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify(violation),
    })
    expect(res.status).toBe(204)
  })

  it('the collector refuses a malformed body with 422, not a crash (29.27)', async () => {
    const res = await probe.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(422)
  })
})
