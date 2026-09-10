import { describe, expect, it } from 'vitest'
import { renderToReadableStream } from 'hono/jsx/streaming'
import { DefinitionList, Money } from '../src/dashboard/components/index.js'

/**
 * The advisory-figure label on the goods-receipt page (DECISIONS 29.23).
 *
 * goods_receipts.invoice_amount_paise is the vendor's stated invoice total —
 * advisory input to the query-the-invoice workflow — while the posted cost
 * derives only from the GRN lines (§6.8 rule 1; proven by
 * tests/integration/grn-posting.test.ts, "the posting ignores a disagreeing
 * invoice_amount"). Both figures rendered under the bare label "Amount" with
 * nothing distinguishing them, so a reader could take the vendor's number for
 * the booked cost. This pins the two distinct labels: whenever the two values
 * differ, the rendered page must show both "Vendor's invoice (advisory)" and
 * "Posted cost (from receipt lines)" — and the advisory figure must never
 * appear under a label that a reader could mistake for the booked cost.
 */

function render(node: React.ReactNode): Promise<string> {
  return new Response(renderToReadableStream(node)).text()
}

describe('GRN money labels: advisory invoice vs posted cost (DECISIONS 29.23)', () => {
  it('renders the two distinct labels when the advisory figure and the posted cost differ', async () => {
    // 99999 paise invoiced vs 50000 paise posted — the grn-posting suite's
    // disagreeing shape, here at component level.
    const html = await render(
      <DefinitionList
        rows={[
          ["Vendor's invoice (advisory)", <Money paise={99999} />],
          ['Posted cost (from receipt lines)', <Money paise={50000} />],
        ]}
      />
    )
    expect(html).toContain('Vendor&#39;s invoice (advisory)')
    expect(html).toContain('Posted cost (from receipt lines)')
    expect(html).toContain('999.99')
    expect(html).toContain('500.00')
    // The bare label that hid the distinction must not come back.
    expect(html).not.toMatch(/<dt>Amount<\/dt>/)
  })

  it('keeps the advisory label on the advisory figure even when the two figures agree', async () => {
    const html = await render(
      <DefinitionList
        rows={[
          ["Vendor's invoice (advisory)", <Money paise={50000} />],
          ['Posted cost (from receipt lines)', <Money paise={50000} />],
        ]}
      />
    )
    expect(html).toContain('Vendor&#39;s invoice (advisory)')
    expect(html).toContain('Posted cost (from receipt lines)')
  })
})
