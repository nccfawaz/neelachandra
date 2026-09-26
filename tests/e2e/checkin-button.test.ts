import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { renderToString } from 'hono/jsx/dom/server'

/*
 * The check-in button as a phone actually renders it (DECISIONS 31.11).
 *
 * The panel is pressed at a site gate, on a phone, one-handed. This suite
 * loads the panel's markup with the REAL built stylesheet in real Chromium at
 * a phone viewport (390px, an iPhone-class width) and reads back the COMPUTED
 * values — width, height, background — and prints them, so the report carries
 * numbers a browser computed rather than numbers a stylesheet promised.
 *
 * The markup below mirrors checkinPanel() in src/dashboard/routes.tsx: the
 * card, the form, the button. It is duplicated deliberately — renderToString
 * against the real panel would need a request context; a mismatch between
 * this mirror and the panel is caught by served-css.test.ts, which fetches
 * /app through the real router and asserts the same declarations.
 */

const ROOT = path.resolve(__dirname, '../..')

/* geo: 'success' answers instantly, 'denied' errors instantly, 'slow' answers
 * after ~1.5 s (so the in-flight state can be asserted), 'timeout' never
 * answers (so the script's own 10.5 s deadline governs). */
function panelHtml(
  action: 'checkin' | 'checkout',
  withScript = true,
  geo: 'success' | 'denied' | 'slow' | 'timeout' = 'success',
  confirm: 'unavailable' | 'stored' | null = null,
): string {
  const buttonText = action === 'checkin' ? 'Check in' : 'Check out'
  // 36.2: mirror the REAL panel — one form, action always the check-in
  // endpoint, and the check-out button overriding it with formaction.
  const stub = {
    success: "Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: function (ok) { setTimeout(function () { ok({ coords: { latitude: 9.9312, longitude: 76.2673 } }) }, 0) } }, configurable: true })",
    denied: "Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: function (ok, err) { setTimeout(function () { err({ code: 1, message: 'denied' }) }, 0) } }, configurable: true })",
    slow: "Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: function (ok) { setTimeout(function () { ok({ coords: { latitude: 9.9312, longitude: 76.2673 } }) }, 1500) } }, configurable: true })",
    timeout: "Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: function () { /* never answers */ } }, configurable: true })",
  }[geo]
  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/css/dashboard.css">
<script>${stub}</script></head>
<body><main style="max-width:430px;margin:0 auto;padding:1rem">
<section class="ncc-card ncc-card--wide">
  <p class="ncc-kpi__label">Site attendance</p>
  <form method="post" action="/app/attendance/checkin" class="ncc-inline-form">
    <input type="hidden" name="nc_csrf" value="fixture">
    <input type="hidden" name="lat" value=""><input type="hidden" name="lng" value="">
    ${action === 'checkin' ? '<label class="ncc-field">Site<select name="siteKey"><option>OFFICE — Head office</option></select></label>' : '<p class="ncc-checkin-time">Checked in at 2026-09-24 08:12:44</p>'}
    ${action === 'checkin' ? '<button type="submit" class="ncc-checkin-btn">Check in</button>' : '<button type="submit" class="ncc-checkin-btn" formaction="/app/attendance/checkout">Check out</button>'}
    ${confirm === 'unavailable' ? '<p class="ncc-checkin-confirm" role="status">Checked in — location unavailable. Your attendance stands; the row is marked so HR can follow up if the site matters.</p>' : confirm === 'stored' ? '<p class="ncc-checkin-confirm" role="status">Location recorded at 2026-09-24 08:12:44</p>' : ''}
  </form>
  <p class="ncc-checkin-note">Location is recorded when you press the button — at check-in and check-out only. Your position is not tracked at any other time.</p>
</section>
</main>${withScript ? '<script src="/assets/js/checkin-geo.js" defer></script>' : ''}</body></html>`
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function startServer(geo: 'success' | 'denied' | 'slow' | 'timeout' = 'success'): Promise<{ server: Server; origin: string }> {
  const pages = new Map<string, string>([
    ['/', panelHtml('checkin', true, geo)],
    ['/checkout', panelHtml('checkout', true, geo)],
    // The post-press status line, in the shape the real panel renders it after
    // a check-in whose reading never arrived (routes.tsx: loc==='unavailable').
    ['/confirm-unavailable', panelHtml('checkout', true, geo, 'unavailable')],
  ])
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/' || url.pathname === '/checkout' || url.pathname === '/confirm-unavailable') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(pages.get(url.pathname))
      return
    }
    if (url.pathname.startsWith('/assets/')) {
      try {
        const file = path.join(ROOT, 'public', url.pathname.replace(/^\/+/, ''))
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404).end('not found')
      }
      return
    }
    if (req.method === 'POST') {
      // The intercepted submit lands here. Read the body so the test can
      // assert WHAT was posted (coords vs empty fields) and how many times.
      let chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        chunks = []
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<script>window.__posts = window.__posts || []; window.__posts.push(${JSON.stringify(url.pathname + ' ' + body)})</script><p>ok</p>`)
      })
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

