import { sql } from 'kysely'
import type { Trx } from '../../db/kysely.js'

/**
 * Finance reads (spec 6.8).
 *
 * The reads here exist so the service never recomputes committed or actual:
 * rule 4's overrun check is written against v_project_committed and
 * v_project_actual, the same views the screens render, so the number that
 * blocks an approval is the number the supervisor sees on the variance table.
 */

export interface CostHeadState {
  costHeadId: number
  /** budget_lines.amount_paise of the approved budget, or null when the head has no line. */
  budgetPaise: number | null
  /** v_project_committed.committed_paise, or 0 when the view has no row. */
  committedPaise: number
  /** v_project_actual.actual_paise, or 0 when the view has no row. */
  actualPaise: number
}

/**
 * The three numbers per cost head (rule 2), for one project.
 *
 * Budget comes from the newest approved project_budgets version's lines —
 * superseded versions are history, drafts are not yet true. A cost head with
 * no line in the approved budget reads null, which means "no budget to
 * overrun" rather than "budget of zero": refusing an approval because a head
 * was never budgeted would be a different rule than 4 states.
 */
export async function costHeadStates(trx: Trx, projectId: number): Promise<CostHeadState[]> {
  const budget = await sql<{ cost_head_id: number; amount_paise: number }>`
    select bl.cost_head_id, bl.amount_paise
    from budget_lines bl
    join project_budgets pb on pb.id = bl.budget_id
    where pb.project_id = ${projectId}
      and pb.status = 'approved'
      and pb.version = (
        select max(pb2.version) from project_budgets pb2
        where pb2.project_id = ${projectId} and pb2.status = 'approved'
      )
  `.execute(trx)
  const budgetByHead = new Map(budget.rows.map((r) => [Number(r.cost_head_id), Number(r.amount_paise)]))

  const committed = await trx
    .selectFrom('v_project_committed')
    .select(['cost_head_id', 'committed_paise'])
    .where('project_id', '=', projectId)
    .execute()
  const committedByHead = new Map(committed.map((r) => [Number(r.cost_head_id), Number(r.committed_paise)]))

  const actual = await trx
    .selectFrom('v_project_actual')
    .select(['cost_head_id', 'actual_paise'])
    .where('project_id', '=', projectId)
    .execute()
  const actualByHead = new Map(actual.map((r) => [Number(r.cost_head_id), Number(r.actual_paise)]))

  const heads = new Set<number>([...budgetByHead.keys(), ...committedByHead.keys(), ...actualByHead.keys()])
  return [...heads].map((costHeadId) => ({
    costHeadId,
    budgetPaise: budgetByHead.get(costHeadId) ?? null,
    committedPaise: committedByHead.get(costHeadId) ?? 0,
    actualPaise: actualByHead.get(costHeadId) ?? 0,
  }))
}

/**
 * The accounting period containing a date, if any.
 *
 * Used to stamp expenses.period_id on approval (rule 7: "period_id is stamped
 * on approval"). No row means the date falls outside every recorded period —
 * the seeded periods cover the current financial year — and the stamp is
 * skipped, leaving period_id NULL exactly as the schema allows.
 */
export async function periodForDate(trx: Trx, date: string): Promise<number | null> {
  const row = await trx
    .selectFrom('accounting_periods')
    .select('id')
    .where('period_start', '<=', date)
    .where('period_end', '>=', date)
    .limit(1)
    .executeTakeFirst()
  return row ? Number(row.id) : null
}