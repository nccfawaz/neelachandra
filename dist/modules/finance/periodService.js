import { writeAudit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
function labelOf(p) {
    return `${p.financial_year} month ${p.month}`;
}
export async function closePeriod(db, actor, periodId, roleKeys) {
    return db.transaction().execute(async (trx) => {
        if (!roleKeys.includes('owner') && !roleKeys.includes('accounts_manager')) {
            throw new UnprocessableError('Closing a period needs finance.period_close, which only owner and accounts_manager hold.');
        }
        const period = await trx
            .selectFrom('accounting_periods')
            .select(['id', 'financial_year', 'month', 'status'])
            .where('id', '=', periodId)
            .forUpdate()
            .executeTakeFirst();
        if (!period)
            throw new NotFoundError(`Accounting period ${periodId} does not exist.`);
        if (period.status === 'closed') {
            throw new ConflictError(`Period ${labelOf(period)} is already closed. Reopening a closed period is not supported: ` +
                `rule 7 makes post-close corrections a reversing entry in the current open period, never an edit to the closed one.`);
        }
        // Unposted documents inside the window would be frozen un-approvable by
        // the lock: approving a draft updates the row, and the 021 trigger
        // refuses that update. Name them instead of trapping them.
        const [start, end] = await Promise.all([periodDateStart(trx, periodId), periodDateEnd(trx, periodId)]);
        const unpostedExpenses = await trx
            .selectFrom('expenses')
            .select((eb) => eb.fn.countAll().as('n'))
            .where('expense_date', '>=', start)
            .where('expense_date', '<=', end)
            .where('status', 'in', ['draft', 'pending_approval'])
            .where('voided_at', 'is', null)
            .executeTakeFirstOrThrow();
        const n = Number(unpostedExpenses.n);
        if (n > 0) {
            throw new ConflictError(`Period ${labelOf(period)} still holds ${n} unposted expense document${n === 1 ? '' : 's'} ` +
                `(draft or pending approval) dated inside it. Approve or void them first — closing now would ` +
                `freeze them where the lock refuses their approval.`);
        }
        const next = period.status === 'open' ? 'soft_closed' : 'closed';
        await trx
            .updateTable('accounting_periods')
            .set({ status: next, closed_by: actor.userId, closed_at: new Date() })
            .where('id', '=', periodId)
            .execute();
        await writeAudit(trx, {
            userId: actor.userId,
            action: 'finance.period_close',
            entityType: 'accounting_period',
            entityId: periodId,
            before: { status: period.status },
            after: { status: next, financial_year: period.financial_year, month: period.month },
            ip: actor.ip,
        });
        return { periodId, label: labelOf(period), status: next };
    });
}
async function periodDateStart(trx, periodId) {
    const row = await trx
        .selectFrom('accounting_periods')
        .select('period_start')
        .where('id', '=', periodId)
        .executeTakeFirstOrThrow();
    return String(row.period_start);
}
async function periodDateEnd(trx, periodId) {
    const row = await trx
        .selectFrom('accounting_periods')
        .select('period_end')
        .where('id', '=', periodId)
        .executeTakeFirstOrThrow();
    return String(row.period_end);
}
