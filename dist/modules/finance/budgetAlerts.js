import { sql } from 'kysely';
import { today } from '../../lib/dates.js';
import { formatPaiseAsRupees } from '../../lib/money.js';
export async function runBudgetAlerts(db, onDate = today()) {
    const rows = await sql `
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
  `.execute(db);
    const alerts = rows.rows.map((r) => ({
        projectId: Number(r.project_id),
        costHeadId: Number(r.cost_head_id),
        budgetPaise: Number(r.budget_paise),
        spentPaise: Number(r.committed_paise) + Number(r.actual_paise),
        variancePaise: Number(r.budget_paise) - (Number(r.committed_paise) + Number(r.actual_paise)),
    }));
    let notified = 0;
    for (const alert of alerts) {
        const recipients = await db
            .selectFrom('users')
            .innerJoin('user_roles', 'user_roles.user_id', 'users.id')
            .innerJoin('roles', 'roles.id', 'user_roles.role_id')
            .select('users.id')
            .where('roles.key', 'in', ['owner', 'accounts_manager'])
            .where('users.status', '=', 'active')
            .execute();
        for (const user of recipients) {
            await db
                .insertInto('notifications')
                .values({
                user_id: user.id,
                kind: 'budget_reached',
                title: 'Budget reached',
                body: `Cost head ${alert.costHeadId} on project has spent ${formatPaiseAsRupees(alert.spentPaise)} ` +
                    `of a ${formatPaiseAsRupees(alert.budgetPaise)} budget. Approvals for this head will be refused until the budget is revised.`,
                link_path: '/finance/budgets',
            })
                .execute();
            notified += 1;
        }
    }
    return { ranOn: onDate, alerts, notified };
}
