-- 009_finance.sql
-- Spec 6.8: accounting periods, project budgets, the single expenses
-- document, payments with allocations, bank accounts and client invoices.
--
-- Two structural points from the spec:
--
--   expenses is the one actual-cost document whatever its origin, and
--   source_type plus source_table and source_id are what stop a GRN, a
--   contractor bill and a campaign spend being counted twice.
--
--   payment_allocations exists so one payment settling three vendor bills,
--   or three payments settling one bill, reconciles. A direct
--   payment-to-document column cannot express either case.
--
-- The forward foreign keys the earlier migrations deferred are added at the
-- end of this file: goods_receipts.expense_id, equipment_deployments
-- .expense_id, contractor_bills.expense_id, campaign_spend.expense_id and
-- project_milestones.invoice_id.

CREATE TABLE accounting_periods (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  financial_year CHAR(7) NOT NULL,
  month TINYINT UNSIGNED NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status ENUM('open','soft_closed','closed') NOT NULL DEFAULT 'open',
  closed_by BIGINT UNSIGNED NULL,
  closed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_period (financial_year, month),
  KEY idx_period_dates (period_start, period_end),
  CONSTRAINT fk_period_closer FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bank_accounts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_name VARCHAR(140) NOT NULL,
  bank_name VARCHAR(120) NOT NULL,
  account_no_last4 CHAR(4) NULL,               -- full account number not stored
  ifsc CHAR(11) NULL,
  account_type ENUM('current','savings','od','cc') NOT NULL DEFAULT 'current',
  opening_balance_paise BIGINT NOT NULL DEFAULT 0,
  opening_date DATE NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_budgets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  version TINYINT UNSIGNED NOT NULL DEFAULT 1,
  budget_type ENUM('original','revised','forecast') NOT NULL DEFAULT 'original',
  total_paise BIGINT NOT NULL DEFAULT 0,
  contingency_pct DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  target_margin_pct DECIMAL(5,2) NULL,         -- gated, owner and accounts only
  prepared_by BIGINT UNSIGNED NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  revision_reason VARCHAR(300) NULL,
  status ENUM('draft','approved','superseded') NOT NULL DEFAULT 'draft',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_budget (project_id, version),
  CONSTRAINT fk_budget_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_budget_preparer FOREIGN KEY (prepared_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_budget_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE budget_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  budget_id BIGINT UNSIGNED NOT NULL,
  cost_head_id BIGINT UNSIGNED NOT NULL,
  project_stage_id BIGINT UNSIGNED NULL,
  description VARCHAR(200) NULL,
  qty DECIMAL(14,3) NULL,
  unit_id BIGINT UNSIGNED NULL,
  rate_paise BIGINT NULL,
  amount_paise BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_bl (budget_id, cost_head_id),
  CONSTRAINT fk_bl_budget FOREIGN KEY (budget_id) REFERENCES project_budgets (id) ON DELETE CASCADE,
  CONSTRAINT fk_bl_cost_head FOREIGN KEY (cost_head_id) REFERENCES cost_heads (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bl_stage FOREIGN KEY (project_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL,
  CONSTRAINT fk_bl_unit FOREIGN KEY (unit_id) REFERENCES units (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE expenses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  expense_no VARCHAR(24) NOT NULL,
  expense_date DATE NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- NULL is company overhead
  expense_type ENUM('material_purchase','labour_contractor','subcontract',
    'equipment_hire','equipment_fuel','transport','statutory_fee','professional_fee',
    'salary','site_overhead','office_overhead','marketing','travel',
    'utilities','repair_maintenance','insurance','interest','other') NOT NULL,
  payee_type ENUM('vendor','contractor','employee','authority','other') NOT NULL,
  vendor_id BIGINT UNSIGNED NULL,
  contractor_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NULL,
  payee_name VARCHAR(180) NULL,
  source_type ENUM('manual','grn','contractor_bill','equipment_deployment',
    'campaign_spend','payroll') NOT NULL DEFAULT 'manual',
  source_table VARCHAR(40) NULL,
  source_id BIGINT UNSIGNED NULL,
  bill_no VARCHAR(60) NULL,
  bill_date DATE NULL,
  taxable_paise BIGINT NOT NULL DEFAULT 0,
  cgst_paise BIGINT NOT NULL DEFAULT 0,
  sgst_paise BIGINT NOT NULL DEFAULT 0,
  igst_paise BIGINT NOT NULL DEFAULT 0,
  tds_section VARCHAR(10) NULL,
  tds_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  tds_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL DEFAULT 0,
  net_payable_paise BIGINT NOT NULL DEFAULT 0,
  paid_paise BIGINT NOT NULL DEFAULT 0,
  is_reimbursable TINYINT(1) NOT NULL DEFAULT 0,
  advance_settlement_of BIGINT UNSIGNED NULL,
  status ENUM('draft','pending_approval','approved','rejected','part_paid','paid','void')
    NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  second_approved_by BIGINT UNSIGNED NULL,
  second_approved_at DATETIME NULL,
  rejected_reason VARCHAR(300) NULL,
  voided_at DATETIME NULL,
  voided_by BIGINT UNSIGNED NULL,
  void_reason VARCHAR(300) NULL,
  period_id BIGINT UNSIGNED NULL,
  narration VARCHAR(500) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_expense_no (expense_no),
  KEY idx_exp_project (project_id, status),
  KEY idx_exp_date (expense_date),
  KEY idx_exp_source (source_table, source_id),
  KEY idx_exp_status (status),
  CONSTRAINT fk_exp_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_vendor FOREIGN KEY (vendor_id) REFERENCES vendors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_contractor FOREIGN KEY (contractor_id) REFERENCES labour_contractors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_advance FOREIGN KEY (advance_settlement_of) REFERENCES expenses (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_approver2 FOREIGN KEY (second_approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_voider FOREIGN KEY (voided_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_period FOREIGN KEY (period_id) REFERENCES accounting_periods (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE expense_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  expense_id BIGINT UNSIGNED NOT NULL,
  cost_head_id BIGINT UNSIGNED NOT NULL,
  project_stage_id BIGINT UNSIGNED NULL,
  item_id BIGINT UNSIGNED NULL,
  description VARCHAR(300) NULL,
  qty DECIMAL(14,3) NULL,
  rate_paise BIGINT NULL,
  amount_paise BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_el (expense_id),
  CONSTRAINT fk_el_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_el_cost_head FOREIGN KEY (cost_head_id) REFERENCES cost_heads (id) ON DELETE RESTRICT,
  CONSTRAINT fk_el_stage FOREIGN KEY (project_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL,
  CONSTRAINT fk_el_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE expense_attachments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  expense_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('bill','receipt','measurement_sheet','photo','approval_mail','other')
    NOT NULL DEFAULT 'bill',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ea (expense_id),
  CONSTRAINT fk_ea_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_ea_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_invoices (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_no VARCHAR(24) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  invoice_type ENUM('advance','milestone','running_account','extra_work','final','retention_release')
    NOT NULL DEFAULT 'milestone',
  milestone_id BIGINT UNSIGNED NULL,
  work_done_pct DECIMAL(5,2) NULL,
  taxable_paise BIGINT NOT NULL DEFAULT 0,
  cgst_paise BIGINT NOT NULL DEFAULT 0,
  sgst_paise BIGINT NOT NULL DEFAULT 0,
  gst_pct DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  total_paise BIGINT NOT NULL DEFAULT 0,
  retention_paise BIGINT NOT NULL DEFAULT 0,
  advance_adjusted_paise BIGINT NOT NULL DEFAULT 0,
  tds_deducted_by_client_paise BIGINT NOT NULL DEFAULT 0,
  net_receivable_paise BIGINT NOT NULL DEFAULT 0,
  received_paise BIGINT NOT NULL DEFAULT 0,
  status ENUM('draft','sent','part_paid','paid','overdue','disputed','cancelled')
    NOT NULL DEFAULT 'draft',
  sent_at DATETIME NULL,
  narration VARCHAR(500) NULL,
  period_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invoice_no (invoice_no),
  KEY idx_inv_project (project_id, status),
  KEY idx_inv_client (client_id, status),
  KEY idx_inv_due (due_date),
  CONSTRAINT fk_inv_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inv_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inv_milestone FOREIGN KEY (milestone_id) REFERENCES project_milestones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inv_period FOREIGN KEY (period_id) REFERENCES accounting_periods (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inv_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invoice_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_id BIGINT UNSIGNED NOT NULL,
  description VARCHAR(300) NOT NULL,
  qty DECIMAL(14,3) NULL,
  unit_id BIGINT UNSIGNED NULL,
  rate_paise BIGINT NULL,
  amount_paise BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_invl (invoice_id, sort_order),
  CONSTRAINT fk_invl_invoice FOREIGN KEY (invoice_id) REFERENCES client_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_invl_unit FOREIGN KEY (unit_id) REFERENCES units (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payment_no VARCHAR(24) NOT NULL,
  payment_date DATE NOT NULL,
  direction ENUM('outgoing','incoming') NOT NULL,
  mode ENUM('bank_transfer','neft','rtgs','imps','upi','cheque','cash','card','adjustment')
    NOT NULL DEFAULT 'bank_transfer',
  bank_account_id BIGINT UNSIGNED NULL,
  reference_no VARCHAR(60) NULL,
  amount_paise BIGINT NOT NULL,
  payee_or_payer VARCHAR(180) NOT NULL,
  vendor_id BIGINT UNSIGNED NULL,
  contractor_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NULL,
  client_id BIGINT UNSIGNED NULL,
  project_id BIGINT UNSIGNED NULL,
  status ENUM('recorded','cleared','bounced','cancelled') NOT NULL DEFAULT 'recorded',
  cleared_on DATE NULL,
  bounce_reason VARCHAR(200) NULL,
  narration VARCHAR(300) NULL,
  period_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment_no (payment_no),
  KEY idx_pay_date (payment_date),
  KEY idx_pay_project (project_id),
  CONSTRAINT fk_pay_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pay_vendor FOREIGN KEY (vendor_id) REFERENCES vendors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pay_contractor FOREIGN KEY (contractor_id) REFERENCES labour_contractors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pay_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pay_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pay_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pay_period FOREIGN KEY (period_id) REFERENCES accounting_periods (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pay_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_allocations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payment_id BIGINT UNSIGNED NOT NULL,
  document_type ENUM('expense','contractor_bill','client_invoice','advance') NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  allocated_paise BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_alloc (payment_id, document_type, document_id),
  KEY idx_alloc_doc (document_type, document_id),
  CONSTRAINT fk_alloc_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The forward references the earlier migrations deferred.
ALTER TABLE goods_receipts
  ADD CONSTRAINT fk_grn_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE RESTRICT;

ALTER TABLE equipment_deployments
  ADD CONSTRAINT fk_eqd_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE RESTRICT;

ALTER TABLE contractor_bills
  ADD CONSTRAINT fk_cb_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE RESTRICT;

ALTER TABLE campaign_spend
  ADD CONSTRAINT fk_spend_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE RESTRICT;

ALTER TABLE project_milestones
  ADD CONSTRAINT fk_ms_invoice FOREIGN KEY (invoice_id) REFERENCES client_invoices (id) ON DELETE RESTRICT;

-- Seed: the twelve accounting periods of the current Indian financial year,
-- April to March. The year is computed rather than hardcoded so applying
-- this migration in a later FY produces that FY's periods.
INSERT INTO accounting_periods (financial_year, month, period_start, period_end, status)
SELECT
  CONCAT(fy_start, '-', LPAD(MOD(fy_start + 1, 100), 2, '0')) AS financial_year,
  m.month,
  DATE(CONCAT(IF(m.month >= 4, fy_start, fy_start + 1), '-', LPAD(m.month, 2, '0'), '-01')) AS period_start,
  LAST_DAY(DATE(CONCAT(IF(m.month >= 4, fy_start, fy_start + 1), '-', LPAD(m.month, 2, '0'), '-01'))) AS period_end,
  'open'
FROM (SELECT IF(MONTH(CURDATE()) >= 4, YEAR(CURDATE()), YEAR(CURDATE()) - 1) AS fy_start) AS fy
CROSS JOIN (
  SELECT 4 AS month UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7
  UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11
  UNION ALL SELECT 12 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
) AS m;
