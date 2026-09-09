import { sql } from 'kysely'
import type { Db } from '../../db/kysely.js'
import { today } from '../../lib/dates.js'
import { formatPaiseAsRupees } from '../../lib/money.js'

/**
 * The budget-alerts job (spec 6.8, the budget cron DECISIONS 26.1 deferred to
 * slice 3).
 *
 * It reads committed and actual from the 020 views — the same rows the
 * variance table renders and rule 4's approval check reads — and never
 * recomputes them. A budget alert computed by different arithmetic than the
 * number that blocks an approval would report overruns that approvals keep
 * refusing, or the reverse.
 *
 * An alert fires when committed + actual >= the budget line. The zero-rows
 * case is a head with no committed and no actual rows in either view: both
 * aggregates COALESCE to 0 in the views (migration 020), so the comparison is
 * 0 >= budget, which fires only for a zero budget — and a zero budget line is
 * a real alert. No NULL ever reaches the comparison, which is the point the
 * views' COALESCE was written for (DECISIONS §6.8 rule 2).
 *
 * Idempotent in effect: it writes notifications, but only for heads at or
 * over budget — a second run the same day re-writes the same alert, which is
 * the documented cron trade-off (the jobs are idempotent by refusing to
 * change money, not by deduping notifications).
 */

export interface BudgetAlert {
  projectId: number
  costHeadId: number
  budgetPaise: number
  spentPaise: number
  variancePaise: number
}

export interface BudgetAlertsResult {
  ranOn: string
  alerts: BudgetAlert[]
  notified: number
}

export async function runBudgetAlerts(db: Db, onDate = today()): Promise<BudgetAlertsResult> {
  const rows = await sql<{
    project_id: number
    cost_head_id: number
    budget_paise: number
    committed_paise: number
    actual_paise: number
  }>`
    select pb.project_id, bl.cost_head_id, bl.amount_paise as budget_paise,
      coalesce(vc.committed_paise, 0) as committed_paise,
      coalesce(va.actual_paise, 0) as actual_paise
    from budget_lines bl
    join project_budgets pb on pb.id = bl.budget_id
    left join v_project_committed vc
      on vc.project_id = pb.project_id and vc.cost_head_id = bl.cost_head_id
    left join v_project_actual va
      on va.project_id = pb.project_id and va.cost_head_id = bl.cost_head_id
    where pb.status = 'approved'
      and pb.version = (
        select max(pb2.version) from project_budgets pb2
        where pb2.project_id = pb.project_id and pb2.status = 'approved'
      )
      and coalesce(vc.committed_paise, 0) + coalesce(va.actual_paise, 0) >= bl.amount_paise
  `.execute(db)

  const alerts: BudgetAlert[] = rows.rows.map((r) => ({
    projectId: Number(r.project_id),
    costHeadId: Number(r.cost_head_id),
    budgetPaise: Number(r.budget_paise),
    spentPaise: Number(r.committed_paise) + Number(r.actual_paise),
    variancePaise: Number(r.budget_paise) - (Number(r.committed_paise) + Number(r.actual_paise)),
  }))

  let notified = 0
  for (const alert of alerts) {
    const recipients = await db
      .selectFrom('users')
      .innerJoin('user_roles', 'user_roles.user_id', 'users.id')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select('users.id')
      .where('roles.key', 'in', ['owner', 'accounts_manager'])
      .where('users.status', '=', 'active')
      .execute()

    for (const user of recipients) {
      await db
        .insertInto('notifications')
        .values({
          user_id: user.id,
          kind: 'budget_reached',
          title: 'Budget reached',
          body:
            `Cost head ${alert.costHeadId} on project has spent ${formatPaiseAsRupees(alert.spentPaise)} ` +
            `of a ${formatPaiseAsRupees(alert.budgetPaise)} budget. Approvals for this head will be refused until the budget is revised.`,
          link_path: '/finance/budgets',
        })
        .execute()
      notified += 1
    }
  }

  return { ranOn: onDate, alerts, notified }
}
