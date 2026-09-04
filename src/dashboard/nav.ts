import { PERMISSIONS, type PermissionKey } from '../lib/permissions.js'

/**
 * The sidebar, defined as data so it is filtered by the permission set rather
 * than by a role name (spec 4.1).
 *
 * Every item names the permission that its landing route also guards. That
 * pairing is the invariant: a link the user can see is a link that will not
 * 403, and a route they can reach is a route they can find. Getting these out
 * of step produces either dead links or hidden features, and both look like
 * bugs to the user.
 */

export interface NavItem {
  label: string
  href: string
  /** Any one of these admits the item. */
  perms: PermissionKey[]
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', href: '/app', perms: [PERMISSIONS.DASHBOARD_VIEW_OWN_KPI] },
      { label: 'Notifications', href: '/app/notifications', perms: [PERMISSIONS.DASHBOARD_VIEW_OWN_KPI] },
    ],
  },
  {
    label: 'Projects',
    items: [
      { label: 'Projects', href: '/app/projects', perms: [PERMISSIONS.PROJECTS_VIEW] },
      { label: 'Daily reports', href: '/app/projects/dprs', perms: [PERMISSIONS.PROJECTS_DPR_SUBMIT, PERMISSIONS.PROJECTS_VIEW] },
      { label: 'Snags', href: '/app/projects/snags', perms: [PERMISSIONS.PROJECTS_SNAG_MANAGE, PERMISSIONS.PROJECTS_VIEW] },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Stock', href: '/app/inventory', perms: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Items', href: '/app/inventory/items', perms: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Requisitions', href: '/app/inventory/requisitions', perms: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Goods receipt', href: '/app/inventory/grn', perms: [PERMISSIONS.INVENTORY_GRN_CREATE] },
      { label: 'Issues', href: '/app/inventory/issues', perms: [PERMISSIONS.INVENTORY_ISSUE] },
      { label: 'Transfers', href: '/app/inventory/transfers', perms: [PERMISSIONS.INVENTORY_TRANSFER] },
      { label: 'Adjustments', href: '/app/inventory/adjustments', perms: [PERMISSIONS.INVENTORY_VIEW] },
      { label: 'Purchase orders', href: '/app/inventory/po', perms: [PERMISSIONS.INVENTORY_PO_CREATE, PERMISSIONS.INVENTORY_APPROVE_PO] },
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
      { label: 'Attendance', href: '/app/hr/attendance', perms: [PERMISSIONS.HR_ATTENDANCE_RECORD, PERMISSIONS.HR_ATTENDANCE_APPROVE] },
      { label: 'Leave', href: '/app/hr/leave', perms: [PERMISSIONS.HR_LEAVE_APPROVE, PERMISSIONS.HR_EMPLOYEE_VIEW] },
      { label: 'Contractors', href: '/app/hr/contractors', perms: [PERMISSIONS.HR_LABOUR_CONTRACTOR_MANAGE] },
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
]

/** Drops items the user cannot reach, then drops groups left empty. */
export function visibleNav(perms: Set<string>): NavGroup[] {
  return NAV.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => item.perms.some((p) => perms.has(p))),
  })).filter((group) => group.items.length > 0)
}

/**
 * Longest-prefix match so /app/projects/12/stages highlights Projects, while
 * /app/projects/snags highlights Snags rather than both.
 */
export function activeHref(path: string, groups: NavGroup[]): string | null {
  let best: string | null = null
  for (const group of groups) {
    for (const item of group.items) {
      if (path === item.href || path.startsWith(item.href + '/')) {
        if (best === null || item.href.length > best.length) best = item.href
      }
    }
  }
  return best
}
