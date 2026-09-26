import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { renderToString } from 'hono/jsx/dom/server'
import { AppShell } from '../../src/dashboard/layouts/AppShell.js'
import { PERMISSIONS } from '../../src/lib/permissions.js'

/**
 * The sidebar in a real browser (DECISIONS 29.60).
 *
 * Three committed visual fixes were invisible live because the stylesheet is
 * vite's build output in public/assets/css, not the source file the sessions
 * edited. A renderToString test cannot see any of that, so this suite loads
 * the REAL AppShell markup with the REAL built stylesheet in real Chromium
 * and reads back the COMPUTED values — background, layout, logo box.
 */

const ROOT = path.resolve(__dirname, '../..')

const USER = {
  id: 1,
  email: 'fixture@example.invalid',
  fullName: 'Fixture User',
  role: 'admin',
  status: 'active',
} as never

const PERMS = new Set<string>(Object.values(PERMISSIONS))

function shellHtml(): string {
  const node = AppShell({
    title: 'Dashboard',
    user: USER,
    perms: PERMS,
    csrfToken: 'fixture-csrf',
    path: '/app',
    children: null,
  })
  return '<!doctype html><html lang="en">' + renderToString(node as never) + '</html>'
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function startServer(): Promise<{ server: Server; origin: string }> {
  const html = shellHtml()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    // /app-sw.js mirrors the production root route (Service-Worker-Allowed
    // is not needed here -- the fixture server has no scope restriction).
    if (url.pathname === '/app-sw.js') {
      try {
        const body = await readFile(path.join(ROOT, 'public/assets/app-sw.js'))
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        res.end(body)
      } catch {
        res.writeHead(404).end('not found')
      }
      return
    }
    if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico') {
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

describe('the sidebar as a browser actually renders it', () => {
  it('shows the light background, block disabled items and a contained logo', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })

      // Sidebar background, computed. Since DECISIONS 38 the page background
      // token is #f5f7fa — the colour the sidebar itself used to be. To keep
      // the two distinct the sidebar is now white (var(--ncc-surface)) with a
      // right border; assert the white AND that it differs from the body, so a
      // regression that let them merge again goes red.
      const bg = await page.$eval('.ncc-sidebar', (el) => getComputedStyle(el).backgroundColor)
      expect(bg, 'sidebar computed background is white surface').toBe('rgb(255, 255, 255)')

      const bodyBg = await page.$eval('body', (el) => getComputedStyle(el).backgroundColor)
      expect(bg, 'sidebar must not merge into the page background').not.toBe(bodyBg)

      const border = await page.$eval('.ncc-sidebar', (el) => getComputedStyle(el).borderRightWidth)
      expect(parseFloat(border), 'sidebar carries a right border to separate it from the page').toBeGreaterThan(0)

      // Sidebar computed width — the number the earlier fixed 190px logo missed.
      const sidebarWidth = await page.$eval('.ncc-sidebar', (el) => getComputedStyle(el).width)
      expect(sidebarWidth).toBe('232px')

      // Disabled items: block layout, same horizontal padding as links.
      const disabled = await page.$$eval('.ncc-navlink--disabled', (els) =>
        els.map((el) => {
          const cs = getComputedStyle(el)
          return { display: cs.display, pad: cs.paddingLeft, tag: el.tagName }
        }),
      )
      expect(disabled.length).toBeGreaterThan(0)
      for (const d of disabled) {
        expect(d.display, 'disabled items must be block-level').toBe('block')
        expect(parseFloat(d.pad)).toBeGreaterThan(0)
      }

      // Logo: the image exists, is visible, and never exceeds its rail.
      const logo = await page.$eval('.ncc-sidebar__lockup', (el) => {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          display: cs.display,
          width: r.width,
          height: r.height,
          overflow: r.width <= 232,
        }
      })
      expect(logo.display).toBe('block')
      expect(logo.width, 'logo must not exceed the sidebar rail').toBeLessThanOrEqual(232)
      expect(logo.height).toBeGreaterThan(20)

      expect(errors, `page errors: ${errors.join('; ')}`).toEqual([])
    } finally {
      await page.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('renders nothing outside the rail: no horizontal overflow of the brand block', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      const overflow = await page.$eval('.ncc-sidebar__brand', (el) => {
        const brand = el.getBoundingClientRect()
        const sidebar = el.closest('.ncc-sidebar')!.getBoundingClientRect()
        return { brandRight: brand.right, sidebarRight: sidebar.right, fits: brand.right <= sidebar.right }
      })
      expect(overflow.fits, `brand block overflows the rail: ${JSON.stringify(overflow)}`).toBe(true)
    } finally {
      await page.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

/*
 * The off-canvas drawer as a phone renders it (DECISIONS 37.2).
 *
 * On a 390px phone the sidebar must be OFF the screen until the menu button
 * opens it, and the whole mechanism is pure CSS: a visually-hidden checkbox
 * and two <label>s. Clicking the label is a native browser action — no page
 * script runs — so a sidebar that slides in after the click proves the
 * "works with JavaScript off" contract for navigation, read back from the
 * COMPUTED geometry Chromium reports, not from the markup.
 */
describe('the nav drawer as Chromium computes it on a phone', () => {
  it('hides the sidebar off-canvas at 390px and reveals it with the CSS-only menu toggle', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })

      // The menu button is shown on a phone (it is display:none on desktop).
      // The rule sets inline-flex, but the topbar is itself a flex container,
      // so the button is a flex item and Chromium blockifies its used display
      // to `flex` — the point of the assertion is that it is not `none`.
      const btnDisplay = await page.$eval('.ncc-nav-btn', (el) => getComputedStyle(el).display)
      expect(btnDisplay, 'the menu button must be shown on a phone').toBe('flex')

      // Closed: the sidebar sits entirely left of the viewport (translateX
      // -100%), so its right edge is at or before x=0 and it cannot be tapped.
      const closed = await page.$eval('.ncc-sidebar', (el) => {
        const r = el.getBoundingClientRect()
        return { right: r.right, width: r.width, transform: getComputedStyle(el).transform }
      })
      console.log('[drawer closed]', JSON.stringify(closed))
      expect(closed.width, 'the drawer has real width').toBeGreaterThan(200)
      expect(closed.right, 'the closed drawer is off the left edge').toBeLessThanOrEqual(1)
      // A non-identity transform is what puts it there.
      expect(closed.transform).not.toBe('none')

      // Open it the way a user does with JS off: click the menu <label>. That
      // flips the checkbox natively; no script on the page is involved. Wait
      // out the 0.2s slide-in transition before reading the settled geometry.
      await page.click('.ncc-nav-btn')
      await page.waitForTimeout(350)

      const open = await page.$eval('.ncc-sidebar', (el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right }
      })
      console.log('[drawer open]', JSON.stringify(open))
      expect(open.left, 'the opened drawer starts at the left edge').toBeGreaterThanOrEqual(-1)
      expect(open.right, 'the opened drawer is on screen').toBeGreaterThan(200)

      // The backdrop appears with the open drawer and closes it when tapped.
      const backdrop = await page.$eval('.ncc-nav-backdrop', (el) => getComputedStyle(el).display)
      expect(backdrop, 'the backdrop is shown while the drawer is open').toBe('block')

      // Tap the backdrop where it is actually exposed — to the RIGHT of the
      // 264px drawer, which sits above it. A user taps the dimmed area beside
      // the menu; the drawer itself would swallow a centre tap.
      await page.click('.ncc-nav-backdrop', { position: { x: 340, y: 400 } })
      await page.waitForTimeout(350)
      const reclosed = await page.$eval('.ncc-sidebar', (el) => el.getBoundingClientRect().right)
      expect(reclosed, 'tapping the backdrop closes the drawer').toBeLessThanOrEqual(1)
    } finally {
      await page.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
