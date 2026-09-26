import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { renderToString } from 'hono/jsx/dom/server'
import { DataTable, type Column } from '../../src/dashboard/components/index.js'

/*
 * The attendance matrix's sideways scroll as a phone actually renders it
 * (DECISIONS 37.4).
 *
 * The matrix is the one table allowed to scroll sideways instead of stacking
 * to cards, so on a 390px phone the scroll must be an OBVIOUS affordance —
 * an edge shadow, not an invisible one. This suite renders the REAL DataTable
 * component (the same one every screen uses, the same one the matrix form
 * wraps at src/modules/hr/routes.tsx) inside a real `.ncc-matrix` form, loads
 * it with the REAL built stylesheet in real Chromium at 390×844, and reads
 * back the COMPUTED values: that the wrapper actually overflows, and that the
 * pure-CSS edge-shadow layers are computed on it.
 *
 * The scroll wrapper (`.ncc-table-scroll`) and its class come from the real
 * component, not hand-typed markup; the `.ncc-matrix` form is one literal
 * class matching the real form. served-css.test.ts asserts the same CSS
 * reaches the browser through the real router, so the two cannot drift.
 */

const ROOT = path.resolve(__dirname, '../..')

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1))

interface Row {
  name: string
  days: string[]
}

const columns: Column<Row>[] = [
  { header: 'Employee', cell: (r) => r.name },
  ...DAYS.map(
    (d): Column<Row> => ({ header: d, cell: (r) => r.days[Number(d) - 1] ?? '' }),
  ),
]

const rows: Row[] = [
  { name: 'Ramesh Kumar Nair', days: DAYS.map(() => 'P') },
  { name: 'Sunil Varghese', days: DAYS.map(() => 'P') },
]

function pageHtml(): string {
  // The real DataTable output (its `.ncc-table-scroll` wrapper and table),
  // wrapped in the matrix form exactly as the roster screen composes it.
  const table = renderToString(DataTable<Row>({ columns, rows }) as never)
  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/css/dashboard.css"></head>
<body><main style="max-width:100vw;padding:1rem">
<form class="ncc-matrix" method="post" action="/api/hr/attendance/grid">${table}</form>
</main></body></html>`
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
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

describe('the attendance matrix scroll affordance as Chromium computes it on a phone', () => {
  it('overflows sideways at 390px and carries a computed edge-shadow — not an invisible scroll', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      const computed = await page.$eval('.ncc-table-scroll', (el) => {
        const cs = getComputedStyle(el)
        return {
          overflowX: cs.overflowX,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          backgroundImage: cs.backgroundImage,
          backgroundAttachment: cs.backgroundAttachment,
          backgroundRepeat: cs.backgroundRepeat,
          backgroundSize: cs.backgroundSize,
        }
      })
      console.log('[matrix-scroll computed]', JSON.stringify(computed, null, 1))

      // The wrapper is a horizontal scroller.
      expect(computed.overflowX).toBe('auto')
      // And it ACTUALLY overflows at a phone width — the affordance has
      // something to point at, this is not a table that happens to fit.
      expect(
        computed.scrollWidth,
        `matrix must be wider than the 390px viewport (scrollWidth ${computed.scrollWidth} > clientWidth ${computed.clientWidth})`,
      ).toBeGreaterThan(computed.clientWidth)

      // The pure-CSS edge shadow is computed on the element: two radial
      // shadow layers plus the two surface-coloured cover layers, the cover
      // layers pinned to the content (local) and the shadow layers to the
      // scroll box (scroll) so a shadow shows only while more table is hidden.
      const radialCount = (computed.backgroundImage.match(/radial-gradient/g) ?? []).length
      expect(radialCount, 'two radial-gradient shadow layers must be computed').toBe(2)
      expect(computed.backgroundImage).toContain('linear-gradient')
      expect(computed.backgroundAttachment).toBe('local, local, scroll, scroll')
      expect(computed.backgroundRepeat).toBe('no-repeat, no-repeat, no-repeat, no-repeat')

      // The scroll genuinely moves (a dead affordance would be worse than none).
      const scrolled = await page.$eval('.ncc-table-scroll', (el) => {
        el.scrollLeft = 9999
        return el.scrollLeft
      })
      expect(scrolled, 'the wrapper must scroll horizontally').toBeGreaterThan(0)
    } finally {
      server.close()
      await page.close()
    }
  })

  /* DECISIONS 38: the read-only AttendanceGrid branch and the muster roll used
   * a plain DataTable and so STACKED to cards on a phone — a 31-day roster is
   * unreadable stacked. §38 wraps both in a `<div class="ncc-matrix">`, the
   * same ancestor the editable grid's form carries, so they inherit the
   * sideways scroll AND the frozen first (name) column. This proves the div
   * wrapper (not just the form) delivers both: horizontal overflow and a
   * sticky, offset-0 name column that stays put when the grid is scrolled. */
  it('a div-wrapped read-only grid scrolls sideways and freezes the name column at the left edge', async () => {
    const table = renderToString(DataTable<Row>({ columns, rows }) as never)
    const html = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/css/dashboard.css"></head>
<body><main style="max-width:100vw;padding:1rem">
<div class="ncc-matrix">${table}</div></main></body></html>`
    const srv = createServer(async (req, res) => {
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
    const origin = await new Promise<string>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address()
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`)
      })
    })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })

      // The div wrapper still overflows sideways rather than stacking to cards.
      const scroll = await page.$eval('.ncc-matrix .ncc-table-scroll', (el) => ({
        overflowX: getComputedStyle(el).overflowX,
        wider: el.scrollWidth > el.clientWidth,
      }))
      expect(scroll.overflowX).toBe('auto')
      expect(scroll.wider, 'the read-only grid must be wider than the phone viewport').toBe(true)

      // The first cell in a body row is the frozen name column: sticky, pinned
      // to the left, and it keeps its on-screen x when the grid is scrolled.
      const firstCellSel = '.ncc-matrix .ncc-table tbody tr:first-child td:first-child'
      const before = await page.$eval(firstCellSel, (el) => {
        const cs = getComputedStyle(el)
        return { position: cs.position, left: cs.left, x: el.getBoundingClientRect().left }
      })
      expect(before.position, 'the name column is sticky').toBe('sticky')
      expect(before.left, 'the name column is pinned to the left edge').toBe('0px')

      await page.$eval('.ncc-matrix .ncc-table-scroll', (el) => {
        el.scrollLeft = 400
      })
      await page.waitForTimeout(50)
      const after = await page.$eval(firstCellSel, (el) => el.getBoundingClientRect().left)
      expect(
        Math.abs(after - before.x),
        `the frozen name column must not move when scrolled (before ${before.x}, after ${after})`,
      ).toBeLessThanOrEqual(1)
    } finally {
      srv.close()
      await page.close()
    }
  })
})
