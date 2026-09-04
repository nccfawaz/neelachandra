import { sql } from 'kysely'
import type { Trx } from '../db/kysely.js'
import { currentFinancialYear } from './dates.js'
import { parseJsonColumn } from './json.js'

/**
 * Document number generation (spec 6.2).
 *
 * nextNumber MUST run inside the caller's transaction and takes
 * SELECT ... FOR UPDATE on the document_numbering row. Reading a max and
 * adding one produces duplicate PO numbers under concurrent submits, and a
 * duplicate PO number is a real dispute with a vendor rather than a cosmetic
 * bug.
 *
 * Format is PREFIX/FY/NNN, for example NCC/PO/2026-27/014. The sequence
 * resets on 1 April when fy_reset is set, which is why the unique key is
 * (doc_type, financial_year) rather than doc_type alone.
 */

export type DocType =
  | 'project'
  | 'quote'
  | 'po'
  | 'grn'
  | 'expense'
  | 'invoice'
  | 'payment'
  | 'issue'
  | 'requisition'
  | 'transfer'
  | 'lead'
  | 'contractor_bill'

const DEFAULT_PREFIX: Record<DocType, string> = {
  project: 'NCC/PRJ',
  quote: 'NCC/QT',
  po: 'NCC/PO',
  grn: 'NCC/GRN',
  expense: 'NCC/EXP',
  invoice: 'NCC/INV',
  payment: 'NCC/PAY',
  issue: 'NCC/ISS',
  requisition: 'NCC/REQ',
  transfer: 'NCC/TRF',
  lead: 'NCC/LD',
  contractor_bill: 'NCC/CB',
}

const SETTING_KEY: Record<DocType, string> = {
  project: 'numbering.project_prefix',
  quote: 'numbering.quote_prefix',
  po: 'numbering.po_prefix',
  grn: 'numbering.grn_prefix',
  expense: 'numbering.expense_prefix',
  invoice: 'numbering.invoice_prefix',
  payment: 'numbering.payment_prefix',
  issue: 'numbering.issue_prefix',
  requisition: 'numbering.requisition_prefix',
  transfer: 'numbering.transfer_prefix',
  lead: 'numbering.lead_prefix',
  contractor_bill: 'numbering.contractor_bill_prefix',
}

async function resolvePrefix(trx: Trx, docType: DocType): Promise<string> {
  const row = await trx
    .selectFrom('settings')
    .select('value_json')
    .where('key_name', '=', SETTING_KEY[docType])
    .executeTakeFirst()

  if (!row) return DEFAULT_PREFIX[docType]
  // The column arrives parsed, so a prefix stored as a JSON string is already
  // a JS string here. A row holding anything else — an object, a number typed
  // into the settings form — is not a prefix, and the default is better than
  // stringifying it into a document number.
  const value = parseJsonColumn(row.value_json)
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_PREFIX[docType]
}

export async function nextNumber(
  trx: Trx,
  docType: DocType,
  onDate?: string
): Promise<string> {
  const fy = onDate ? financialYearFor(onDate) : currentFinancialYear()
  const prefix = await resolvePrefix(trx, docType)

  // Row lock, or insert the row for this financial year if this is the first
  // document of the year. INSERT ... ON DUPLICATE KEY UPDATE is used rather
  // than a check-then-insert because two concurrent first-of-the-year
  // submits would otherwise both insert and one would fail on the unique key.
  await sql`
    INSERT INTO document_numbering (doc_type, prefix, fy_reset, financial_year, last_number)
    VALUES (${docType}, ${prefix}, 1, ${fy}, 0)
    ON DUPLICATE KEY UPDATE prefix = VALUES(prefix)
  `.execute(trx)

  const locked = await sql<{ last_number: number }>`
    SELECT last_number FROM document_numbering
    WHERE doc_type = ${docType} AND financial_year = ${fy}
    FOR UPDATE
  `.execute(trx)

  const current = Number(locked.rows[0]?.last_number ?? 0)
  const next = current + 1

  await trx
    .updateTable('document_numbering')
    .set({ last_number: next })
    .where('doc_type', '=', docType)
    .where('financial_year', '=', fy)
    .execute()

  return `${prefix}/${fy}/${String(next).padStart(3, '0')}`
}

function financialYearFor(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number)
  const startYear = m! >= 4 ? y! : y! - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

/** Employee, client, vendor and similar codes: a prefix plus a zero-padded serial. */
export function sequenceCode(prefix: string, serial: number, width = 4): string {
  return `${prefix}${String(serial).padStart(width, '0')}`
}
