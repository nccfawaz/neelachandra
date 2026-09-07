import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'

import { AttendanceGrid } from '../../src/modules/hr/routes.js'

/**
 * The keyboard-shortcut hint must not appear unless the shortcuts are bound.
 *
 * There are three states a client component can be in, and DECISIONS 22 recorded
 * only two of them:
 *
 *   1. the script never ran        -- JavaScript off, blocked, failed to load
 *   2. the script ran and Alpine could not evaluate its expressions
 *   3. everything worked
 *
 * State 2 is the one that cost a defect. `x-cloak` was the hint's visibility
 * mechanism, and Alpine's cloak handler evaluates no expression: it strips the
 * attribute on any element it walks, including one whose `x-data` just failed
 * under a Content-Security-Policy with no 'unsafe-eval'. The sentence "Arrows
 * move ... a letter sets the status" therefore appeared over a grid where no key
 * did anything, which is worse than no hint at all -- a user who trusts it edits
 * the wrong cell and does not know it.
 *
 * The fix is that visibility now comes from the component: the paragraph ships
 * `hidden` and `init()` removes it. init() runs only in state 3.
 *
 * WHY A BROWSER. Every assertion below is invisible to the other two suites. The
 * server-rendered HTML is byte-identical in all three states -- that is the whole
 * problem -- so a render-to-string test can only check that `hidden` is present,
 * not that anything ever removes it or that a policy prevents the removal. The
 * CSP case in particular cannot be simulated: it needs a browser refusing to
 * construct a function from a string because of a header. State 2 is asserted
 * here by sending exactly that header.
 *
 * WHAT IS REAL HERE. The component is imported and rendered, not copied. The
 * page loads the shipped `public/assets/vendor/alpine.min.js` and the shipped
 * `public/assets/js/attendance-grid.js` off a local server, so the evaluator
 * under test is the vendored one. The only fabrication is the props and the
 * surrounding document, neither of which the hint's visibility depends on.
 */

const ROOT = path.resolve(__dirname, '../..')

/** Renders the real component with the minimum props that make cells editable. */
function gridHtml(): string {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03']
  const roster = [
    {
      id: 1,
      employee_code: 'E001',
      full_name: 'Fixture Row',
      father_or_spouse_name: null,
      gender: null,
      // Well before the days above, so cellOptions() offers a control on each.
      date_of_joining: '2020-01-01',
      date_of_exit: null,
      status: 'active',
      department_name: null,
      designation_name: null,
    },
  ]

  const node = AttendanceGrid({
    csrf: 'fixture-csrf-token',
    month: '2026-09',
    page: 1,
    days,
    roster,
    byKey: new Map(),
    leave: [],
    projects: [],
    canRecord: true,
    canOverride: false,
    filtered: false,
    lockedOut: false,
  })

  return String(node)
}

/**
 * The document shell, reduced to what the hint depends on: the stylesheet, htmx,
 * the component script and Alpine deferred in AppShell's order -- component
 * BEFORE Alpine, see the comment there for why that order is load bearing.
 * Written to match src/dashboard/layouts/AppShell.tsx rather than to import it,
 * since AppShell needs a session and a nav tree that have nothing to do with
 * this.
 */
function page(body: string, opts: { script: boolean }): string {
  const scripts = opts.script
    ? `<script src="/assets/vendor/htmx.min.js" defer></script>
       <script src="/assets/js/attendance-grid.js" defer></script>
       <script src="/assets/vendor/alpine.min.js" defer></script>`
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <link rel="stylesheet" href="/assets/css/dashboard.css">${scripts}
    </head><body>${body}</body></html>`
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/**
 * Serves the page and the real asset tree. `csp`, when set, goes out as a
 * genuine Content-Security-Policy response header so the browser enforces it;
 * setting it any other way (a <meta> tag, a Playwright flag) would test
 * something other than what the server will send.
 */
function startServer(csp: string | null): Promise<{ server: Server; origin: string }> {
  const html = page(gridHtml(), { script: true })
  const noScript = page(gridHtml(), { script: false })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/' || url.pathname === '/no-script') {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
      if (csp) headers['content-security-policy'] = csp
      res.writeHead(200, headers)
      res.end(url.pathname === '/' ? html : noScript)
      return
    }

    if (url.pathname.startsWith('/assets/')) {
      try {
        const file = path.join(ROOT, 'public', url.pathname.replace(/^\/+/, ''))
        const body = await readFile(file)
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        })
        res.end(body)
      } catch {
        res.writeHead(404).end('not found')
      }
      return
    }

    res.writeHead(404).end('not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
})

/**
 * Loads the page and reports what the user would see. `visible` is Playwright's
 * own visibility check, which resolves `hidden`, `display:none` and zero size
 * together -- the question is what the reader sees, not which mechanism hid it.
 */
async function loadHint(
  csp: string | null,
  route: '/' | '/no-script' = '/'
): Promise<{ visible: boolean; present: boolean; errors: string[] }> {
  const { server, origin } = await startServer(csp)
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))

  try {
    await page.goto(origin + route, { waitUntil: 'networkidle' })
    const hint = page.locator('[data-keyboard-hint]')
    return {
      visible: await hint.isVisible(),
      present: (await hint.count()) > 0,
      errors,
    }
  } finally {
    await page.close()
    await new Promise<void>((r) => server.close(() => r()))
  }
}

describe('the attendance keyboard hint appears only when the shortcuts are bound', () => {
  it('ships hidden in the server-rendered markup', () => {
    const html = gridHtml()
    expect(html).toContain('data-keyboard-hint')
    expect(html).toMatch(/<p[^>]*data-keyboard-hint[^>]*hidden/)
    // The mechanism it replaced. If x-cloak comes back on this element the
    // state-2 case returns silently, so its absence is asserted rather than
    // assumed. DECISIONS 24.4.
    expect(html).not.toContain('x-cloak')
  })

  it('state 3, everything worked: init() reveals it', async () => {
    const { visible, present } = await loadHint(null)
    expect(present).toBe(true)
    expect(visible).toBe(true)
  })

  it('state 1, the script never ran: it stays hidden', async () => {
    const { visible, present } = await loadHint(null, '/no-script')
    expect(present).toBe(true)
    expect(visible).toBe(false)
  })

  /**
   * State 2, and the reason this file exists.
   *
   * `script-src 'self'` with no 'unsafe-eval' is the strict policy the comment
   * at src/app.ts:47-55 describes and never sends (DECISIONS 24.2). Under it the
   * vendored Alpine loads and initialises -- it is same-origin -- but its
   * evaluator is `new AsyncFunction(...)` over a `with (scope)` body, so every
   * x- expression on the form throws. init() never runs.
   *
   * The console assertion is what distinguishes this from state 1. Without it a
   * misconfigured server that simply failed to deliver alpine.min.js would
   * satisfy the visibility check and the test would pass while proving nothing.
   */
  it("state 2, Alpine loaded but its evaluator is blocked: it stays hidden", async () => {
    const { visible, present, errors } = await loadHint("default-src 'self'; script-src 'self'")

    expect(present).toBe(true)
    expect(visible).toBe(false)

    const blocked = errors.filter((e) => /unsafe-eval|EvalError|Alpine Expression Error/i.test(e))
    expect(
      blocked.length,
      `expected the CSP to block Alpine's evaluator; console said: ${errors.join(' | ')}`
    ).toBeGreaterThan(0)
  })
})
