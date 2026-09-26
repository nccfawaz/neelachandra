/**
 * The permission keys, as a const object so a typo in requirePermission is a
 * compile error rather than a guard that silently passes nobody (spec 4.1).
 *
 * This list mirrors migrations/002_rbac.sql exactly. The migration is the
 * source of truth for the database rows; this object is the source of truth
 * for the code, and scripts/check-permission-parity.mjs asserts the two sets
 * are identical so they cannot drift.
 */
export const PERMISSIONS = {
    // Auth and account
    USERS_MANAGE: 'users.manage',
    ROLES_MANAGE: 'roles.manage',
    SESSIONS_REVOKE_OTHERS: 'sessions.revoke_others',
    AUDIT_VIEW: 'audit.view',
    // Admin dashboard
    DASHBOARD_VIEW_COMPANY_KPI: 'dashboard.view_company_kpi',
    DASHBOARD_VIEW_OWN_KPI: 'dashboard.view_own_kpi',
    REFERENCE_MANAGE: 'reference.manage',
    SITE_CONTENT_MANAGE: 'site_content.manage',
    ENQUIRIES_VIEW: 'enquiries.view',
    // Projects tracker
    PROJECTS_VIEW: 'projects.view',
    PROJECTS_MANAGE: 'projects.manage',
    PROJECTS_VIEW_COST: 'projects.view_cost',
    PROJECTS_ASSIGN_STAFF: 'projects.assign_staff',
    PROJECTS_UPDATE_PROGRESS: 'projects.update_progress',
    PROJECTS_DPR_SUBMIT: 'projects.dpr_submit',
    PROJECTS_QUALITY_SIGNOFF: 'projects.quality_signoff',
    PROJECTS_MILESTONE_CERTIFY: 'projects.milestone_certify',
    PROJECTS_SNAG_MANAGE: 'projects.snag_manage',
    // Inventory
    INVENTORY_VIEW: 'inventory.view',
    INVENTORY_ITEM_MANAGE: 'inventory.item_manage',
    INVENTORY_GRN_CREATE: 'inventory.grn_create',
    INVENTORY_ISSUE: 'inventory.issue',
    INVENTORY_TRANSFER: 'inventory.transfer',
    INVENTORY_STOCK_ADJUST: 'inventory.stock_adjust',
    INVENTORY_PO_CREATE: 'inventory.po_create',
    INVENTORY_APPROVE_PO: 'inventory.approve_po',
    INVENTORY_VENDOR_MANAGE: 'inventory.vendor_manage',
    INVENTORY_VIEW_RATES: 'inventory.view_rates',
    // Marketing
    MARKETING_VIEW: 'marketing.view',
    MARKETING_CAMPAIGN_MANAGE: 'marketing.campaign_manage',
    MARKETING_CONTENT_PUBLISH: 'marketing.content_publish',
    MARKETING_SPEND_RECORD: 'marketing.spend_record',
    MARKETING_ANALYTICS_VIEW: 'marketing.analytics_view',
    // HR and recruiting
    HR_EMPLOYEE_VIEW: 'hr.employee_view',
    HR_EMPLOYEE_MANAGE: 'hr.employee_manage',
    HR_ATTENDANCE_RECORD: 'hr.attendance_record',
    HR_ATTENDANCE_APPROVE: 'hr.attendance_approve',
    HR_LEAVE_APPROVE: 'hr.leave_approve',
    HR_PAYROLL_VIEW: 'hr.payroll_view',
    HR_PAYROLL_RUN: 'hr.payroll_run',
    HR_DOCUMENT_MANAGE: 'hr.document_manage',
    HR_RECRUIT_MANAGE: 'hr.recruit_manage',
    HR_LABOUR_CONTRACTOR_MANAGE: 'hr.labour_contractor_manage',
    // Sales and CRM
    CRM_LEAD_VIEW: 'crm.lead_view',
    CRM_LEAD_MANAGE: 'crm.lead_manage',
    CRM_LEAD_ASSIGN: 'crm.lead_assign',
    CRM_QUOTE_CREATE: 'crm.quote_create',
    CRM_QUOTE_APPROVE: 'crm.quote_approve',
    CRM_QUOTE_DISCOUNT_OVERRIDE: 'crm.quote_discount_override',
    CRM_CONVERT_TO_PROJECT: 'crm.convert_to_project',
    CRM_VIEW_PIPELINE_VALUE: 'crm.view_pipeline_value',
    // Budget and expense
    FINANCE_VIEW_PROJECT_BUDGET: 'finance.view_project_budget',
    FINANCE_BUDGET_SET: 'finance.budget_set',
    FINANCE_EXPENSE_CREATE: 'finance.expense_create',
    FINANCE_EXPENSE_APPROVE: 'finance.expense_approve',
    FINANCE_PAYMENT_RECORD: 'finance.payment_record',
    FINANCE_INVOICE_MANAGE: 'finance.invoice_manage',
    FINANCE_VIEW_COMPANY_PNL: 'finance.view_company_pnl',
    FINANCE_PERIOD_CLOSE: 'finance.period_close',
    FINANCE_EXPORT: 'finance.export',
};
export const ALL_PERMISSIONS = Object.values(PERMISSIONS);
export const ROLE_KEYS = [
    'owner',
    'admin',
    'ops_manager',
    'project_manager',
    'site_supervisor',
    'accounts_manager',
    'hr_manager',
    'sales_exec',
];
/** Module grouping for the role editor, which shows checkboxes by module. */
export const PERMISSION_MODULES = [
    { key: 'auth', label: 'Authentication and accounts' },
    { key: 'admin', label: 'Admin and dashboard' },
    { key: 'projects', label: 'Projects tracker' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'marketing', label: 'Marketing' },
    { key: 'hr', label: 'HR and recruiting' },
    { key: 'crm', label: 'Sales and CRM' },
    { key: 'finance', label: 'Budget and expense' },
];
/**
 * The one permission check. It takes the precomputed set from
 * c.var.perms, never a role string.
 */
