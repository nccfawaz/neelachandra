import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  cspReportOnly,
  cspReportRoutes,
  draftCsp,
  CSP_REPORT_PATH,
  CSP_MAX_BODY_BYTES,
  resetCspRateLimit,
} from '../src/middleware/cspReport.js'

/**
 * CSP violation collector hardening (DECISIONS 29.27).
 *
 * The collector is unauthenticated by design (§29.24: reports are generated
 * by the browser, not a session). That makes it an anonymous write endpoint,
 * so it carries the three controls an anonymous endpoint must have, each
 * proven here:
 *   1. size cap        — a body over the cap is refused before parsing;
 *   2. shape validator — only the recognised CSP report shape is logged, and
 *      every field is truncated, so no raw attacker-controlled payload
 *      reaches the log;
 *   3. rate limit      — a flood is refused with 429 once the window budget
 *      is spent, so the log cannot be filled by loop.
 * A valid report still lands (204 and logged) after all of that.
 */

function build() {
  resetCspRateLimit()
  const probe = new Hono()
  probe.use('*', cspReportOnly())
  probe.route('/', cspReportRoutes)
  return probe
}

function report(over: Record<string, unknown> = {}) {
  return {
    'csp-report': {
      'document-uri': 'http://localhost/app/dashboard',
      'violated-directive': 'script-src',
      'effective-directive': 'script-src',
      'original-policy': draftCsp(),
      'blocked-uri': 'inline',
      'source-file': 'http://localhost/app/hr/attendance',
      'line-number': 1430,
      ...over,
    },
  }
}

describe('CSP collector hardening (DECISIONS 29.27)', () => {
  it('refuses an oversized body with 413 before parsing it', async () => {
    const probe = build()
    const big = 'x'.repeat(CSP_MAX_BODY_BYTES + 1)
    const res = await probe.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: big,
    })
    expect(res.status).toBe(413)
  })

  it('refuses a body that is not the recognised report shape with 422', async () => {
    const probe = build()
    // JSON, but not a csp-report envelope.
    const res1 = await probe.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res1.status).toBe(422)
    // The envelope, but every field the wrong type — a shaped attack on the log.
    const res2 = await probe.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'document-uri': 42, 'violated-directive': { x: 1 } } }),
    })
    expect(res2.status).toBe(422)
    // Not JSON at all.
    const res3 = await probe.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'garbage',
    })
    expect(res3.status).toBe(422)
  })

  it('rate-limits a flood with 429 once the window budget is spent', async () => {
    const probe = build()
    let last = 0
    let saw429 = false
    for (let i = 0; i < 40; i++) {
      const res = await probe.request(CSP_REPORT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify(report()),
      })
      last = res.status
      if (res.status === 429) {
        saw429 = true
        break
      }
    }
    expect(saw429, `a 40-request flood never hit 429 (last status ${last}) — the limiter is not engaged`).toBe(true)
  })

  it('a valid report still records: 204, and the logged fields are truncated', async () => {
    const probe = build()
    const longUri = 'http://localhost/app/' + 'a'.repeat(5000)
    const res = await probe.request(CSP_REPORT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify(report({ 'document-uri': longUri })),
    })
    expect(res.status).toBe(204)
    // Nothing else to assert in-process without capturing the log; the
    // truncation itself is proven by the next test.
  })

  it('the log line carries truncated fields, never the raw payload', async () => {
    const probe = build()
    const longUri = 'http://localhost/app/' + 'a'.repeat(5000)
    const logged: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }
    try {
      await probe.request(CSP_REPORT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify(report({ 'document-uri': longUri })),
      })
    } finally {
      console.log = orig
    }
    const line = logged.find((l) => l.includes('csp-violation'))
    expect(line, 'no csp-violation log line was written for a valid report').toBeTruthy()
    expect(line!.length, 'the log line is as long as the raw payload — truncation did not run').toBeLessThan(2000)
    expect(line).toContain('csp-violation')
  })
})
