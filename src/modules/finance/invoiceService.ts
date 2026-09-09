import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { nextNumber } from '../../lib/numbering.js'
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js'
import { splitGst } from '../../lib/money.js'
import { periodForDate } from './queries.js'
import type { ClientInvoiceCreateInput } from './schemas.js'

/**
 * Client invoices (spec 6.8 rule 5).
 *
 * Rule 5's chain — certified milestone, taxable value, GST split by place of
 * supply, retention, milestone linked back — is the whole of this file. The
 * column this service never touches is `client_invoices.received_paise`:
 * that column has exactly one writer, the payment allocator
 * (allocatePaymentRows in service.ts), the same grant §26.3 gives
 * expenses.paid_paise. An invoice is created at received_paise = 0 and money
 * reaches it only through an allocation.
 *
 * The tax split is computed from `client_invoices.place_of_supply` and from
 * nothing else (DECISIONS 17.3/27.4): 'KA' is CGST + SGST, any other code is
 * IGST. It is never inferred from the project's or the client's state — a
 * Karnataka project for a client registered elsewhere would be mis-split
 * silently, and inferring it is the defect the NOT NULL column with no
 * default exists to prevent. Whether 'KA' is the right answer for every
 * current client remains the owner question recorded at 17.3.
 *
 * `retention_paise` reads the retention percentage through the milestone
 * being invoiced (DECISIONS 26.4: "the percentage from the milestone row
 * being invoiced"). The project_milestones table carries no retention
 * column; the percentage that exists to be read is the project row's
 * retention_pct (migrations/004_projects.sql:106), reached through the
 * milestone's project_id. What 26.4 rules out — a client or company default
 * silently rewriting the deduction — is what reading it project-scoped
 * through the milestone avoids. A per-milestone override column does not
 * exist; if the owner wants one, that is a migration plus a revisit of 26.4.
 */

export interface ClientInvoiceCreateResult {
  invoiceId: number
  invoiceNo: string
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalPaise: number
  retentionPaise: number
  netReceivablePaise: number
  placeOfSupply: string
}

export async function createInvoiceFromMilestone(
  db: Db,
  actor: { userId: number; ip: string | null },
  input: ClientInvoiceCreateInput
): Promise<ClientInvoiceCreateResult> {
  return db.transaction().execute(async (trx) => {
    // The milestone must exist and be certified (rule 5: "requires
    // project_milestones.status = 'certified'"). The act of invoicing is
    // what moves it to 'invoiced', so 'certified' — not anything earlier —
    // is the only admitting status.
    const milestone = await trx
      .selectFrom('project_milestones')
      .select(['id', 'project_id', 'name', 'amount_paise', 'status', 'invoice_id'])
      .where('id', '=', input.milestoneId)
      .forUpdate()
      .executeTakeFirst()
    if (!milestone) throw new NotFoundError(`Milestone ${input.milestoneId} does not exist.`)
    if (milestone.status !== 'certified') {
      throw new UnprocessableError(
        `Milestone ${milestone.id} (${milestone.name}) is ${milestone.status}, not certified. ` +
        `Rule 5 chains invoicing to physical certification: stage complete and quality checks passed.`
      )
    }
    if (milestone.invoice_id !== null) {
      throw new ConflictError(
        `Milestone ${milestone.id} is already invoiced (invoice_id ${milestone.invoice_id}). ` +
        `A certified milestone raises exactly one invoice.`
      )
    }
    if (milestone.amount_paise === null || Number(milestone.amount_paise) <= 0) {
      throw new UnprocessableError(
        `Milestone ${milestone.id} has no amount to invoice. Set the milestone's amount first.`
      )
    }
    const taxablePaise = Number(milestone.amount_paise)

    const project = await trx
      .selectFrom('projects')
      .select(['id', 'client_id', 'retention_pct', 'gst_pct'])
      .where('id', '=', Number(milestone.project_id))
      .executeTakeFirst()
    if (!project) throw new NotFoundError(`Project ${milestone.project_id} does not exist.`)

    const retentionPaise = Math.round((taxablePaise * Number(project.retention_pct)) / 100)
    const gstPct = Number(project.gst_pct)

    // Rule 5's split basis: the invoice's own place_of_supply. 'KA' → CGST +
    // SGST; anything else → IGST. No inference from projects or clients.
    const split = splitGst(taxablePaise, gstPct, input.placeOfSupply !== 'KA')

    const inserted = await trx
      .insertInto('client_invoices')
      .values({
        invoice_no: `TMP-${randomUUID().slice(0, 12)}`,
        project_id: Number(milestone.project_id),
        client_id: Number(project.client_id),
        invoice_date: input.invoiceDate,
        due_date: input.dueDate,
        place_of_supply: input.placeOfSupply,
        invoice_type: 'milestone',
        milestone_id: milestone.id,
        taxable_paise: split.taxablePaise,
        cgst_paise: split.cgstPaise,
        sgst_paise: split.sgstPaise,
        gst_pct: gstPct,
        total_paise: split.totalPaise,
        retention_paise: retentionPaise,
        advance_adjusted_paise: 0,
        tds_deducted_by_client_paise: 0,
        net_receivable_paise: split.totalPaise - retentionPaise,
        received_paise: 0,
        status: 'draft',
        narration: input.narration,
        period_id: await periodForDate(trx, input.invoiceDate),
        created_by: actor.userId,
      })
      .executeTakeFirst()
    const invoiceId = Number(inserted.insertId ?? 0)

    const invoiceNo = await nextNumber(trx, 'invoice', input.invoiceDate)
    await trx.updateTable('client_invoices').set({ invoice_no: invoiceNo }).where('id', '=', invoiceId).execute()

    await trx
      .updateTable('project_milestones')
      .set({ invoice_id: invoiceId, status: 'invoiced' })
      .where('id', '=', milestone.id)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'finance.invoice_create',
      entityType: 'client_invoice',
      entityId: invoiceId,
      after: {
        invoice_no: invoiceNo,
        milestone_id: milestone.id,
        place_of_supply: input.placeOfSupply,
        taxable_paise: split.taxablePaise,
        cgst_paise: split.cgstPaise,
        sgst_paise: split.sgstPaise,
        igst_paise: split.igstPaise,
        gst_pct: gstPct,
        total_paise: split.totalPaise,
        retention_paise: retentionPaise,
        net_receivable_paise: split.totalPaise - retentionPaise,
      },
      ip: actor.ip,
    })

    return {
      invoiceId,
      invoiceNo,
      taxablePaise: split.taxablePaise,
      cgstPaise: split.cgstPaise,
      sgstPaise: split.sgstPaise,
      igstPaise: split.igstPaise,
      totalPaise: split.totalPaise,
      retentionPaise,
      netReceivablePaise: split.totalPaise - retentionPaise,
      placeOfSupply: input.placeOfSupply,
    }
  })
}
