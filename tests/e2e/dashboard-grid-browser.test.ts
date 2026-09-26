import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'

/**
 * The /app dashboard grid as a real browser lays it out (DECISIONS 40).
 *
 * A renderToString test cannot see column counts, wrapping or baseline
 * alignment — those are the browser's, computed from the SERVED stylesheet
 * (vite's build in public/assets/css, per 29.60). So this suite loads the real
 * built dashboard.css into Chromium against the real card/grid markup the
 * Widget component emits, and reads back computed geometry:
 *
 *   - the KPI grid is FOUR fixed columns on desktop, ONE on a phone (item B);
 *   - the longest labels ("APPROVALS WAITING ON ME", "UNASSIGNED ENQUIRIES")
 *     do not overflow their card and every value stays on one baseline (C, B);
 *   - a panel list row keeps a real gap between label and value — the fix for
 *     "Attendance days1 unapproved" was a flex gutter, not a string (item E);
 *   - the check-in/out button is capped on desktop, full width on a phone (F).
 */

const ROOT = path.resolve(__dirname, '../..')

// The two longest labels that actually exist in widgets.ts, plus shorter ones,
// so the row mixes one-line and two-line labels — the case min-height guards.
const KPI_LABELS = [
  'ACTIVE JOBS',
  'APPROVALS WAITING ON ME',
  'UNASSIGNED ENQUIRIES',
  'OPEN SNAGS',
  'SITE REPORTS DUE TODAY',
  'OPEN POSITIONS',
  'ATTENDANCE TO APPROVE',
  'CASH POSITION',
]

function kpiCard(label: string): string {
  return (
    '<section class="ncc-card">' +
    `<p class="ncc-kpi__label">${label}</p>` +
    '<div class="ncc-kpi__value">0</div>' +
    '<div class="ncc-kpi__hint">A hint line.</div>' +
    '</section>'
  )
}

function pageHtml(): string {
  const kpis = KPI_LABELS.map(kpiCard).join('')
  const list =
    '<ul class="ncc-list">' +
    '<li class="ncc-list__item"><span>Attendance days</span><span class="ncc-list__value">1 unapproved</span></li>' +
    '<li class="ncc-list__item is-warn"><span>Expenses</span><span class="ncc-list__value">3 waiting</span></li>' +
    '</ul>'
  const body =
    '<div class="ncc-content">' +
    '<button class="ncc-checkin-btn" type="button">Check in</button>' +
    `<div class="ncc-grid ncc-grid--2"><section class="ncc-card ncc-card--wide"><p class="ncc-kpi__label">WAITING ON YOU</p>${list}</section></div>` +
    `<div class="ncc-grid ncc-grid--kpi">${kpis}</div>` +
    '</div>'
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="/assets/css/dashboard.css"></head>' +
    `<body class="ncc-body">${body}</body></html>`
  )
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
        const bytes = await readFile(file)
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
        res.end(bytes)
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

async function measure(width: number) {
  const { server, origin } = await startServer()
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  try {
    await page.goto(origin + '/', { waitUntil: 'networkidle' })
    return await page.evaluate(() => {
      const grid = document.querySelector('.ncc-grid--kpi') as HTMLElement
      const cols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length
      const cards = Array.from(grid.querySelectorAll('.ncc-card')) as HTMLElement[]
      const labels = Array.from(grid.querySelectorAll('.ncc-kpi__label')) as HTMLElement[]
      const values = Array.from(grid.querySelectorAll('.ncc-kpi__value')) as HTMLElement[]
      const labelLine = parseFloat(getComputedStyle(labels[0]!).lineHeight)
      const labelInfo = labels.map((el) => ({
        text: el.textContent ?? '',
        overflow: el.scrollWidth - el.clientWidth,
        lines: Math.round(el.getBoundingClientRect().height / labelLine),
      }))
      const valueTops = values.map((el) => Math.round(el.getBoundingClientRect().top))
      const cardWidths = cards.map((el) => Math.round(el.getBoundingClientRect().width))
      // Values in the SAME grid row must share a baseline (the two-line label
      // min-height guarantees it); values in different rows naturally differ.
      // Group by row = group by card top, then take the worst within-row spread.
      const rowTop = cards.map((el) => Math.round(el.getBoundingClientRect().top))
      const rows = new Map<number, number[]>()
      values.forEach((_, i) => {
        const key = rowTop[i]!
        const arr = rows.get(key) ?? []
        arr.push(valueTops[i]!)
        rows.set(key, arr)
      })
      const worstRowSpread = Math.max(
        ...Array.from(rows.values()).map((tops) => Math.max(...tops) - Math.min(...tops)),
      )
      return {
        cols,
        valueFontPx: parseFloat(getComputedStyle(values[0]!).fontSize),
        labelFontPx: parseFloat(getComputedStyle(labels[0]!).fontSize),
        labelInfo,
        rowsCount: rows.size,
        worstRowValueSpread: worstRowSpread,
        cardWidthSpread: Math.max(...cardWidths) - Math.min(...cardWidths),
        cardWidth: cardWidths[0],
      }
    })
  } finally {
    await page.close()
    await new Promise<void>((r) => server.close(() => r()))
  }
}

