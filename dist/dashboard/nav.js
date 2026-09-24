import { PERMISSIONS } from '../lib/permissions.js';
export const NAV = [
    {
        label: 'Overview',
        items: [
            { label: 'My dashboard', href: '/app', perms: [PERMISSIONS.DASHBOARD_VIEW_OWN_KPI] },
            { label: 'Alerts and reminders', href: '/app/notifications', perms: [PERMISSIONS.DASHBOARD_VIEW_OWN_KPI] },
        ],
    },
    {
        label: 'Projects',
        items: [
            { label: 'All projects', href: '/app/projects', perms: [PERMISSIONS.PROJECTS_VIEW] },
            // Project workspace: per-project screens exist (/app/projects/:id) but
            // the workspace landing page does not; disabled until it does.
            { label: 'Project workspace', href: '/app/projects/workspace', perms: [PERMISSIONS.PROJECTS_VIEW], disabled: true },
            { label: 'Daily site report', href: '/app/projects/dprs', perms: [PERMISSIONS.PROJECTS_DPR_SUBMIT, PERMISSIONS.PROJECTS_VIEW] },
            // Quality checks: quality_checks table exists (004), screen not built.
            { label: 'Quality checks', href: '/app/projects/quality', perms: [PERMISSIONS.PROJECTS_VIEW], disabled: true },
            // Payment milestones: the milestones_due widget links per-project
            // milestone screens today; no cross-project list page exists yet.
            { label: 'Payment milestones', href: '/app/projects/milestones', perms: [PERMISSIONS.PROJECTS_VIEW], disabled: true },
            { label: 'Snag list', href: '/app/projects/snags', perms: [PERMISSIONS.PROJECTS_SNAG_MANAGE, PERMISSIONS.PROJECTS_VIEW] },
            // Team on the job: assignment screen not built; site_supervisor scope
            // will decide its permission when it is.
            { label: 'Team on the job', href: '/app/projects/team', perms: [PERMISSIONS.PROJECTS_VIEW], disabled: true },
        ],
    },
    {
        label: 'Inventory',
        items: [
            { label: 'Stock on hand', href: '/app/inventory', perms: [PERMISSIONS.INVENTORY_VIEW] },
            { label: 'Material requests', href: '/app/inventory/requisitions', perms: [PERMISSIONS.INVENTORY_VIEW] },
            { label: 'Goods received at the gate', href: '/app/inventory/grn', perms: [PERMISSIONS.INVENTORY_GRN_CREATE] },
            { label: 'Material issued to work', href: '/app/inventory/issues', perms: [PERMISSIONS.INVENTORY_ISSUE] },
            { label: 'Transfers between sites', href: '/app/inventory/transfers', perms: [PERMISSIONS.INVENTORY_TRANSFER] },
            { label: 'Stock adjustment', href: '/app/inventory/adjustments', perms: [PERMISSIONS.INVENTORY_VIEW] },
            { label: 'Purchase orders', href: '/app/inventory/po', perms: [PERMISSIONS.INVENTORY_PO_CREATE, PERMISSIONS.INVENTORY_APPROVE_PO] },
            // Items catalogue: real route, dropped from the target structure's
            // eleven-item list; reached from Stock on hand today.
            { label: 'Items', href: '/app/inventory/items', perms: [PERMISSIONS.INVENTORY_VIEW] },
            { label: 'Vendors', href: '/app/inventory/vendors', perms: [PERMISSIONS.INVENTORY_VENDOR_MANAGE] },
            { label: 'Equipment', href: '/app/inventory/equipment', perms: [PERMISSIONS.INVENTORY_VIEW] },
            // The list pages of all three read with inventory.view and gate their own
            // write actions inside, which is why these are not listed under
            // stock_adjust or a report permission that does not exist.
            { label: 'Consumption', href: '/app/inventory/reports/consumption', perms: [PERMISSIONS.INVENTORY_VIEW] },
        ],
    },
    {
        label: 'Sales',
        items: [
            { label: 'Pipeline', href: '/app/crm', perms: [PERMISSIONS.CRM_LEAD_VIEW] },
            { label: 'Leads', href: '/app/crm/leads', perms: [PERMISSIONS.CRM_LEAD_VIEW] },
            { label: 'Site visits', href: '/app/crm/visits', perms: [PERMISSIONS.CRM_LEAD_VIEW] },
            { label: 'Quotes', href: '/app/crm/quotes', perms: [PERMISSIONS.CRM_QUOTE_CREATE, PERMISSIONS.CRM_QUOTE_APPROVE] },
            { label: 'Enquiries', href: '/app/admin/enquiries', perms: [PERMISSIONS.ENQUIRIES_VIEW] },
            // Sources and losses are reached from the funnel page. Only the funnel is
            // linked here, for the same reason inventory links Consumption and not its
            // other two reports: a sidebar that lists every report stops being a way
            // to find anything.
            { label: 'Funnel', href: '/app/crm/reports/funnel', perms: [PERMISSIONS.CRM_VIEW_PIPELINE_VALUE] },
        ],
    },
    {
        label: 'Money',
        items: [
            { label: 'Budgets', href: '/app/finance/budgets', perms: [PERMISSIONS.FINANCE_VIEW_PROJECT_BUDGET] },
            { label: 'Expenses', href: '/app/finance/expenses', perms: [PERMISSIONS.FINANCE_EXPENSE_CREATE, PERMISSIONS.FINANCE_EXPENSE_APPROVE] },
            { label: 'Invoices', href: '/app/finance/invoices', perms: [PERMISSIONS.FINANCE_INVOICE_MANAGE] },
            { label: 'Payments', href: '/app/finance/payments', perms: [PERMISSIONS.FINANCE_PAYMENT_RECORD] },
            { label: 'Periods', href: '/app/finance/periods', perms: [PERMISSIONS.FINANCE_PERIOD_CLOSE] },
        ],
    },
    {
        label: 'People',
        items: [
            { label: 'Employees', href: '/app/hr/employees', perms: [PERMISSIONS.HR_EMPLOYEE_VIEW] },
            // hr.employee_view is here because it is what the 6.6 route table gives
            // the attendance GET, and the route now guards on the OR of all three.
            { label: 'Attendance', href: '/app/hr/attendance', perms: [PERMISSIONS.HR_EMPLOYEE_VIEW, PERMISSIONS.HR_ATTENDANCE_RECORD, PERMISSIONS.HR_ATTENDANCE_APPROVE] },
            // Far-flag review (DECISIONS 31): Sushma's day view of check-in and
            // check-out readings beyond the 500 m threshold. Recorded, never refused,
            // so the link sits beside Attendance rather than inside it.
            { label: 'Far check-ins', href: '/app/hr/attendance/far', perms: [PERMISSIONS.HR_ATTENDANCE_RECORD] },
            // The statutory register, linked despite the "not every report" rule the
            // CRM group states: hr.employee_view is the only permission the spec gives
            // it, and the link on the attendance screen sits behind permissions an
            // employee_view holder need not have.
            { label: 'Muster roll', href: '/app/hr/reports/muster', perms: [PERMISSIONS.HR_EMPLOYEE_VIEW] },
            // Any authenticated user: the route is "own" and unguarded. See anyUser.
            { label: 'Leave', href: '/app/hr/leave', perms: [PERMISSIONS.HR_LEAVE_APPROVE, PERMISSIONS.HR_EMPLOYEE_VIEW], anyUser: true },
            { label: 'Contractors', href: '/app/hr/contractors', perms: [PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE] },
            // Bills are linked separately from the contractor master because they are
            // money: 6.8 rule 1 turns an approved one into an expenses row, and the
            // person chasing a payment should not have to go through a contractor
            // profile to find it. Attendance entry is not linked -- it is only ever
            // reached for one contractor on one site, so it starts from Contractors.
            { label: 'Contractor bills', href: '/app/hr/contractor-bills', perms: [PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE] },
            { label: 'Recruiting', href: '/app/hr/recruiting', perms: [PERMISSIONS.HR_RECRUIT_MANAGE] },
        ],
    },
    {
        label: 'Marketing',
        items: [
            { label: 'Overview', href: '/app/marketing', perms: [PERMISSIONS.MARKETING_VIEW] },
            { label: 'Campaigns', href: '/app/marketing/campaigns', perms: [PERMISSIONS.MARKETING_CAMPAIGN_MANAGE] },
            { label: 'Site content', href: '/app/marketing/content', perms: [PERMISSIONS.SITE_CONTENT_MANAGE] },
        ],
    },
    {
        label: 'Administration',
        items: [
            { label: 'Users', href: '/app/admin/users', perms: [PERMISSIONS.USERS_MANAGE] },
            { label: 'Roles', href: '/app/admin/roles', perms: [PERMISSIONS.ROLES_MANAGE] },
            { label: 'Approval limits', href: '/app/admin/approval-limits', perms: [PERMISSIONS.ROLES_MANAGE] },
            { label: 'Reference data', href: '/app/admin/reference', perms: [PERMISSIONS.REFERENCE_MANAGE] },
            { label: 'Settings', href: '/app/admin/settings', perms: [PERMISSIONS.REFERENCE_MANAGE] },
            { label: 'Audit log', href: '/app/admin/audit', perms: [PERMISSIONS.AUDIT_VIEW] },
        ],
    },
];
/** Drops items the user cannot reach, then drops groups left empty. */
export function visibleNav(perms) {
    return NAV.map((group) => ({
        label: group.label,
        items: group.items.filter((item) => item.anyUser === true || item.perms.some((p) => perms.has(p))),
    })).filter((group) => group.items.length > 0);
}
/**
 * Longest-prefix match so /app/projects/12/stages highlights Projects, while
 * /app/projects/snags highlights Snags rather than both.
 */
export function activeHref(path, groups) {
    let best = null;
    for (const group of groups) {
        for (const item of group.items) {
            if (path === item.href || path.startsWith(item.href + '/')) {
                if (best === null || item.href.length > best.length)
                    best = item.href;
            }
        }
    }
    return best;
}
