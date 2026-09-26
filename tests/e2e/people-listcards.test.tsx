import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { renderToString } from 'hono/jsx/dom/server'
import { DataTable, StatusBadge, type Column, type CardDescriptor } from '../../src/dashboard/components/index.js'

/*
 * The designed People list card as a phone actually renders it (DECISIONS 38).
 *
 * The generic 37.4 transpose turned the Employees list into seven label/value
 * rows per person — correct, unreadable. §38 replaces it with a purpose-built
 * card: a primary line (name + code), one secondary line, a status, the whole
 * card a link to the detail page. This suite renders the REAL DataTable with a
 * `card` descriptor (the same component and prop the People routes pass),
 * loads it with the REAL built stylesheet in real Chromium, and reads back the
 * COMPUTED values at both a phone width and a desktop width: on the phone the
 * table is hidden and the cards show; on the desktop the cards are hidden and
 * the table shows. The card is a plain <a>, so navigation works with JS off.
 *
 * served-css.test.ts asserts the same .ncc-listcard / .ncc-carded rules reach
 * the browser through the real router, so this mirror cannot silently drift.
 */

const ROOT = path.resolve(__dirname, '../..')

interface Row {
  id: number
  full_name: string
  employee_code: string
  designation: string
  department: string
  status: string
}

const columns: Column<Row>[] = [
  { header: 'Employee', cell: (r) => r.full_name },
  { header: 'Designation', cell: (r) => r.designation },
  { header: 'Department', cell: (r) => r.department },
  { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
]

const card: CardDescriptor<Row> = {
  href: (r) => `/app/hr/employees/${r.id}`,
  primary: (r) => (
    <>
      <strong>{r.full_name}</strong>
      <span class="ncc-listcard__code">{r.employee_code}</span>
    </>
  ),
  secondary: (r) => `${r.designation} · ${r.department}`,
  status: (r) => <StatusBadge status={r.status} />,
}

const rows: Row[] = [
  { id: 1, full_name: 'Ramesh Kumar Nair', employee_code: 'EMP001', designation: 'Site Engineer', department: 'Projects', status: 'active' },
  { id: 2, full_name: 'Sunil Varghese', employee_code: 'EMP002', designation: 'Foreman', department: 'Projects', status: 'suspended' },
]

function pageHtml(): string {
  const table = renderToString(DataTable<Row>({ columns, rows, card }) as never)
  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/css/dashboard.css"></head>
<body><main style="padding:1rem">${table}</main></body></html>`
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function startServer(): Promise<{ server: Server; origin: string }> {
  const html = pageHtml()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
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

describe('the designed People list card as Chromium computes it', () => {
  it('at 390px: the transposed table is hidden, the cards show, and each card is a 48px link to the detail page', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })

      const tableDisplay = await page.$eval('.ncc-table-scroll.ncc-carded', (el) => getComputedStyle(el).display)
      const listDisplay = await page.$eval('.ncc-listcards', (el) => getComputedStyle(el).display)
      console.log('[listcards 390 display]', JSON.stringify({ tableDisplay, listDisplay }))
      expect(tableDisplay, 'the carded table is hidden on a phone').toBe('none')
      expect(listDisplay, 'the designed cards show on a phone').not.toBe('none')

      // The whole card is a link to the detail page, and it is at least one
      // tap target tall — navigation works with no script on the page.
      const link = await page.$eval('.ncc-listcard', (el) => {
        const r = el.getBoundingClientRect()
        return { tag: el.tagName, href: el.getAttribute('href'), minHeight: getComputedStyle(el).minHeight, height: r.height }
      })
      console.log('[listcard link]', JSON.stringify(link))
      expect(link.tag).toBe('A')
      expect(link.href).toBe('/app/hr/employees/1')
      expect(link.minHeight).toBe('48px')
      expect(link.height, 'the card is at least one tap target tall').toBeGreaterThanOrEqual(48)

      // The primary line carries the name and code; the secondary the two
      // chosen fields; there are exactly as many cards as rows.
      const cardCount = await page.$$eval('.ncc-listcard', (els) => els.length)
      expect(cardCount).toBe(rows.length)
      const firstText = await page.$eval('.ncc-listcard', (el) => el.textContent?.replace(/\s+/g, ' ').trim())
      expect(firstText).toContain('Ramesh Kumar Nair')
      expect(firstText).toContain('EMP001')
      expect(firstText).toContain('Site Engineer · Projects')

      // The card must not push a horizontal scrollbar at 390px.
      const overflow = await page.$eval('.ncc-listcard', (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
      expect(overflow.sw, 'the card content must not overflow its box').toBeLessThanOrEqual(overflow.cw)
    } finally {
      server.close()
      await page.close()
    }
  })

  it('at desktop width: the table shows and the cards are hidden', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      const tableDisplay = await page.$eval('.ncc-table-scroll.ncc-carded', (el) => getComputedStyle(el).display)
      const listDisplay = await page.$eval('.ncc-listcards', (el) => getComputedStyle(el).display)
      console.log('[listcards desktop display]', JSON.stringify({ tableDisplay, listDisplay }))
      expect(tableDisplay, 'the table shows on desktop').not.toBe('none')
      expect(listDisplay, 'the cards are hidden on desktop').toBe('none')

      // The full table is present on desktop — all four columns, both rows.
      const headerCount = await page.$$eval('.ncc-table thead th', (els) => els.length)
      expect(headerCount).toBe(columns.length)
    } finally {
      server.close()
      await page.close()
    }
  })
})
