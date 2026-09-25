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

function panelHtml(action: 'checkin' | 'checkout', withScript = true): string {
  const buttonText = action === 'checkin' ? 'Check in' : 'Check out'
  const formAction = action === 'checkin' ? '/app/attendance/checkin' : '/app/attendance/checkout'
  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/css/dashboard.css">
<script>
  // A fixed fake position, installed before any page script can ask.
  Object.defineProperty(navigator, 'geolocation', {
    value: {
      getCurrentPosition: function (ok) {
        setTimeout(function () { ok({ coords: { latitude: 9.9312, longitude: 76.2673 } }) }, 0)
      },
    },
    configurable: true,
  })
</script></head>
<body><main style="max-width:430px;margin:0 auto;padding:1rem">
<section class="ncc-card ncc-card--wide">
  <p class="ncc-kpi__label">Site attendance</p>
  <form method="post" action="${formAction}" class="ncc-inline-form">
    <input type="hidden" name="nc_csrf" value="fixture">
    <input type="hidden" name="lat" value=""><input type="hidden" name="lng" value="">
    ${action === 'checkin' ? '<label class="ncc-field">Site<select name="siteKey"><option>OFFICE — Head office</option></select></label>' : '<p class="ncc-checkin-time">Checked in at 2026-09-24 08:12:44</p>'}
    <button type="submit" class="ncc-checkin-btn">${buttonText}</button>
  </form>
  <p class="ncc-checkin-note">Location is recorded when you press the button — at check-in and check-out only. Your position is not tracked at any other time.</p>
</section>
</main>${withScript ? '<script src="/assets/js/checkin-geo.js" defer></script>' : ''}</body></html>`
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function startServer(): Promise<{ server: Server; origin: string }> {
  const pages = new Map<string, string>([
    ['/', panelHtml('checkin')],
    ['/checkout', panelHtml('checkout')],
  ])
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/' || url.pathname === '/checkout') {
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

  /* DECISIONS 31.12 (execution-order bug): on production the fields never
   * filled even though the form and inputs were in the DOM. The script used
   * to query the DOM immediately from a deferred head script and exit
   * silently on a miss. These tests execute the REAL served script against
   * the mirrored panel and assert the hidden inputs actually receive the
   * device's position -- and that a formless page logs a warning instead of
   * failing silently. */
  it('fills the lat/lng hidden inputs from the served script (geolocation stubbed)', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const consoleLines: string[] = []
    page.on('console', (m) => consoleLines.push(m.text()))
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      await page.waitForFunction(
        () => {
          const lat = document.querySelector('input[name="lat"]') as HTMLInputElement | null
          const lng = document.querySelector('input[name="lng"]') as HTMLInputElement | null
          return !!lat && !!lng && lat.value !== '' && lng.value !== ''
        },
        undefined,
        { timeout: 5000 },
      )
      const values = await page.evaluate(() => ({
        lat: (document.querySelector('input[name="lat"]') as HTMLInputElement).value,
        lng: (document.querySelector('input[name="lng"]') as HTMLInputElement).value,
      }))
      expect(values).toEqual({ lat: '9.9312', lng: '76.2673' })
      expect(consoleLines.some((l) => l.includes('[checkin-geo]'))).toBe(false)
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
