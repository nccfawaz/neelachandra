import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { renderToString } from 'hono/jsx/dom/server'
import { DataTable, type Column } from '../../src/dashboard/components/index.js'
import { LoginPage } from '../../src/modules/auth/pages.js'

/*
 * Stage 2 as a phone renders it (DECISIONS 37.4/37.5/37.6): the wide-table
 * card rule and the login page, at 390×844 in real Chromium against the REAL
 * built stylesheet, read back from COMPUTED values.
 *
 * The card rule is the one whose failure is invisible to markup tests: the
 * DataTable emits the same <td data-label> on every screen, and whether those
 * cells stack into labelled cards below 768px is entirely a computed-CSS fact.
 * So this renders the REAL DataTable (the component every table wraps) with
 * the reference six columns, once in an ordinary card and once inside the one
 * `.ncc-matrix` exception, and asserts Chromium stacks the first and leaves
 * the second a grid.
 */

const ROOT = path.resolve(__dirname, '../..')

interface Row {
  employee: string
  reading: string
  at: string
  status: string
  flag: string
  position: string
}

// The reference table (DECISIONS 37.4): "Site check-ins — every reading".
const COLUMNS: Column<Row>[] = [
  { header: 'Employee', cell: (r) => r.employee },
  { header: 'Reading', cell: (r) => r.reading },
  { header: 'At', cell: (r) => r.at },
  { header: 'Status', cell: (r) => r.status },
  { header: 'Flag', cell: (r) => r.flag },
  { header: 'Position', cell: (r) => r.position },
]

const ROWS: Row[] = [
  {
    employee: 'Ramesh Kumar Nair',
    reading: 'Check in',
    at: '08:59',
    status: 'on site',
    flag: 'within fence',
    position: '9.9312, 76.2673',
  },
  {
    employee: 'Sunil Varghese',
    reading: 'Check out',
    at: '17:04',
    status: 'left site',
    flag: 'ok',
    position: '9.9310, 76.2671',
  },
]

function cardPageHtml(): string {
  const plain = renderToString(DataTable<Row>({ columns: COLUMNS, rows: ROWS }) as never)
  const matrix = renderToString(DataTable<Row>({ columns: COLUMNS, rows: ROWS }) as never)
  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/css/dashboard.css"></head>
<body><main style="padding:1rem">
<section id="plain" class="ncc-card">${plain}</section>
<form id="matrix" class="ncc-matrix" method="post" action="/x">${matrix}</form>
</main></body></html>`
}

function loginPageHtml(): string {
  const node = LoginPage({ csrfToken: 'fixture-csrf', email: 'demo@example.invalid' })
  return '<!doctype html><html lang="en">' + renderToString(node as never) + '</html>'
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function startServer(routes: Record<string, string>): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (routes[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(routes[url.pathname])
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

describe('the wide-table card rule as Chromium computes it on a phone', () => {
  it('stacks an ordinary table into labelled cards, and leaves the matrix a grid', async () => {
    const { server, origin } = await startServer({ '/': cardPageHtml() })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })

      // The ordinary table stacks: its header row is clipped out of flow and
      // each cell becomes a flex row wearing its column name from data-label.
      const plain = await page.$eval('#plain', (root) => {
        const thead = root.querySelector('thead') as HTMLElement
        const td = root.querySelector('tbody tr td') as HTMLElement
        const before = getComputedStyle(td, '::before')
        return {
          theadPosition: getComputedStyle(thead).position,
          tdDisplay: getComputedStyle(td).display,
          beforeContent: before.content,
          dataLabel: td.getAttribute('data-label'),
        }
      })
      console.log('[card plain]', JSON.stringify(plain))
      expect(plain.theadPosition, 'the header is lifted out of flow when stacked').toBe('absolute')
      expect(plain.tdDisplay, 'each cell becomes its own flex row').toBe('flex')
      // The label a phone reads on the cell is the column header, injected by
      // content: attr(data-label) — not typed into the markup.
      expect(plain.dataLabel).toBe('Employee')
      expect(plain.beforeContent, 'the cell carries its column name').toBe('"Employee"')

      // The matrix is the single exception: still a real table, no injected
      // labels — it scrolls sideways instead (proven in matrix-scroll.test.ts).
      const matrix = await page.$eval('#matrix', (root) => {
        const table = root.querySelector('table.ncc-table') as HTMLElement
        const td = root.querySelector('tbody tr td') as HTMLElement
        return {
          tableDisplay: getComputedStyle(table).display,
          tdDisplay: getComputedStyle(td).display,
          beforeContent: getComputedStyle(td, '::before').content,
        }
      })
      console.log('[card matrix]', JSON.stringify(matrix))
      expect(matrix.tableDisplay, 'the matrix stays a table').toBe('table')
      expect(matrix.tdDisplay, 'matrix cells stay table cells').toBe('table-cell')
      expect(matrix.beforeContent, 'the matrix suppresses the injected label').toBe('none')
    } finally {
      await page.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('the login page as Chromium computes it on a phone', () => {
  it('fits 390px with no sideways scroll, 16px inputs and a full-width tap-sized button', async () => {
    const { server, origin } = await startServer({ '/login': loginPageHtml() })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    try {
      await page.goto(origin + '/login', { waitUntil: 'networkidle' })

      // No horizontal overflow: the page is not wider than the phone.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      console.log('[login overflow]', JSON.stringify(overflow))
      expect(
        overflow.scrollWidth,
        `login must not scroll sideways (${overflow.scrollWidth} > ${overflow.clientWidth})`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1)

      // Inputs are 16px so iOS does not zoom on focus (37.6, width-independent).
      const inputFont = await page.$eval(
        'input[name="email"]',
        (el) => getComputedStyle(el).fontSize,
      )
      expect(inputFont, 'inputs are 16px on a phone').toBe('16px')

      // The submit button fills the card and is at least one tap target tall.
      const btn = await page.$eval('button[type="submit"]', (el) => {
        const r = el.getBoundingClientRect()
        const form = el.closest('form')!.getBoundingClientRect()
        return { height: r.height, width: r.width, formWidth: form.width }
      })
      console.log('[login button]', JSON.stringify(btn))
      expect(btn.height, 'the sign-in button is at least 48px tall').toBeGreaterThanOrEqual(48)
      expect(btn.width, 'the sign-in button fills the form width').toBeGreaterThan(btn.formWidth - 2)

      // The form is a native POST — it submits with JavaScript disabled.
      const form = await page.$eval('form', (el) => ({
        method: (el as HTMLFormElement).method,
        action: new URL((el as HTMLFormElement).action).pathname,
      }))
      expect(form.method).toBe('post')
      expect(form.action).toBe('/login')

      expect(errors, `page errors: ${errors.join('; ')}`).toEqual([])
    } finally {
      await page.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