describe('the /app KPI grid as Chromium lays it out (DECISIONS 40)', () => {
  for (const width of [1280, 1440]) {
    it(`is four fixed columns at ${width} with no label overflow and one value baseline`, async () => {
      const m = await measure(width)
      console.log(`[kpi ${width}]`, JSON.stringify(m))
      expect(m.cols, 'four fixed KPI columns on desktop').toBe(4)
      // The number is quieter than the label (item C): it must not be the 24px
      // it was, and it is smaller than nothing that reads as a giant 0.
      expect(m.valueFontPx, 'KPI number is smaller than the old 1.5rem/24px').toBeLessThanOrEqual(20)
      expect(m.labelFontPx, 'KPI label is present and readable').toBeGreaterThanOrEqual(12)
      // No label overflows its card horizontally (it wraps instead).
      for (const l of m.labelInfo) {
        expect(l.overflow, `"${l.text}" overflows its card at ${width}px`).toBeLessThanOrEqual(1)
        expect(l.lines, `"${l.text}" wraps to more than two lines at ${width}px`).toBeLessThanOrEqual(2)
      }
      // The reserved two-line label height keeps every value on one baseline
      // WITHIN each grid row (across rows they differ, which is expected).
      expect(m.worstRowValueSpread, 'KPI values share a baseline within each row').toBeLessThanOrEqual(2)
      // Fixed columns => every card the same width (auto-fit did not).
      expect(m.cardWidthSpread, 'every KPI card is the same width').toBeLessThanOrEqual(2)
    })
  }

  it('collapses to one column and full-width controls at 390px', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      const m = await page.evaluate(() => {
        const grid = document.querySelector('.ncc-grid--kpi') as HTMLElement
        const cols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length
        const labels = Array.from(grid.querySelectorAll('.ncc-kpi__label')) as HTMLElement[]
        const worst = Math.max(...labels.map((el) => el.scrollWidth - el.clientWidth))
        const btn = document.querySelector('.ncc-checkin-btn') as HTMLElement
        const content = document.querySelector('.ncc-content') as HTMLElement
        const cs = getComputedStyle(content)
        const inner = content.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        return {
          cols,
          worstLabelOverflow: worst,
          btnWidth: Math.round(btn.getBoundingClientRect().width),
          contentInner: Math.round(inner),
        }
      })
      console.log('[kpi 390]', JSON.stringify(m))
      expect(m.cols, 'one KPI column on a phone').toBe(1)
      expect(m.worstLabelOverflow, 'no label clips at 390px (APPROVALS WAITING ON ME)').toBeLessThanOrEqual(1)
      // F: the button fills the content width on a phone (cap removed).
      expect(m.btnWidth, 'check-in button is full width on a phone').toBeGreaterThanOrEqual(m.contentInner - 2)
    } finally {
      await page.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('caps the check-in button on desktop and keeps a real gap in list rows (items F, E)', async () => {
    const { server, origin } = await startServer()
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    try {
      await page.goto(origin + '/', { waitUntil: 'networkidle' })
      const m = await page.evaluate(() => {
        const btn = document.querySelector('.ncc-checkin-btn') as HTMLElement
        const content = document.querySelector('.ncc-content') as HTMLElement
        const item = document.querySelector('.ncc-list__item') as HTMLElement
        const label = item.querySelector('span:first-child') as HTMLElement
        const value = item.querySelector('.ncc-list__value') as HTMLElement
        return {
          btnWidth: Math.round(btn.getBoundingClientRect().width),
          contentInner: Math.round(content.clientWidth),
          itemDisplay: getComputedStyle(item).display,
          gap: Math.round(value.getBoundingClientRect().left - label.getBoundingClientRect().right),
        }
      })
      console.log('[desktop F/E]', JSON.stringify(m))
      // F: capped well below the full content width on desktop.
      expect(m.btnWidth, 'check-in button is capped on desktop').toBeLessThan(m.contentInner)
      expect(m.btnWidth, 'check-in button honours the 22rem cap (~352px)').toBeLessThanOrEqual(360)
      // E: label and value are laid out with a real gutter, not run together.
      expect(m.itemDisplay, 'list item is a flex row').toBe('flex')
      expect(m.gap, 'a real gap separates "Attendance days" from "1 unapproved"').toBeGreaterThan(8)
    } finally {
      await page.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