export function can(perms, permission) {
    return perms.has(permission);
}
export function canAny(perms, permissions) {
    return permissions.some((p) => perms.has(p));
}
export function canAll(perms, permissions) {
    return permissions.every((p) => perms.has(p));
}
/**
 * Computes the effective permission set for a user (spec 4.1):
 *
 *   effective = union(role_permissions for all user_roles)
 *             - overrides where effect = 'deny'
 *             + overrides where effect = 'grant'
 *
 * Deny is subtracted before grant is added, so an explicit grant wins over an
 * explicit deny for the same permission. That ordering is deliberate: the
 * grant is the newer, more specific act, and the admin UI shows both rows so
 * the conflict is visible rather than silently resolved.
 */
export async function loadEffectivePermissions(db, userId) {
    const roles = await db
        .selectFrom('user_roles')
        .innerJoin('roles', 'roles.id', 'user_roles.role_id')
        .select([
        'roles.id as roleId',
        'roles.key as roleKey',
        'roles.require_2fa as require2fa',
        'roles.scope_to_assigned_projects as scoped',
    ])
        .where('user_roles.user_id', '=', userId)
        .execute();
    const roleIds = roles.map((r) => r.roleId);
    const perms = new Set();
    if (roleIds.length > 0) {
        const rows = await db
            .selectFrom('role_permissions')
            .innerJoin('permissions', 'permissions.id', 'role_permissions.permission_id')
            .select('permissions.key as key')
            .where('role_permissions.role_id', 'in', roleIds)
            .execute();
        for (const r of rows)
            perms.add(r.key);
    }
    const overrides = await db
        .selectFrom('user_permission_overrides')
        .innerJoin('permissions', 'permissions.id', 'user_permission_overrides.permission_id')
        .select(['permissions.key as key', 'user_permission_overrides.effect as effect'])
        .where('user_permission_overrides.user_id', '=', userId)
        .execute();
    for (const o of overrides) {
        if (o.effect === 'deny')
            perms.delete(o.key);
    }
    for (const o of overrides) {
        if (o.effect === 'grant')
            perms.add(o.key);
    }
    return {
        perms,
        roleKeys: roles.map((r) => r.roleKey),
        // A user holding two roles where only one is scoped is NOT scoped: the
        // wider role is the grant. A PM who also holds ops_manager sees every
        // project, which is what holding ops_manager means.
        scopeToAssignedProjects: roles.length > 0 && roles.every((r) => r.scoped === 1),
        requires2fa: roles.some((r) => r.require2fa === 1),
    };
}
/**
 * Resolves the approval ceiling across every role the user holds, taking the
 * highest (spec 4.3).
 *
 * When the user holds no matching limit row, the result is `{ unlimited: true }`:
 * a permission-holder approves any amount. This is the owner's deliberate
 * decision of 2026-09-26 (DECISIONS 39.2) — the company runs WITHOUT rupee
 * ceilings on approvals. It reverses the earlier fail-closed reading (empty
 * table = "cannot approve any amount") recorded against open question 8.2:
 * that read a blank table as a freeze on every money workflow, which was never
 * the intent. The authority to approve is still gated by the approval
 * permission on the actor's role; only the AMOUNT is now uncapped. A specific
 * ceiling can still be reinstated per role/document by inserting an
 * approval_limits row, and a present row is enforced exactly as before.
 */
export async function resolveApprovalLimit(db, roleKeys, documentType, onDate) {
    const unlimited = {
        unlimited: true,
        maxValue: null,
        requiresSecondApprovalAbove: null,
        roleKey: null,
    };
    if (roleKeys.length === 0)
        return unlimited;
    const rows = await db
        .selectFrom('approval_limits')
        .select(['role_key', 'max_value', 'requires_second_approval_above'])
        .where('role_key', 'in', [...roleKeys])
        .where('document_type', '=', documentType)
        .where('effective_from', '<=', onDate)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', onDate)]))
        .execute();
    if (rows.length === 0)
        return unlimited;
    let best = rows[0];
    for (const r of rows) {
        if (Number(r.max_value) > Number(best.max_value))
            best = r;
    }
    return {
        unlimited: false,
        maxValue: Number(best.max_value),
        requiresSecondApprovalAbove: best.requires_second_approval_above === null ? null : Number(best.requires_second_approval_above),
        roleKey: best.role_key,
    };
}