describe('the check-in button as Chromium computes it on a phone', () => {
  it('is full width, at least 48px tall, brand #F48120 — computed from the served CSS', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      const computed = await page.$eval('.ncc-checkin-btn', (el) => {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          width: r.width,
          height: r.height,
          background: cs.backgroundColor,
          color: cs.color,
          minHeight: cs.minHeight,
          display: cs.display,
          fontSize: cs.fontSize,
        }
      })
      console.log('[checkin-button computed]', JSON.stringify(computed, null, 1))
      expect(computed.display).toBe('block')
      expect(computed.height, 'button must be at least 48px tall').toBeGreaterThanOrEqual(48)
      expect(computed.minHeight).toBe('48px')
      expect(computed.background).toBe('rgb(244, 129, 32)') // #F48120
      expect(computed.color).toBe('rgb(255, 255, 255)')
      // Full width: the button spans its form's content box (the card adds
      // its own 1.25rem padding each side; 358 - 40 ≈ 318).
      const formWidth = await page.$eval('form', (el) => el.getBoundingClientRect().width)
      expect(computed.width, 'button must span the form width').toBeCloseTo(formWidth, 0)
      expect(computed.width, 'button must fill the card padding-box edge to edge').toBeGreaterThan(
        300,
      )
      expect(parseFloat(computed.fontSize)).toBeGreaterThan(14)
    } finally {
      server.close()
      await page.close()
    }
  })

  it('shows one action at a time; the note is small and muted', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      // Check-in page: only "Check in".
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      const buttons = await page.$$eval('form button', (els) => els.map((e) => e.textContent?.trim()))
      expect(buttons).toEqual(['Check in'])

      // Check-out page: only "Check out", with the check-in time shown.
      await page.goto(origin + '/checkout', { waitUntil: 'networkidle' })
      const buttons2 = await page.$$eval('form button', (els) => els.map((e) => e.textContent?.trim()))
      expect(buttons2).toEqual(['Check out'])
      expect(await page.textContent('body')).toContain('Checked in at 2026-09-24 08:12:44')

      const note = await page.$eval('.ncc-checkin-note', (el) => {
        const cs = getComputedStyle(el)
        return { size: cs.fontSize, color: cs.color }
      })
      console.log('[checkin-note computed]', JSON.stringify(note))
      expect(parseFloat(note.size)).toBeLessThan(14)
      // Muted grey, not the body text colour.
      expect(note.color).not.toBe('rgb(32, 38, 47)')
    } finally {
      server.close()
      await page.close()
    }
  })

  /* The post-press status line (DECISIONS 31.13) is the only part of the
   * panel never measured on a phone. It renders inside the form after the
   * button when a press stored no reading — the worker's confirmation that
   * attendance stood without a location. On a 390px phone the two-sentence
   * "location unavailable" text is the longest string the panel shows, so it
   * is the overflow risk: assert its computed type AND that it wraps inside
   * the card rather than pushing a horizontal scrollbar. */
  it('the location-unavailable confirm line: computed type, and it wraps inside the card at 390px', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/confirm-unavailable', { waitUntil: 'networkidle' })
      const confirm = await page.$eval('.ncc-checkin-confirm', (el) => {
        const cs = getComputedStyle(el)
        const card = el.closest('.ncc-card')!.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return {
          text: el.textContent?.trim(),
          fontSize: cs.fontSize,
          color: cs.color,
          // Overflow: the line's own content never exceeds its box (it wraps),
          // and the box stays within the card's edges.
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          right: r.right,
          left: r.left,
          cardRight: card.right,
          cardLeft: card.left,
        }
      })
      console.log('[checkin-confirm computed]', JSON.stringify(confirm, null, 1))

      // The full real-panel text, not a shortened paraphrase.
      expect(confirm.text).toBe(
        'Checked in — location unavailable. Your attendance stands; the row is marked so HR can follow up if the site matters.',
      )
      // 0.9rem = 14.4px, semibold, --ncc-text (#20262f) — the confirmation is
      // primary text, deliberately not the muted grey of the note below it.
      expect(confirm.fontSize).toBe('14.4px')
      expect(confirm.color).toBe('rgb(32, 38, 47)')

      // No horizontal overflow: the text wrapped rather than running past its
      // own box (scrollWidth would exceed clientWidth if a word forced a
      // scroll), and the box sits within the card content edges.
      expect(confirm.scrollWidth, 'the confirm text must wrap, not overflow its box').toBeLessThanOrEqual(
        confirm.clientWidth,
      )
      expect(confirm.right, 'the confirm line must not spill past the card right edge').toBeLessThanOrEqual(
        confirm.cardRight,
      )
      expect(confirm.left, 'the confirm line stays within the card left edge').toBeGreaterThanOrEqual(
        confirm.cardLeft,
      )
    } finally {
      server.close()
      await page.close()
    }
  })

  /* DECISIONS 31.12/31.13: the capture happens AT THE PRESS. The script
   * intercepts the submit, disables the button with "Getting your
   * location…", asks once with high accuracy, and submits whether the
   * reading arrives, the user denies, or the device times out. These tests
   * execute the REAL served script against the mirrored panel with the
   * geolocation stub in three moods, and the test server records the POST
   * that must eventually leave. */
  it('SUCCESS path: press disables the button, fills fields, submits once with the reading', async () => {
    const { server, origin } = await startServer('slow')
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      await page.click('.ncc-checkin-btn')
      // In flight: disabled, asking, and a second press does nothing.
      expect(await page.$eval('.ncc-checkin-btn', (el: HTMLButtonElement) => el.disabled)).toBe(true)
      expect(await page.textContent('.ncc-checkin-btn')).toBe('Getting your location…')
      await page.click('.ncc-checkin-btn', { force: true }).catch(() => {})
      // The reading arrives, the fields are filled, the submit leaves
      // exactly once with the coordinates.
      await page.waitForFunction(() => (window as any).__posts?.length === 1, undefined, { timeout: 10000 })
      await page.waitForTimeout(300)
      expect((await page.evaluate(() => (window as any).__posts?.length)) as number).toBe(1)
      expect((await page.evaluate(() => (window as any).__posts?.[0])) as string).toMatch(/lat=9\.9312&lng=76\.2673/)
    } finally {
      server.close()
      await page.close()
    }
  })

  it('DENIAL path: press submits anyway with empty fields — attendance never refused on location', async () => {
    const { server, origin } = await startServer('denied')
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      // The stub denies instantly; the submit must leave regardless, with
      // empty fields (the server stores NULL/unavailable).
      await page.click('.ncc-checkin-btn')
      await page.waitForFunction(() => (window as any).__posts?.length === 1, undefined, { timeout: 5000 })
      const body = (await page.evaluate(() => (window as any).__posts?.[0])) as string
      expect(body).toContain('lat=&lng=')
    } finally {
      server.close()
      await page.close()
    }
  })

  it('TIMEOUT path: the device never answers; the submit still leaves after the 10s cap', async () => {
    const { server, origin } = await startServer('timeout')
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      await page.click('.ncc-checkin-btn')
      // Button held disabled while the device is being asked.
      await page.waitForTimeout(500)
      expect(await page.$eval('.ncc-checkin-btn', (el: HTMLButtonElement) => el.disabled)).toBe(true)
      // The script's own 10 s timeout fires, the error branch submits.
      await page.waitForFunction(() => (window as any).__posts?.length === 1, undefined, { timeout: 15000 })
      const body = (await page.evaluate(() => (window as any).__posts?.[0])) as string
      expect(body).toContain('lat=&lng=')
    } finally {
      server.close()
      await page.close()
    }
  })

  /* 36.2 (the production check-out failure): the panel is ONE form whose
   * action is the CHECK-IN endpoint; the check-out button overrides it with
   * formaction. form.submit() ignores formaction, so the old code posted the
   * check-out press to .../checkin and the two requests raced — the browser
   * cancelled the in-flight one ("(canceled)") and nothing saved. This test
   * presses the CHECK-OUT button and asserts exactly ONE POST leaves AND
   * that it went to the checkout endpoint, not the form's default action. */
  it('CHECK-OUT path: one POST per press, and it lands on the checkout endpoint (formaction honoured)', async () => {
    const { server, origin } = await startServer('slow')
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const postTargets: string[] = []
    try {
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/app/attendance')) postTargets.push(req.url())
      })
      await page.goto(origin + '/checkout', { waitUntil: 'networkidle' })
      await page.click('.ncc-checkin-btn')
      expect(await page.textContent('.ncc-checkin-btn')).toBe('Getting your location…')
      await page.waitForFunction(() => (window as any).__posts?.length === 1, undefined, { timeout: 10000 })
      await page.waitForTimeout(300)
      // One POST total — a second would have cancelled the first in flight.
      expect((await page.evaluate(() => (window as any).__posts?.length)) as number).toBe(1)
      // And it went to CHECKOUT, not the form's action (checkin).
      expect(postTargets).toHaveLength(1)
      expect(postTargets[0]).toContain('/app/attendance/checkout')
      const recorded = (await page.evaluate(() => (window as any).__posts?.[0])) as string
      expect(recorded.startsWith('/app/attendance/checkout'), 'the POST must land on the checkout endpoint, not the form\'s checkin action').toBe(true)
    } finally {
      server.close()
      await page.close()
    }
  })

  it('logs a loud warning instead of failing silently when the form is missing', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const consoleLines: string[] = []
    page.on('console', (m) => consoleLines.push(m.text()))
    try {
      // Serve a page with no check-in form at all: the script must still
      // run (it is injected unconditionally by the shell on this route in
      // the bug report) and must not vanish without a trace.
      await page.setContent('<!doctype html><html><head></head><body><p>no form here</p></body></html>')
      await page.addScriptTag({ path: path.join(ROOT, 'public/assets/js/checkin-geo.js') })
      await page.waitForTimeout(3600) // past the 10×300ms retry window
      const warned = consoleLines.some((l) => l.includes('[checkin-geo]'))
      expect(warned, 'the script must log [checkin-geo] when it cannot bind').toBe(true)
    } finally {
      server.close()
      await page.close()
    }
  })
})
