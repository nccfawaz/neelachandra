-- 002_rbac.sql
-- Phase 2, spec 4.1-4.3: the RBAC tables, approval_limits, and the seed of
-- the eight system roles and the full 4.3 permission matrix.
--
-- Scope note: spec 6.2 line 869 names TWO files for the admin dashboard
-- tables, "migrations/002_rbac.sql, 003_reference.sql", and says the RBAC
-- tables and approval_limits are defined in 4.1 and 4.3. The additional
-- reference tables it lists (settings, document_numbering, cost_heads,
-- units, notifications) therefore belong in 003_reference.sql, which is
-- created in the phase that first needs them. The phase 2 gate in section 5
-- ships only 001 and 002.
--
-- approval_limits is created empty. Its VALUES are open question 8.2 and
-- are a business decision for the client, not a seed default.
--
-- Conventions per the spec 6 preamble: InnoDB, utf8mb4_unicode_ci (spec 2.4
-- governs over the preamble's MySQL-8-only collation name), preamble
-- id/created_at/updated_at on single-key tables. Where 4.1 defines a
-- composite primary key (role_permissions, user_roles) that replaces the
-- surrogate id. The RBAC tables carry no created_by/updated_by: they are
-- seeded by migration before the first user exists, and every admin edit
-- writes an audit_log row naming the actor, which is the attribution the
-- preamble exists to provide.
--
-- `key` is a reserved word in MariaDB and is backticked everywhere.

CREATE TABLE roles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(40) NOT NULL,
  label VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  require_2fa TINYINT(1) NOT NULL DEFAULT 0,
  scope_to_assigned_projects TINYINT(1) NOT NULL DEFAULT 0,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_roles_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE permissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(80) NOT NULL,
  module VARCHAR(40) NOT NULL,
  label VARCHAR(160) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_permissions_key (`key`),
  KEY idx_permissions_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_rp_permission (permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id),
  KEY idx_user_roles_role (role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One override per user per permission, per the 4.1 model: the effect column
-- decides grant or deny, so a contradictory pair cannot exist.
CREATE TABLE user_permission_overrides (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  effect ENUM('grant','deny') NOT NULL,
  granted_by BIGINT UNSIGNED NOT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note VARCHAR(500) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_override_user_permission (user_id, permission_id),
  CONSTRAINT fk_ovo_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ovo_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE,
  CONSTRAINT fk_ovo_grantor FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Thresholds are data, not code (spec 4.3). max_value is paise, or basis
-- points when document_type is quote_discount_pct. No rows seeded: the
-- values are open question 8.2.
CREATE TABLE approval_limits (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role_key VARCHAR(40) NOT NULL,
  document_type ENUM('expense','purchase_order','quote_discount_pct','payment_release') NOT NULL,
  max_value BIGINT NOT NULL,
  requires_second_approval_above BIGINT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_approval_limits_lookup (role_key, document_type, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Seeds. Descriptions are the 4.2 role notes. The sales_exec description
-- drops the "no expense" clause from the 4.2 prose because the 4.3 matrix
-- itself grants sales W+S on finance.expense_create, and the matrix is the
-- cell-by-cell authority the phase 2 test asserts against.
-- ---------------------------------------------------------------------------

INSERT INTO roles (`key`, label, description, require_2fa, scope_to_assigned_projects, is_system) VALUES
  ('owner',           'Owner / Founder',      'Sees everything including margin. Cannot self-approve expenses.', 1, 0, 1),
  ('admin',           'System Administrator', 'User accounts, roles, reference data and the audit log. Deliberately not granted cost visibility or expense approval.', 1, 0, 1),
  ('ops_manager',     'Operations Manager',   'Cross-project read, schedule and inventory write, HR read.', 0, 0, 1),
  ('project_manager', 'Project Manager',      'Full write on assigned projects, including cost.', 0, 1, 1),
  ('site_supervisor', 'Site Supervisor',      'Assigned projects only. Progress, DPRs, material receipt and issue, labour attendance. Never sees contract value or margin.', 0, 1, 1),
  ('accounts_manager','Accounts Manager',     'All money across all projects. Cannot edit project scope or approve own vouchers.', 1, 0, 1),
  ('hr_manager',      'HR Manager',           'Employees, recruiting, attendance and statutory documents. Payroll figures gated separately.', 0, 0, 1),
  ('sales_exec',      'Sales Executive',      'Own leads plus the unassigned pool. Reads packages and the project gallery.', 0, 0, 1);

-- 60 permissions. module mirrors the 4.3 group headings: auth, admin,
-- projects, inventory, marketing, hr, crm, finance. Labels reuse the spec's
-- own parentheticals where it gives them (reference.manage, grn_create,
-- quote_approve, document_manage, recruit_manage).
INSERT INTO permissions (`key`, module, label) VALUES
  ('users.manage',                    'auth',      'Create, edit and suspend user accounts'),
  ('roles.manage',                    'auth',      'Edit roles, permission grants and approval limits'),
  ('sessions.revoke_others',          'auth',      'Revoke other user sessions'),
  ('audit.view',                      'auth',      'Read the audit log'),
  ('dashboard.view_company_kpi',      'admin',     'View company-wide dashboard KPIs'),
  ('dashboard.view_own_kpi',          'admin',     'View own dashboard KPIs'),
  ('reference.manage',                'admin',     'Manage units, cost heads and stages'),
  ('site_content.manage',             'admin',     'Manage packages, gallery and FAQ'),
  ('enquiries.view',                  'admin',     'View website enquiries'),
  ('projects.view',                   'projects',  'View projects'),
  ('projects.manage',                 'projects',  'Create, edit and close projects'),
  ('projects.view_cost',              'projects',  'View contract values, budgets and margin'),
  ('projects.assign_staff',           'projects',  'Assign staff to projects'),
  ('projects.update_progress',        'projects',  'Update project progress'),
  ('projects.dpr_submit',             'projects',  'Submit daily progress reports'),
  ('projects.quality_signoff',        'projects',  'Sign off quality checks'),
  ('projects.milestone_certify',      'projects',  'Certify payment milestones'),
  ('projects.snag_manage',            'projects',  'Manage snags'),
  ('inventory.view',                  'inventory', 'View inventory'),
  ('inventory.item_manage',           'inventory', 'Manage the item master'),
  ('inventory.grn_create',            'inventory', 'Record goods receipts'),
  ('inventory.issue',                 'inventory', 'Issue materials to projects'),
  ('inventory.transfer',              'inventory', 'Transfer stock between sites'),
  ('inventory.stock_adjust',          'inventory', 'Adjust stock counts'),
  ('inventory.po_create',             'inventory', 'Create purchase orders'),
  ('inventory.approve_po',            'inventory', 'Approve purchase orders'),
  ('inventory.vendor_manage',         'inventory', 'Manage vendors'),
  ('inventory.view_rates',            'inventory', 'View vendor rate cards'),
  ('marketing.view',                  'marketing', 'View the marketing module'),
  ('marketing.campaign_manage',       'marketing', 'Manage campaigns'),
  ('marketing.content_publish',       'marketing', 'Publish website content'),
  ('marketing.spend_record',          'marketing', 'Record marketing spend'),
  ('marketing.analytics_view',        'marketing', 'View marketing analytics'),
  ('hr.employee_view',                'hr',        'View employee records'),
  ('hr.employee_manage',              'hr',        'Create and edit employee records'),
  ('hr.attendance_record',            'hr',        'Record attendance'),
  ('hr.attendance_approve',           'hr',        'Approve attendance'),
  ('hr.leave_approve',                'hr',        'Approve leave requests'),
  ('hr.payroll_view',                 'hr',        'View payroll figures'),
  ('hr.payroll_run',                  'hr',        'Run payroll'),
  ('hr.document_manage',              'hr',        'Manage PF, ESI, ID and licence documents'),
  ('hr.recruit_manage',               'hr',        'Manage job openings and applicants'),
  ('hr.labour_contractor_manage',     'hr',        'Manage labour contractors'),
  ('crm.lead_view',                   'crm',       'View leads'),
  ('crm.lead_manage',                 'crm',       'Create and edit leads'),
  ('crm.lead_assign',                 'crm',       'Assign leads'),
  ('crm.quote_create',                'crm',       'Create quotations'),
  ('crm.quote_approve',               'crm',       'Approve quotations below the approval limit'),
  ('crm.quote_discount_override',     'crm',       'Override quotation discount limits'),
  ('crm.convert_to_project',          'crm',       'Convert won quotations to projects'),
  ('crm.view_pipeline_value',         'crm',       'View pipeline value'),
  ('finance.view_project_budget',     'finance',   'View project budgets'),
  ('finance.budget_set',              'finance',   'Set project budgets'),
  ('finance.expense_create',          'finance',   'Create expenses'),
  ('finance.expense_approve',         'finance',   'Approve expenses'),
  ('finance.payment_record',          'finance',   'Record payments'),
  ('finance.invoice_manage',          'finance',   'Manage invoices'),
  ('finance.view_company_pnl',        'finance',   'View company profit and loss'),
  ('finance.period_close',            'finance',   'Close accounting periods'),
  ('finance.export',                  'finance',   'Export finance data');

-- The 4.3 matrix, joined by key so the seed is independent of
-- AUTO_INCREMENT values. Grant counts: owner 60, admin 14, ops_manager 43,
-- project_manager 28, site_supervisor 10, accounts_manager 26, hr_manager
-- 12, sales_exec 11. Total 204.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.`key` = 'owner';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'users.manage', 'roles.manage', 'sessions.revoke_others', 'audit.view',
    'dashboard.view_own_kpi', 'reference.manage', 'site_content.manage',
    'enquiries.view', 'projects.view', 'projects.assign_staff',
    'marketing.view', 'marketing.content_publish', 'marketing.analytics_view',
    'hr.employee_view'
  )
 WHERE r.`key` = 'admin';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_company_kpi', 'dashboard.view_own_kpi',
    'reference.manage', 'site_content.manage', 'enquiries.view',
    'projects.view', 'projects.manage', 'projects.view_cost',
    'projects.assign_staff', 'projects.update_progress', 'projects.dpr_submit',
    'projects.quality_signoff', 'projects.snag_manage',
    'inventory.view', 'inventory.item_manage', 'inventory.grn_create',
    'inventory.issue', 'inventory.transfer', 'inventory.stock_adjust',
    'inventory.po_create', 'inventory.vendor_manage', 'inventory.view_rates',
    'marketing.view', 'marketing.campaign_manage', 'marketing.content_publish',
    'marketing.spend_record', 'marketing.analytics_view',
    'hr.employee_view', 'hr.attendance_record', 'hr.attendance_approve',
    'hr.leave_approve', 'hr.recruit_manage', 'hr.labour_contractor_manage',
    'crm.lead_view', 'crm.lead_manage', 'crm.lead_assign', 'crm.quote_create',
    'crm.quote_approve', 'crm.convert_to_project', 'crm.view_pipeline_value',
    'finance.view_project_budget', 'finance.expense_create', 'finance.export'
  )
 WHERE r.`key` = 'ops_manager';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'projects.view', 'projects.manage', 'projects.view_cost',
    'projects.assign_staff', 'projects.update_progress', 'projects.dpr_submit',
    'projects.quality_signoff', 'projects.milestone_certify', 'projects.snag_manage',
    'inventory.view', 'inventory.grn_create', 'inventory.issue',
    'inventory.transfer', 'inventory.po_create', 'inventory.view_rates',
    'hr.attendance_record', 'hr.attendance_approve', 'hr.leave_approve',
    'hr.recruit_manage', 'hr.labour_contractor_manage',
    'crm.quote_create',
    'finance.view_project_budget', 'finance.budget_set', 'finance.expense_create',
    'finance.expense_approve', 'finance.invoice_manage', 'finance.export'
  )
 WHERE r.`key` = 'project_manager';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'projects.view', 'projects.update_progress', 'projects.dpr_submit',
    'projects.snag_manage',
    'inventory.view', 'inventory.grn_create', 'inventory.issue',
    'hr.attendance_record',
    'finance.expense_create'
  )
 WHERE r.`key` = 'site_supervisor';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_company_kpi', 'dashboard.view_own_kpi',
    'projects.view', 'projects.view_cost', 'projects.milestone_certify',
    'inventory.view', 'inventory.po_create', 'inventory.approve_po',
    'inventory.vendor_manage', 'inventory.view_rates',
    'marketing.spend_record', 'marketing.analytics_view',
    'hr.payroll_view', 'hr.payroll_run', 'hr.labour_contractor_manage',
    'crm.quote_approve', 'crm.view_pipeline_value',
    'finance.view_project_budget', 'finance.budget_set', 'finance.expense_create',
    'finance.expense_approve', 'finance.payment_record', 'finance.invoice_manage',
    'finance.view_company_pnl', 'finance.period_close', 'finance.export'
  )
 WHERE r.`key` = 'accounts_manager';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'hr.employee_view', 'hr.employee_manage', 'hr.attendance_record',
    'hr.attendance_approve', 'hr.leave_approve', 'hr.payroll_view',
    'hr.payroll_run', 'hr.document_manage', 'hr.recruit_manage',
    'hr.labour_contractor_manage',
    'finance.expense_create'
  )
 WHERE r.`key` = 'hr_manager';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'enquiries.view', 'projects.view',
    'marketing.view', 'marketing.campaign_manage', 'marketing.analytics_view',
    'crm.lead_view', 'crm.lead_manage', 'crm.quote_create', 'crm.view_pipeline_value',
    'finance.expense_create'
  )
 WHERE r.`key` = 'sales_exec';
