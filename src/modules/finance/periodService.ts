import type { Db, Trx } from '../../db/kysely.js'
import { writeAudit } from '../../lib/audit.js'
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js'

/**
 * Period close (spec 6.8 rule 7, route POST /api/finance/periods/:id/close).
 *
 * The 021 triggers enforce the lock — any write to expenses, payments or
 * client_invoices dated inside a soft_closed/closed period is refused — but
 * until now nothing moved a period's status: every seeded period sat at
 * 'open' and the lock was dead code in production terms. This file is the
 * writer.
 *
 * The transitions, and why:
 *
 *   open → soft_closed → closed, one step per call. The two statuses exist
 *   in the ENUM and the 021 trigger treats them identically as a lock, so
 *   the distinction must earn its keep: soft_closed is the "review window"
 *   — locked like closed, but visibly not final, and the state a period is
 *   in when someone notices a missed document. closed is final.
 *
 *   **Reopening is refused.** The spec is silent on it, and every argument
 *   for reopening ("a document was missed") is the argument rule 7 answers:
 *   post-close corrections are a reversing entry in the current open period,
 *   never an edit to a closed one. A reopen path that exists will be used,
 *   and the first use destroys the property the whole lock exists for —
 *   last month's numbers no longer change after the owner has looked at
 *   them. The refusal names the reversing-entry alternative so the person
 *   asking for the reopen has a next action that is not a status change.
 *
 * Closing refuses while unposted documents exist inside the period: a draft
 * or pending_approval expense dated inside the window would be frozen
 * un-approvable by the lock (its approval would have to update the row), so
 * the close names them rather than trapping them.
 *
 * Every transition is audited (closed_by / closed_at on the row, plus the
 * audit log entry).
 */

export interface ClosePeriodResult {
  periodId: number
  label: string
  status: 'soft_closed' | 'closed'
}

function labelOf(p: { financial_year: string; month: number }): string {
  return `${p.financial_year} month ${p.month}`
}

export async function closePeriod(
  db: Db,
  actor: { userId: number; ip: string | null },
  periodId: number,
  roleKeys: readonly string[]
): Promise<ClosePeriodResult> {
  return db.transaction().execute(async (trx) => {
    if (!roleKeys.includes('owner') && !roleKeys.includes('accounts_manager')) {
      throw new UnprocessableError(
        'Closing a period needs finance.period_close, which only owner and accounts_manager hold.'
      )
    }

    const period = await trx
      .selectFrom('accounting_periods')
      .select(['id', 'financial_year', 'month', 'status'])
      .where('id', '=', periodId)
      .forUpdate()
      .executeTakeFirst()
    if (!period) throw new NotFoundError(`Accounting period ${periodId} does not exist.`)
    if (period.status === 'closed') {
      throw new ConflictError(
        `Period ${labelOf(period)} is already closed. Reopening a closed period is not supported: ` +
        `rule 7 makes post-close corrections a reversing entry in the current open period, never an edit to the closed one.`
      )
    }

    // Unposted documents inside the window would be frozen un-approvable by
    // the lock: approving a draft updates the row, and the 021 trigger
    // refuses that update. Name them instead of trapping them.
    const [start, end] = await Promise.all([periodDateStart(trx, periodId), periodDateEnd(trx, periodId)])
    const unpostedExpenses = await trx
      .selectFrom('expenses')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('expense_date', '>=', start)
      .where('expense_date', '<=', end)
      .where('status', 'in', ['draft', 'pending_approval'] as const)
      .where('voided_at', 'is', null)
      .executeTakeFirstOrThrow()
    const n = Number(unpostedExpenses.n)
    if (n > 0) {
      throw new ConflictError(
        `Period ${labelOf(period)} still holds ${n} unposted expense document${n === 1 ? '' : 's'} ` +
        `(draft or pending approval) dated inside it. Approve or void them first — closing now would ` +
        `freeze them where the lock refuses their approval.`
      )
    }

    const next = period.status === 'open' ? 'soft_closed' : 'closed'
    await trx
      .updateTable('accounting_periods')
      .set({ status: next, closed_by: actor.userId, closed_at: new Date() })
      .where('id', '=', periodId)
      .execute()

    await writeAudit(trx, {
      userId: actor.userId,
      action: 'finance.period_close',
      entityType: 'accounting_period',
      entityId: periodId,
      before: { status: period.status },
      after: { status: next, financial_year: period.financial_year, month: period.month },
      ip: actor.ip,
    })

    return { periodId, label: labelOf(period), status: next }
  })
}

async function periodDateStart(trx: Trx, periodId: number): Promise<string> {
  const row = await trx
    .selectFrom('accounting_periods')
    .select('period_start')
    .where('id', '=', periodId)
    .executeTakeFirstOrThrow()
  return String(row.period_start)
}

async function periodDateEnd(trx: Trx, periodId: number): Promise<string> {
  const row = await trx
    .selectFrom('accounting_periods')
    .select('period_end')
    .where('id', '=', periodId)
    .executeTakeFirstOrThrow()
  return String(row.period_end)
}
