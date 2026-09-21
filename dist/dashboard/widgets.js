import { PERMISSIONS } from '../lib/permissions.js';
import { projectScopeFilter } from '../lib/scope.js';
import { today, yesterday, currentFinancialYear, financialYearBounds, addDays, monthBounds, periodOf, monthOf } from '../lib/dates.js';
export const WIDGETS = [
    // The eight KPI tiles of the target dashboard (29.62). Money tiles are
    // gated on finance.view_company_pnl (29.12) — a project_manager holds
    // finance.view_project_budget, not the company figure, and must not see
    // billed/collected in any form.
    { key: 'active_jobs', title: 'Active jobs', perms: [PERMISSIONS.PROJECTS_VIEW] },
    { key: 'site_reports_due', title: 'Site reports due today', perms: [PERMISSIONS.PROJECTS_VIEW] },
    { key: 'approvals_waiting', title: 'Approvals waiting on me', perms: [PERMISSIONS.DASHBOARD_VIEW_OWN_KPI] },
    { key: 'open_requisitions', title: 'Open material requests', perms: [PERMISSIONS.INVENTORY_VIEW] },
    { key: 'billed_this_month', title: 'Billed this month', perms: [PERMISSIONS.FINANCE_VIEW_COMPANY_PNL] },
    { key: 'collected_this_month', title: 'Collected this month', perms: [PERMISSIONS.FINANCE_VIEW_COMPANY_PNL] },
    {
        key: 'work_in_hand',
        title: 'Work in hand',
        // Narrowest defensible definition pending owner question 19: milestones
        // awaiting certification, i.e. contract value earned but not yet
        // certified. Labelled with the definition in the UI hint.
        perms: [PERMISSIONS.FINANCE_VIEW_PROJECT_BUDGET],
    },
    // Refused per 29.26: no labour cost exists in the model, so a margin
    // percentage would be overstated. The tile renders an em dash with a
    // 'not wired yet' label (routes.tsx renders money tiles for real keys;
    // this one is deliberately absent from loadWidget).
    { key: 'gross_margin', title: 'Gross margin', perms: [PERMISSIONS.FINANCE_VIEW_COMPANY_PNL] },
    { key: 'pending_approvals', title: 'Waiting on you', perms: [PERMISSIONS.DASHBOARD_VIEW_OWN_KPI], wide: true },
    { key: 'cash_position', title: 'Cash position', perms: [PERMISSIONS.FINANCE_VIEW_COMPANY_PNL] },
    { key: 'month_revenue', title: 'Revenue this financial year', perms: [PERMISSIONS.FINANCE_VIEW_COMPANY_PNL] },
    { key: 'receivables_ageing', title: 'Receivables ageing', perms: [PERMISSIONS.FINANCE_VIEW_COMPANY_PNL], wide: true },
    { key: 'projects_over_budget', title: 'Projects over budget', perms: [PERMISSIONS.FINANCE_VIEW_PROJECT_BUDGET], wide: true },
    { key: 'my_projects', title: 'Projects', perms: [PERMISSIONS.PROJECTS_VIEW], wide: true },
    { key: 'dpr_status', title: 'Daily reports', perms: [PERMISSIONS.PROJECTS_VIEW], wide: true },
    { key: 'open_snags', title: 'Open snags', perms: [PERMISSIONS.PROJECTS_VIEW] },
    { key: 'milestones_due', title: 'Milestones due in 14 days', perms: [PERMISSIONS.PROJECTS_VIEW], wide: true },
    { key: 'lead_funnel', title: 'My leads by stage', perms: [PERMISSIONS.CRM_LEAD_VIEW], wide: true },
    { key: 'unassigned_enquiries', title: 'Unassigned enquiries', perms: [PERMISSIONS.ENQUIRIES_VIEW] },
    { key: 'stale_quotes', title: 'Quotes awaiting response', perms: [PERMISSIONS.CRM_QUOTE_CREATE], wide: true },
    { key: 'attendance_pending', title: 'Attendance to approve', perms: [PERMISSIONS.HR_ATTENDANCE_APPROVE] },
    { key: 'documents_expiring', title: 'Documents expiring', perms: [PERMISSIONS.HR_DOCUMENT_MANAGE], wide: true },
    { key: 'job_openings', title: 'Open positions', perms: [PERMISSIONS.HR_RECRUIT_MANAGE] },
    { key: 'low_stock', title: 'Items below reorder level', perms: [PERMISSIONS.INVENTORY_VIEW], wide: true },
];
export function widgetsFor(perms) {
    return WIDGETS.filter((w) => w.perms.some((p) => perms.has(p)));
}
export function widgetByKey(key) {
    return WIDGETS.find((w) => w.key === key);
}
/** Reads a metric the nightly cron materialised, or zero if it has not run. */
async function snapshot(db, key) {
    const row = await db
        .selectFrom('dashboard_daily_snapshot')
        .select(['metric_value_paise', 'metric_value_count'])
        .where('metric_key', '=', key)
        .orderBy('snapshot_date', 'desc')
        .limit(1)
        .executeTakeFirst();
    return {
        paise: Number(row?.metric_value_paise ?? 0),
        count: Number(row?.metric_value_count ?? 0),
    };
}
export async function loadWidget(key, ctx) {
    switch (key) {
        case 'active_jobs': {
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('projects')
                .select((eb) => eb.fn.countAll().as('n'))
                .where('projects.status', 'in', ['mobilising', 'in_progress', 'snagging']);
            if (scoped)
                q = q.where('projects.id', 'in', scoped.length ? scoped : [0]);
            const row = await q.executeTakeFirst();
            return { kind: 'count', count: Number(row?.n ?? 0), hint: 'Mobilising, in progress or snagging.' };
        }
        case 'site_reports_due': {
            // One DPR per active project per day (uq_dpr_project_date). Due today
            // = active projects with no report dated today.
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('projects')
                .select((eb) => eb.fn.countAll().as('n'))
                .where('projects.status', 'in', ['mobilising', 'in_progress', 'snagging'])
                .where((eb) => eb.not(eb.exists(eb.selectFrom('daily_progress_reports')
                .select('daily_progress_reports.id')
                .whereRef('daily_progress_reports.project_id', '=', 'projects.id')
                .where('daily_progress_reports.report_date', '=', today()))));
            if (scoped)
                q = q.where('projects.id', 'in', scoped.length ? scoped : [0]);
            const row = await q.executeTakeFirst();
            return { kind: 'count', count: Number(row?.n ?? 0), hint: 'Active projects with no report for today.' };
        }
        case 'approvals_waiting': {
            // Sum of the live pending_approvals widget's queues that carry the
            // owner-like semantics: expenses and POs awaiting this user's role.
            const rows = await Promise.all([
                ctx.perms.has(PERMISSIONS.FINANCE_EXPENSE_APPROVE)
                    ? ctx.db
                        .selectFrom('expenses')
                        .select((eb) => eb.fn.countAll().as('n'))
                        .where('status', '=', 'pending_approval')
                        .where('created_by', '!=', ctx.userId)
                        .executeTakeFirst()
                    : Promise.resolve(undefined),
                ctx.perms.has(PERMISSIONS.INVENTORY_APPROVE_PO)
                    ? ctx.db
                        .selectFrom('purchase_orders')
                        .select((eb) => eb.fn.countAll().as('n'))
                        .where('status', '=', 'pending_approval')
                        .where('created_by', '!=', ctx.userId)
                        .executeTakeFirst()
                    : Promise.resolve(undefined),
                ctx.perms.has(PERMISSIONS.HR_ATTENDANCE_APPROVE)
                    ? ctx.db
                        .selectFrom('attendance')
                        .select((eb) => eb.fn.countAll().as('n'))
                        .where('approved_by', 'is', null)
                        .executeTakeFirst()
                    : Promise.resolve(undefined),
            ]);
            const total = rows.reduce((sum, r) => sum + Number(r?.n ?? 0), 0);
            return { kind: 'count', count: total, hint: 'Expenses, purchase orders and attendance in your queues.' };
        }
        case 'open_requisitions': {
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('material_requisitions')
                .select((eb) => eb.fn.countAll().as('n'))
                .where('material_requisitions.status', 'in', ['submitted', 'approved', 'partially_ordered']);
            if (scoped)
                q = q.where('material_requisitions.project_id', 'in', scoped.length ? scoped : [0]);
            const row = await q.executeTakeFirst();
            return { kind: 'count', count: Number(row?.n ?? 0), hint: 'Submitted, approved or partially ordered.' };
        }
        case 'billed_this_month': {
            const m = monthBounds(monthOf(today()));
            const row = await ctx.db
                .selectFrom('client_invoices')
                .select((eb) => eb.fn.sum('total_paise').as('total'))
                .where('invoice_date', '>=', m.start)
                .where('invoice_date', '<=', m.end)
                .where('status', 'not in', ['draft', 'cancelled'])
                .executeTakeFirst();
            return { kind: 'money', paise: Number(row?.total ?? 0), hint: 'Client invoices dated this month, drafts excluded.' };
        }
        case 'collected_this_month': {
            const m = monthBounds(monthOf(today()));
            const row = await ctx.db
                .selectFrom('payments')
                .select((eb) => eb.fn.sum('amount_paise').as('total'))
                .where('payment_date', '>=', m.start)
                .where('payment_date', '<=', m.end)
                .where('direction', '=', 'incoming')
                .where('status', '!=', 'cancelled')
                .executeTakeFirst();
            return { kind: 'money', paise: Number(row?.total ?? 0), hint: 'Incoming payments dated this month.' };
        }
        case 'work_in_hand': {
            // Pending owner question 19 — the narrowest defensible definition:
            // milestones awaiting certification (earned, not yet certified).
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('project_milestones')
                .select((eb) => eb.fn.sum('amount_paise').as('total'))
                .where('project_milestones.status', '=', 'ready_to_certify');
            if (scoped)
                q = q.where('project_milestones.project_id', 'in', scoped.length ? scoped : [0]);
            const row = await q.executeTakeFirst();
            return {
                kind: 'money',
                paise: Number(row?.total ?? 0),
                hint: 'Milestones ready to certify (definition pending owner item 19).',
            };
        }
        case 'gross_margin': {
            // Never a number: without labour cost in the model (29.26) any margin
            // would be overstated. Em dash + not-wired label, rendered by routes.
            return { kind: 'rows', rows: [], empty: 'Not wired yet — labour cost is not in the model (see DECISIONS 29.26).' };
        }
        case 'cash_position': {
            const snap = await snapshot(ctx.db, 'cash.balance');
            return { kind: 'money', paise: snap.paise, hint: 'Across all bank accounts, as of last night.' };
        }
        case 'month_revenue': {
            const fy = currentFinancialYear();
            const bounds = financialYearBounds(fy);
            const row = await ctx.db
                .selectFrom('client_invoices')
                .select((eb) => eb.fn.sum('total_paise').as('total'))
                .where('invoice_date', '>=', bounds.start)
                .where('invoice_date', '<=', bounds.end)
                .where('status', 'not in', ['draft', 'cancelled'])
                .executeTakeFirst();
            return { kind: 'money', paise: Number(row?.total ?? 0), hint: `Invoiced in FY ${fy}.` };
        }
        case 'receivables_ageing': {
            // Buckets are computed in SQL, so the whole ledger is not pulled into
            // Node to be reduced. Ageing is from the due date, not the invoice
            // date: an invoice on 60 day terms is not overdue on day 30.
            const rows = await ctx.db
                .selectFrom('client_invoices')
                .select((eb) => [
                eb.fn.sum('total_paise').as('billed'),
                eb.fn.sum('received_paise').as('received'),
                eb.ref('due_date').as('due_date'),
            ])
                .where('status', 'not in', ['draft', 'cancelled', 'paid'])
                .groupBy('due_date')
                .execute();
            const now = today();
            const buckets = { current: 0, d30: 0, d60: 0, d90: 0 };
            for (const row of rows) {
                const outstanding = Number(row.billed ?? 0) - Number(row.received ?? 0);
                if (outstanding <= 0)
                    continue;
                const due = row.due_date;
                if (!due || due >= now)
                    buckets.current += outstanding;
                else if (due >= addDays(now, -30))
                    buckets.d30 += outstanding;
                else if (due >= addDays(now, -60))
                    buckets.d60 += outstanding;
                else
                    buckets.d90 += outstanding;
            }
            return {
                kind: 'rows',
                empty: 'Nothing outstanding.',
                rows: [
                    { label: 'Not yet due', value: fmt(buckets.current) },
                    { label: 'Overdue up to 30 days', value: fmt(buckets.d30), tone: buckets.d30 > 0 ? 'warn' : undefined },
                    { label: 'Overdue 31 to 60 days', value: fmt(buckets.d60), tone: buckets.d60 > 0 ? 'warn' : undefined },
                    { label: 'Overdue over 60 days', value: fmt(buckets.d90), tone: buckets.d90 > 0 ? 'error' : undefined },
                ].filter((r) => r.value !== fmt(0)),
            };
        }
        case 'projects_over_budget': {
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('projects')
                .leftJoin('project_budgets', (join) => join.onRef('project_budgets.project_id', '=', 'projects.id').on('project_budgets.status', '=', 'approved'))
                .select(['projects.id', 'projects.code', 'projects.name', 'project_budgets.total_paise as budget'])
                .where('projects.status', 'in', ['mobilising', 'in_progress', 'snagging']);
            if (scoped)
                q = q.where('projects.id', 'in', scoped.length ? scoped : [0]);
            const projects = await q.execute();
            if (projects.length === 0)
                return { kind: 'rows', rows: [], empty: 'No active projects.' };
            const spendRows = await ctx.db
                .selectFrom('expenses')
                .select((eb) => [eb.ref('project_id').as('project_id'), eb.fn.sum('total_paise').as('spent')])
                .where('status', 'in', ['approved', 'part_paid', 'paid'])
                .where('project_id', 'in', projects.map((p) => p.id))
                .groupBy('project_id')
                .execute();
            const spend = new Map(spendRows.map((r) => [Number(r.project_id), Number(r.spent ?? 0)]));
            const over = projects
                .map((p) => {
                const budget = Number(p.budget ?? 0);
                const spent = spend.get(p.id) ?? 0;
                return { ...p, budget, spent, pct: budget > 0 ? Math.round((spent / budget) * 100) : null };
            })
                .filter((p) => p.pct !== null && p.pct >= 90)
                .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
            return {
                kind: 'rows',
                empty: 'Every active project is inside its budget.',
                rows: over.map((p) => ({
                    label: `${p.code} ${p.name}`,
                    value: `${p.pct}% of budget`,
                    href: `/app/projects/${p.id}`,
                    tone: (p.pct ?? 0) > 100 ? 'error' : 'warn',
                })),
            };
        }
        case 'pending_approvals': {
            // Segregation of duties: a document you created is never in your own
            // approval queue, including for owner (spec 4.3). The filter is in SQL
            // so the count and the list cannot disagree.
            const rows = [];
            if (ctx.perms.has(PERMISSIONS.FINANCE_EXPENSE_APPROVE)) {
                const row = await ctx.db
                    .selectFrom('expenses')
                    .select((eb) => eb.fn.countAll().as('n'))
                    .where('status', '=', 'pending_approval')
                    .where('created_by', '!=', ctx.userId)
                    .executeTakeFirst();
                const n = Number(row?.n ?? 0);
                if (n > 0)
                    rows.push({ label: 'Expenses', value: `${n} waiting`, href: '/app/finance/expenses?status=pending_approval' });
            }
            if (ctx.perms.has(PERMISSIONS.INVENTORY_APPROVE_PO)) {
                const row = await ctx.db
                    .selectFrom('purchase_orders')
                    .select((eb) => eb.fn.countAll().as('n'))
                    .where('status', '=', 'pending_approval')
                    .where('created_by', '!=', ctx.userId)
                    .executeTakeFirst();
                const n = Number(row?.n ?? 0);
                if (n > 0)
                    rows.push({ label: 'Purchase orders', value: `${n} waiting`, href: '/app/inventory/po?status=pending_approval' });
            }
            if (ctx.perms.has(PERMISSIONS.CRM_QUOTE_APPROVE)) {
                const row = await ctx.db
                    .selectFrom('quotes')
                    .select((eb) => eb.fn.countAll().as('n'))
                    .where('status', '=', 'pending_approval')
                    .where('created_by', '!=', ctx.userId)
                    .executeTakeFirst();
                const n = Number(row?.n ?? 0);
                if (n > 0)
                    rows.push({ label: 'Quotes', value: `${n} waiting`, href: '/app/crm/quotes?status=pending_approval' });
            }
            if (ctx.perms.has(PERMISSIONS.HR_LEAVE_APPROVE)) {
                let q = ctx.db
                    .selectFrom('leave_requests')
                    .select((eb) => eb.fn.countAll().as('n'))
                    .where('status', '=', 'pending');
                // Leave self-approval is blocked by employee, not by user, because
                // the request is filed against an employee record.
                if (ctx.employeeId !== null)
                    q = q.where('employee_id', '!=', ctx.employeeId);
                const row = await q.executeTakeFirst();
                const n = Number(row?.n ?? 0);
                if (n > 0)
                    rows.push({ label: 'Leave requests', value: `${n} waiting`, href: '/app/hr/leave?status=pending' });
            }
            if (ctx.perms.has(PERMISSIONS.HR_ATTENDANCE_APPROVE)) {
                const row = await ctx.db
                    .selectFrom('attendance')
                    .select((eb) => eb.fn.countAll().as('n'))
                    .where('approved_by', 'is', null)
                    .where('attendance_date', '>=', addDays(today(), -31))
                    .executeTakeFirst();
                const n = Number(row?.n ?? 0);
                if (n > 0)
                    rows.push({ label: 'Attendance days', value: `${n} unapproved`, href: '/app/hr/attendance' });
            }
            return { kind: 'rows', rows, empty: 'Nothing is waiting for your approval.' };
        }
        case 'my_projects': {
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('projects')
                .select(['id', 'code', 'name', 'status', 'physical_progress_pct'])
                .where('status', 'in', ['mobilising', 'in_progress', 'on_hold', 'snagging'])
                .orderBy('code')
                .limit(12);
            if (scoped)
                q = q.where('id', 'in', scoped.length ? scoped : [0]);
            const rows = await q.execute();
            return {
                kind: 'rows',
                empty: scoped && scoped.length === 0 ? 'You have no project assignments yet.' : 'No active projects.',
                rows: rows.map((p) => ({
                    label: `${p.code} ${p.name}`,
                    value: `${Number(p.physical_progress_pct)}% ${p.status.replace(/_/g, ' ')}`,
                    href: `/app/projects/${p.id}`,
                    tone: p.status === 'on_hold' ? 'warn' : undefined,
                })),
            };
        }
        case 'dpr_status': {
            // A red row for any active project with no DPR filed yesterday
            // (spec 6.2). Yesterday, not today, because today's report is written
            // at the end of the day and chasing it at 9am is noise.
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            const day = yesterday();
            let q = ctx.db
                .selectFrom('projects')
                .leftJoin('daily_progress_reports', (join) => join
                .onRef('daily_progress_reports.project_id', '=', 'projects.id')
                .on('daily_progress_reports.report_date', '=', day))
                .select(['projects.id', 'projects.code', 'projects.name', 'daily_progress_reports.id as dpr_id'])
                .where('projects.status', 'in', ['mobilising', 'in_progress', 'snagging'])
                .orderBy('projects.code');
            if (scoped)
                q = q.where('projects.id', 'in', scoped.length ? scoped : [0]);
            const rows = await q.execute();
            const missing = rows.filter((r) => r.dpr_id === null);
            return {
                kind: 'rows',
                empty: 'Every active site filed a report.',
                rows: missing.map((p) => ({
                    label: `${p.code} ${p.name}`,
                    value: `No report for ${day}`,
                    href: `/app/projects/${p.id}/dprs`,
                    tone: 'error',
                })),
            };
        }
        case 'open_snags': {
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('snags')
                .select((eb) => eb.fn.countAll().as('n'))
                .where('status', 'in', ['open', 'in_progress']);
            if (scoped)
                q = q.where('project_id', 'in', scoped.length ? scoped : [0]);
            const row = await q.executeTakeFirst();
            return { kind: 'count', count: Number(row?.n ?? 0), hint: 'Open or in progress.' };
        }
        case 'milestones_due': {
            const scoped = await projectScopeFilter(ctx.db, ctx.scope);
            let q = ctx.db
                .selectFrom('project_milestones')
                .innerJoin('projects', 'projects.id', 'project_milestones.project_id')
                .select([
                'project_milestones.id',
                'project_milestones.name',
                'project_milestones.due_date',
                'project_milestones.status',
                'projects.code',
                'projects.id as project_id',
            ])
                .where('project_milestones.status', 'in', ['pending', 'ready_to_certify'])
                .where('project_milestones.due_date', 'is not', null)
                .where('project_milestones.due_date', '<=', addDays(today(), 14))
                .orderBy('project_milestones.due_date')
                .limit(10);
            if (scoped)
                q = q.where('project_milestones.project_id', 'in', scoped.length ? scoped : [0]);
            const rows = await q.execute();
            return {
                kind: 'rows',
                empty: 'No milestones due in the next fortnight.',
                rows: rows.map((m) => ({
                    label: `${m.code} ${m.name}`,
                    value: m.due_date ?? '',
                    href: `/app/projects/${m.project_id}/milestones`,
                    tone: (m.due_date ?? '') < today() ? 'error' : 'warn',
                })),
            };
        }
        case 'lead_funnel': {
            // A sales exec sees their own leads. A manager with lead_assign sees
            // everyone's, because reassigning requires seeing the whole board.
            const mine = !ctx.perms.has(PERMISSIONS.CRM_LEAD_ASSIGN);
            let q = ctx.db
                .selectFrom('leads')
                .select((eb) => [eb.ref('stage').as('stage'), eb.fn.countAll().as('n')])
                .where('stage', 'not in', ['won', 'lost', 'disqualified', 'dormant'])
                .groupBy('stage');
            if (mine)
                q = q.where('assigned_to', '=', ctx.userId);
            const rows = await q.execute();
            return {
                kind: 'rows',
                empty: mine ? 'You have no open leads.' : 'No open leads.',
                rows: rows.map((r) => ({
                    label: String(r.stage).replace(/_/g, ' '),
                    value: String(r.n),
                    href: `/app/crm/leads?stage=${r.stage}`,
                })),
            };
        }
        case 'unassigned_enquiries': {
            const row = await ctx.db
                .selectFrom('enquiries')
                .select((eb) => eb.fn.countAll().as('n'))
                .where('status', '=', 'new')
                .executeTakeFirst();
            return { kind: 'count', count: Number(row?.n ?? 0), hint: 'From the website, not yet actioned.' };
        }
        case 'stale_quotes': {
            const cutoff = addDays(today(), -7);
            let q = ctx.db
                .selectFrom('quotes')
                .innerJoin('leads', 'leads.id', 'quotes.lead_id')
                .select(['quotes.id', 'quotes.quote_no', 'quotes.sent_at', 'leads.contact_name'])
                .where('quotes.status', 'in', ['sent', 'viewed'])
                .where('quotes.sent_at', '<', cutoff)
                .orderBy('quotes.sent_at')
                .limit(10);
            if (!ctx.perms.has(PERMISSIONS.CRM_LEAD_ASSIGN))
                q = q.where('quotes.created_by', '=', ctx.userId);
            const rows = await q.execute();
            return {
                kind: 'rows',
                empty: 'No quotes have gone quiet.',
                rows: rows.map((r) => ({
                    label: `${r.quote_no} ${r.contact_name}`,
                    value: `Sent ${String(r.sent_at ?? '').slice(0, 10)}`,
                    href: `/app/crm/quotes/${r.id}`,
                    tone: 'warn',
                })),
            };
        }
        case 'attendance_pending': {
            const row = await ctx.db
                .selectFrom('attendance')
                .select((eb) => eb.fn.countAll().as('n'))
                .where('approved_by', 'is', null)
                .where('attendance_date', '>=', addDays(today(), -31))
                .executeTakeFirst();
            return { kind: 'count', count: Number(row?.n ?? 0), hint: 'Days marked but not approved.' };
        }
        case 'documents_expiring': {
            const rows = await ctx.db
                .selectFrom('employee_documents')
                .innerJoin('employees', 'employees.id', 'employee_documents.employee_id')
                .select([
                'employee_documents.id',
                'employee_documents.doc_type',
                'employee_documents.expires_on',
                'employees.full_name',
                'employees.id as employee_id',
            ])
                .where('employee_documents.expires_on', 'is not', null)
                .where('employee_documents.expires_on', '<=', addDays(today(), 30))
                .where('employees.status', '!=', 'exited')
                .orderBy('employee_documents.expires_on')
                .limit(10)
                .execute();
            return {
                kind: 'rows',
                empty: 'No documents expire in the next 30 days.',
                rows: rows.map((d) => ({
                    label: `${d.full_name} ${String(d.doc_type).replace(/_/g, ' ')}`,
                    value: d.expires_on ?? '',
                    href: `/app/hr/employees/${d.employee_id}`,
                    tone: (d.expires_on ?? '') < today() ? 'error' : 'warn',
                })),
            };
        }
        case 'job_openings': {
            const row = await ctx.db
                .selectFrom('job_openings')
                .select((eb) => eb.fn.countAll().as('n'))
                .where('status', 'in', ['open', 'on_hold'])
                .executeTakeFirst();
            return { kind: 'count', count: Number(row?.n ?? 0), hint: 'Requisitions not yet filled.' };
        }
        case 'low_stock': {
            // item_stock is the rebuildable cache, which is exactly what a
            // reorder screen should read: the ledger is the truth but summing it
            // per item per location on a dashboard is a table scan.
            const rows = await ctx.db
                .selectFrom('item_stock')
                .innerJoin('items', 'items.id', 'item_stock.item_id')
                .innerJoin('locations', 'locations.id', 'item_stock.location_id')
                .innerJoin('units', 'units.id', 'items.unit_id')
                .select([
                'items.id',
                'items.code',
                'items.name',
                'items.reorder_level',
                'item_stock.qty_on_hand',
                'locations.name as location',
                'units.code as unit',
            ])
                .where('items.reorder_level', 'is not', null)
                .where('items.is_active', '=', 1)
                .whereRef('item_stock.qty_on_hand', '<=', 'items.reorder_level')
                .orderBy('items.code')
                .limit(10)
                .execute();
            return {
                kind: 'rows',
                empty: 'Every tracked item is above its reorder level.',
                rows: rows.map((r) => ({
                    label: `${r.name} at ${r.location}`,
                    value: `${Number(r.qty_on_hand)} ${r.unit} left`,
                    href: `/app/inventory/items/${r.id}`,
                    tone: Number(r.qty_on_hand) <= 0 ? 'error' : 'warn',
                })),
            };
        }
        default: {
            const exhaustive = key;
            throw new Error(`Unknown widget ${String(exhaustive)}`);
        }
    }
}
function fmt(paise) {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
    }).format(paise / 100);
}
