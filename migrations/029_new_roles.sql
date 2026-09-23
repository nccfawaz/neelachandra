-- 029: four role additions and the missing designation rows (DECISIONS 29.74).
--
-- The 29.63 roster mapping flagged three mismatches: site engineers sitting on
-- site_supervisor, QA/QC/QS on ops_manager, and the architect on sales_exec,
-- plus Karthik (procurement executive) holding the full ops_manager set.
-- Each new role is narrower than the role it replaces and is justified
-- against the 4.3 permission matrix (see DECISIONS 29.74 for the per-grant
-- citations). Idempotent throughout.
--
-- Designations. SITE-ENGR already exists (006_hr.sql); three are missing.
INSERT INTO designations (code, name, department_id)
SELECT v.code, v.name, d.id
FROM (
  SELECT 'QA-QC-QS' AS code, 'QA/QC/QS' AS name, 'SITE' AS dept
  UNION ALL SELECT 'ARCHITECT', 'Architect', 'SITE'
  UNION ALL SELECT 'PROC-EXEC', 'Procurement Executive', 'PROC'
) AS v
JOIN departments d ON d.code = v.dept
WHERE NOT EXISTS (SELECT 1 FROM designations dn WHERE dn.code = v.code);

-- Roles. scope_to_assigned_projects and require_2fa follow the pattern of
-- the site-level roles (002_rbac.sql). None of the four touch money
-- approvals, so none carries the segregation-of-duties load.
INSERT INTO roles (`key`, label, description, require_2fa, scope_to_assigned_projects, is_system)
SELECT * FROM (
  SELECT
    'site_engineer' AS `key`,
    'Site Engineer' AS label,
    'Assigned projects only. Progress, DPRs, material receipt and issue, attendance. No snag ownership, no expenses, never sees contract value or margin.' AS description,
    0 AS require_2fa,
    1 AS scope_to_assigned_projects,
    1 AS is_system
  UNION ALL SELECT
    'qa_qc',
    'QA/QC/QS',
    'Assigned projects only. Quality sign-off, snags, quality checks and cube tests. Independent of the people whose work is checked.',
    0, 1, 1
  UNION ALL SELECT
    'architect',
    'Architect',
    'Assigned projects only. Reads drawings, schedule and material list. Raises no expenses, approves nothing, sees no money.',
    0, 1, 1
  UNION ALL SELECT
    'procurement_executive',
    'Procurement Executive',
    'Raises purchase orders and material requisitions under the procurement lead. Reads vendor rates. Approves nothing.',
    0, 0, 1
) AS v
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.`key` = v.`key`);

-- Grants. Each block cites its justification; DECISIONS 29.74 records the
-- mapping back to the spec's 4.3 matrix.

-- site_engineer: the eight-grant set proposed in 29.73, derived from the
-- site_supervisor row by dropping projects.snag_manage and
-- finance.expense_create. The 4.3 matrix is the source: supervisor holds
-- W+S on both, but snags are QA/QS's domain once a qa_qc role exists, and
-- a site engineer does not raise expenses (matrix row finance.expense_create
-- grants only supervisor and above on the site side).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'projects.view',
    'projects.update_progress',
    'projects.dpr_submit',
    'inventory.view',
    'inventory.grn_create',
    'inventory.issue',
    'hr.attendance_record'
  )
 WHERE r.`key` = 'site_engineer'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- qa_qc: quality is its own accountability. projects.quality_signoff is
-- granted because spec 6.3 rule 3 makes certification conditional on a
-- recorded pass ("Milestone certification is gated on quality, not on
-- someone clicking done"), and snags are the QA/QS defect channel
-- (matrix: snag_manage W+S on the site side). inventory.view so they can
-- see material at the gate when checking a pour. No money, no approvals
-- outside quality, no HR.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'projects.view',
    'projects.quality_signoff',
    'projects.snag_manage',
    'inventory.view',
    'hr.attendance_record'
  )
 WHERE r.`key` = 'qa_qc'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- architect: the read-only site view. projects.view and inventory.view
-- (matrix: supervisor-level R+S reads), attendance_record because the
-- architect is site staff whose presence is recorded. Nothing else: the
-- matrix grants architects nothing explicitly, so the role defaults to
-- read-and-record.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'projects.view',
    'inventory.view',
    'hr.attendance_record'
  )
 WHERE r.`key` = 'architect'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- procurement_executive: raises POs but approves nothing. The
-- segregation-of-duties rule (4.2: "approvePurchaseOrder() ... the same
-- guard applies") needs the raiser and the approver to be different
-- people: inventory.po_create W on the ops side of the matrix, view_rates
-- R so a PO can be checked against the last rate (spec: vendor_item_rates
-- exists "so a PO can be checked against the last rate"), inventory.view
-- and grn_create to see stock state. No approve_po, no vendor_manage, no
-- money.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.`key` IN (
    'dashboard.view_own_kpi',
    'inventory.view',
    'inventory.po_create',
    'inventory.grn_create',
    'inventory.view_rates'
  )
 WHERE r.`key` = 'procurement_executive'
   AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);
