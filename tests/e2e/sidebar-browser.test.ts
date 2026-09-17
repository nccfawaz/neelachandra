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

      // Sidebar background, computed.
      const bg = await page.$eval('.ncc-sidebar', (el) => getComputedStyle(el).backgroundColor)
      expect(bg, 'sidebar computed background').toBe('rgb(245, 247, 250)') // #f5f7fa

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
