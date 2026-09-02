-- 005_inventory.sql
-- Spec 6.4: item master, vendors, requisitions, purchase orders, goods
-- receipts, the append-only stock ledger, issues, transfers, adjustments,
-- consumption norms and equipment.
--
-- The design point of the whole file: stock_ledger is append only and
-- item_stock is a rebuildable cache. Nothing outside postStockMovement
-- writes item_stock (spec 6.4 rule 1).
--
-- consumption_norms is created with NO seeded quantities. Spec 8.4 flags the
-- norms as company-specific and says they must not be guessed, so the table
-- exists and the admin screen fills it. getConsumptionVariance returns
-- "no norm set" rather than a fabricated expectation.
--
-- The item master and approved brands are seeded from the brand list the
-- packages page already publishes, which is a published commitment rather
-- than an invented default.

CREATE TABLE item_categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_itemcat_code (code),
  CONSTRAINT fk_itemcat_parent FOREIGN KEY (parent_id) REFERENCES item_categories (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(24) NOT NULL,
  name VARCHAR(180) NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  unit_id BIGINT UNSIGNED NOT NULL,
  cost_head_id BIGINT UNSIGNED NULL,
  specification VARCHAR(300) NULL,
  hsn_code VARCHAR(10) NULL,
  gst_pct DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  reorder_level DECIMAL(14,3) NULL,
  wastage_allowance_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  shelf_life_days SMALLINT UNSIGNED NULL,      -- cement, chemicals, admixtures
  is_batch_tracked TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_items_code (code),
  KEY idx_items_category (category_id),
  CONSTRAINT fk_items_category FOREIGN KEY (category_id) REFERENCES item_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_unit FOREIGN KEY (unit_id) REFERENCES units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_cost_head FOREIGN KEY (cost_head_id) REFERENCES cost_heads (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE item_brands (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  brand VARCHAR(80) NOT NULL,
  is_approved TINYINT(1) NOT NULL DEFAULT 1,
  approved_by BIGINT UNSIGNED NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_item_brand (item_id, brand),
  CONSTRAINT fk_ib_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT fk_ib_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE vendors (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(180) NOT NULL,
  vendor_type ENUM('material','equipment_hire','subcontractor','service','transport') NOT NULL,
  gstin CHAR(15) NULL,
  pan CHAR(10) NULL,
  msme_udyam_no VARCHAR(20) NULL,
  contact_name VARCHAR(120) NULL,
  phone VARCHAR(20) NULL,
  email VARCHAR(190) NULL,
  address TEXT NULL,
  city VARCHAR(80) NULL,
  payment_terms_days SMALLINT NOT NULL DEFAULT 30,
  bank_account_name VARCHAR(140) NULL,
  bank_account_no VARCHAR(30) NULL,
  bank_ifsc CHAR(11) NULL,
  rating_quality TINYINT NULL,
  rating_timeliness TINYINT NULL,
  status ENUM('active','on_hold','blacklisted') NOT NULL DEFAULT 'active',
  blacklist_reason VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vendors_code (code),
  KEY idx_vendors_status (status),
  CONSTRAINT fk_vendors_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE vendor_item_rates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  vendor_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  rate_paise BIGINT NOT NULL,
  valid_from DATE NOT NULL,
  valid_to DATE NULL,
  freight_included TINYINT(1) NOT NULL DEFAULT 0,
  min_order_qty DECIMAL(14,3) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_vir (item_id, vendor_id, valid_from),
  CONSTRAINT fk_vir_vendor FOREIGN KEY (vendor_id) REFERENCES vendors (id) ON DELETE CASCADE,
  CONSTRAINT fk_vir_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT fk_vir_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE material_requisitions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  req_no VARCHAR(24) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  project_stage_id BIGINT UNSIGNED NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  required_by_date DATE NULL,
  status ENUM('draft','submitted','approved','partially_ordered','ordered','closed','rejected')
    NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  reject_reason VARCHAR(255) NULL,
  remarks VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_req_no (req_no),
  KEY idx_req_project (project_id, status),
  CONSTRAINT fk_req_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_req_stage FOREIGN KEY (project_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL,
  CONSTRAINT fk_req_requester FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_req_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE requisition_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  requisition_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  qty_requested DECIMAL(14,3) NOT NULL,
  qty_approved DECIMAL(14,3) NULL,
  qty_ordered DECIMAL(14,3) NOT NULL DEFAULT 0,
  remarks VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_reql (requisition_id),
  CONSTRAINT fk_reql_req FOREIGN KEY (requisition_id) REFERENCES material_requisitions (id) ON DELETE CASCADE,
  CONSTRAINT fk_reql_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE purchase_orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_no VARCHAR(24) NOT NULL,
  vendor_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- NULL for central store stock
  requisition_id BIGINT UNSIGNED NULL,
  po_date DATE NOT NULL,
  expected_delivery DATE NULL,
  delivery_location_id BIGINT UNSIGNED NOT NULL,
  subtotal_paise BIGINT NOT NULL DEFAULT 0,
  gst_paise BIGINT NOT NULL DEFAULT 0,
  freight_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL DEFAULT 0,
  payment_terms_days SMALLINT NULL,
  advance_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  status ENUM('draft','pending_approval','approved','partially_received',
    'received','short_closed','cancelled') NOT NULL DEFAULT 'draft',
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  second_approved_by BIGINT UNSIGNED NULL,
  second_approved_at DATETIME NULL,
  short_close_reason VARCHAR(255) NULL,
  terms TEXT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_po_no (po_no),
  KEY idx_po_vendor (vendor_id),
  KEY idx_po_status (status),
  CONSTRAINT fk_po_vendor FOREIGN KEY (vendor_id) REFERENCES vendors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_req FOREIGN KEY (requisition_id) REFERENCES material_requisitions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_location FOREIGN KEY (delivery_location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_approver2 FOREIGN KEY (second_approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE po_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  brand VARCHAR(80) NULL,
  qty_ordered DECIMAL(14,3) NOT NULL,
  rate_paise BIGINT NOT NULL,
  gst_pct DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  qty_received DECIMAL(14,3) NOT NULL DEFAULT 0,
  line_total_paise BIGINT NOT NULL DEFAULT 0,
  cost_head_id BIGINT UNSIGNED NULL,
  remarks VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pol (po_id),
  CONSTRAINT fk_pol_po FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_pol_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pol_cost_head FOREIGN KEY (cost_head_id) REFERENCES cost_heads (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE goods_receipts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  grn_no VARCHAR(24) NOT NULL,
  po_id BIGINT UNSIGNED NULL,                  -- NULL allows direct receipt
  vendor_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NULL,
  received_on DATE NOT NULL,
  vehicle_no VARCHAR(20) NULL,
  invoice_no VARCHAR(40) NULL,
  invoice_date DATE NULL,
  invoice_amount_paise BIGINT NULL,
  weighbridge_slip_no VARCHAR(40) NULL,
  gate_entry_no VARCHAR(30) NULL,
  status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  received_by BIGINT UNSIGNED NOT NULL,
  inspected_by BIGINT UNSIGNED NULL,
  expense_id BIGINT UNSIGNED NULL,             -- FK expenses added in 009
  posted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_grn_no (grn_no),
  KEY idx_grn_status (status, received_on),
  CONSTRAINT fk_grn_po FOREIGN KEY (po_id) REFERENCES purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_vendor FOREIGN KEY (vendor_id) REFERENCES vendors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_receiver FOREIGN KEY (received_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_inspector FOREIGN KEY (inspected_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE grn_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  grn_id BIGINT UNSIGNED NOT NULL,
  po_line_id BIGINT UNSIGNED NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  brand VARCHAR(80) NULL,
  qty_challan DECIMAL(14,3) NOT NULL,
  qty_received DECIMAL(14,3) NOT NULL,
  qty_accepted DECIMAL(14,3) NOT NULL,
  qty_rejected DECIMAL(14,3) NOT NULL DEFAULT 0,
  rejection_reason VARCHAR(255) NULL,
  batch_no VARCHAR(40) NULL,
  manufacture_date DATE NULL,
  expiry_date DATE NULL,
  rate_paise BIGINT NOT NULL,
  test_certificate_file_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_grnl (grn_id),
  CONSTRAINT fk_grnl_grn FOREIGN KEY (grn_id) REFERENCES goods_receipts (id) ON DELETE CASCADE,
  CONSTRAINT fk_grnl_poline FOREIGN KEY (po_line_id) REFERENCES po_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grnl_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grnl_cert FOREIGN KEY (test_certificate_file_id) REFERENCES files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE material_issues (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_no VARCHAR(24) NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  project_stage_id BIGINT UNSIGNED NULL,
  issued_on DATE NOT NULL,
  issued_to_type ENUM('own_labour','labour_contractor','subcontractor') NOT NULL DEFAULT 'own_labour',
  labour_contractor_id BIGINT UNSIGNED NULL,   -- FK labour_contractors added in 007
  received_by_name VARCHAR(120) NULL,
  purpose VARCHAR(255) NULL,
  status ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
  issued_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_issue_no (issue_no),
  KEY idx_issue_project (project_id, issued_on),
  CONSTRAINT fk_issue_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_issue_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_issue_stage FOREIGN KEY (project_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL,
  CONSTRAINT fk_issue_user FOREIGN KEY (issued_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE issue_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  qty_issued DECIMAL(14,3) NOT NULL,
  qty_returned DECIMAL(14,3) NOT NULL DEFAULT 0,
  rate_paise BIGINT NULL,
  cost_head_id BIGINT UNSIGNED NULL,
  batch_no VARCHAR(40) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_issl (issue_id),
  CONSTRAINT fk_issl_issue FOREIGN KEY (issue_id) REFERENCES material_issues (id) ON DELETE CASCADE,
  CONSTRAINT fk_issl_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_issl_cost_head FOREIGN KEY (cost_head_id) REFERENCES cost_heads (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_transfers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  transfer_no VARCHAR(24) NOT NULL,
  from_location_id BIGINT UNSIGNED NOT NULL,
  to_location_id BIGINT UNSIGNED NOT NULL,
  dispatched_on DATE NOT NULL,
  received_on DATE NULL,
  vehicle_no VARCHAR(20) NULL,
  status ENUM('in_transit','received','cancelled') NOT NULL DEFAULT 'in_transit',
  dispatched_by BIGINT UNSIGNED NOT NULL,
  received_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_transfer_no (transfer_no),
  KEY idx_transfer_status (status),
  CONSTRAINT fk_trf_from FOREIGN KEY (from_location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_trf_to FOREIGN KEY (to_location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_trf_dispatcher FOREIGN KEY (dispatched_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_trf_receiver FOREIGN KEY (received_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE transfer_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  transfer_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  qty_sent DECIMAL(14,3) NOT NULL,
  qty_received DECIMAL(14,3) NULL,
  shortage_qty DECIMAL(14,3) NULL,
  rate_paise BIGINT NULL,
  batch_no VARCHAR(40) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_trfl (transfer_id),
  CONSTRAINT fk_trfl_transfer FOREIGN KEY (transfer_id) REFERENCES stock_transfers (id) ON DELETE CASCADE,
  CONSTRAINT fk_trfl_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_adjustments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  location_id BIGINT UNSIGNED NOT NULL,
  adjustment_date DATE NOT NULL,
  reason ENUM('physical_count','damage','theft','expiry','wastage','correction') NOT NULL,
  narration VARCHAR(255) NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_adj_location (location_id, adjustment_date),
  CONSTRAINT fk_adj_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_adj_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_adj_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE adjustment_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  adjustment_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  qty_system DECIMAL(14,3) NOT NULL,
  qty_physical DECIMAL(14,3) NOT NULL,
  qty_diff DECIMAL(14,3) NOT NULL,
  rate_paise BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_adjl (adjustment_id),
  CONSTRAINT fk_adjl_adj FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments (id) ON DELETE CASCADE,
  CONSTRAINT fk_adjl_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- APPEND ONLY. The single source of truth for stock (spec 6.4 rule 1).
CREATE TABLE stock_ledger (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  txn_date DATE NOT NULL,
  txn_type ENUM('grn','issue','return','transfer_out','transfer_in','adjustment','opening') NOT NULL,
  ref_table VARCHAR(40) NOT NULL,
  ref_id BIGINT UNSIGNED NOT NULL,
  qty_in DECIMAL(14,3) NOT NULL DEFAULT 0,
  qty_out DECIMAL(14,3) NOT NULL DEFAULT 0,
  rate_paise BIGINT NULL,
  value_paise BIGINT NULL,
  balance_after DECIMAL(14,3) NOT NULL,
  project_id BIGINT UNSIGNED NULL,
  batch_no VARCHAR(40) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ledger_item_loc (item_id, location_id, id),
  KEY idx_ledger_project (project_id, txn_date),
  KEY idx_ledger_ref (ref_table, ref_id),
  CONSTRAINT fk_sl_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sl_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sl_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sl_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CACHE. Rebuildable from stock_ledger by scripts/reconcile-stock.mjs.
CREATE TABLE item_stock (
  item_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  qty_on_hand DECIMAL(14,3) NOT NULL DEFAULT 0,
  value_paise BIGINT NOT NULL DEFAULT 0,
  last_txn_id BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (item_id, location_id),
  CONSTRAINT fk_is_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT fk_is_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Spec 6.4 rule 4 and open question 8.4: the table exists, the quantities do
-- not. getConsumptionVariance reports "no norm set" for an item with no row.
CREATE TABLE consumption_norms (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  project_type ENUM('residential_construction','commercial_construction',
    'industrial_construction','interior_fitout','civil_infrastructure',
    'machine_foundation','renovation','equipment_rental') NOT NULL,
  qty_per_sqft DECIMAL(12,5) NOT NULL,
  note VARCHAR(255) NULL,
  set_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_norm (item_id, project_type),
  CONSTRAINT fk_norm_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT fk_norm_user FOREIGN KEY (set_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE equipment (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(140) NOT NULL,
  equipment_type VARCHAR(80) NOT NULL,
  ownership ENUM('owned','hired') NOT NULL,
  current_location_id BIGINT UNSIGNED NULL,
  current_project_id BIGINT UNSIGNED NULL,
  hire_rate_per_day_paise BIGINT NULL,
  hire_vendor_id BIGINT UNSIGNED NULL,
  next_service_due DATE NULL,
  insurance_valid_until DATE NULL,
  status ENUM('available','deployed','under_repair','retired') NOT NULL DEFAULT 'available',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_equipment_code (code),
  KEY idx_equipment_status (status),
  CONSTRAINT fk_eq_location FOREIGN KEY (current_location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_eq_project FOREIGN KEY (current_project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_eq_vendor FOREIGN KEY (hire_vendor_id) REFERENCES vendors (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE equipment_deployments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  equipment_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NULL,
  meter_start DECIMAL(10,1) NULL,
  meter_end DECIMAL(10,1) NULL,
  operator_name VARCHAR(120) NULL,
  expense_id BIGINT UNSIGNED NULL,             -- FK expenses added in 009
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_eqd_equipment (equipment_id, from_date),
  KEY idx_eqd_project (project_id),
  CONSTRAINT fk_eqd_equipment FOREIGN KEY (equipment_id) REFERENCES equipment (id) ON DELETE CASCADE,
  CONSTRAINT fk_eqd_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_eqd_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: item categories.
INSERT INTO item_categories (code, name, sort_order) VALUES
  ('CEMENT', 'Cement', 10),
  ('STEEL', 'Steel and reinforcement', 20),
  ('AGGREGATE', 'Sand, aggregate and soil', 30),
  ('MASONRY', 'Blocks, bricks and masonry', 40),
  ('TILES', 'Tiles and flooring', 50),
  ('SANITARY', 'Sanitaryware and CP fittings', 60),
  ('ELECTRICAL', 'Electrical materials', 70),
  ('PLUMBING', 'Plumbing materials', 80),
  ('CHEMICALS', 'Chemicals and waterproofing', 90),
  ('PAINT', 'Paints and coatings', 100),
  ('HARDWARE', 'Hardware and consumables', 110),
  ('CARPENTRY', 'Wood, ply and laminates', 120);

-- Seed: item master. Only items the published packages page already names,
-- with the unit and cost head that follow from the item itself.
INSERT INTO items (code, name, category_id, unit_id, cost_head_id, specification, gst_pct, reorder_level, wastage_allowance_pct, shelf_life_days, is_batch_tracked)
SELECT v.code, v.name, c.id, u.id, ch.id, v.spec, v.gst, v.reorder, v.wastage, v.shelf, v.batch
FROM (
  SELECT 'MAT-CEM-OPC53' AS code, 'OPC 53 grade cement' AS name, 'CEMENT' AS cat, 'bag' AS unit, 'MAT-CEM' AS head,
         '53 grade ordinary portland cement, 50 kg bag' AS spec, 28.00 AS gst, 200 AS reorder, 1.00 AS wastage, 90 AS shelf, 1 AS batch
  UNION ALL SELECT 'MAT-CEM-PPC', 'PPC cement', 'CEMENT', 'bag', 'MAT-CEM', 'Portland pozzolana cement, 50 kg bag', 28.00, 100, 1.00, 90, 1
  UNION ALL SELECT 'MAT-STL-FE500D', 'TMT steel Fe500D', 'STEEL', 'MT', 'MAT-STL', 'Fe500D thermo mechanically treated reinforcement bar', 18.00, 2, 3.00, NULL, 1
  UNION ALL SELECT 'MAT-STL-FE550D', 'TMT steel Fe550D', 'STEEL', 'MT', 'MAT-STL', 'Fe550D thermo mechanically treated reinforcement bar', 18.00, 1, 3.00, NULL, 1
  UNION ALL SELECT 'MAT-AGG-MSAND', 'M sand', 'AGGREGATE', 'cum', 'MAT-AGG', 'Manufactured sand for masonry and plaster', 5.00, 20, 5.00, NULL, 0
  UNION ALL SELECT 'MAT-AGG-PSAND', 'P sand', 'AGGREGATE', 'cum', 'MAT-AGG', 'Plastering sand', 5.00, 10, 5.00, NULL, 0
  UNION ALL SELECT 'MAT-AGG-JELLY20', 'Jelly 20 mm', 'AGGREGATE', 'cum', 'MAT-AGG', '20 mm coarse aggregate', 5.00, 20, 3.00, NULL, 0
  UNION ALL SELECT 'MAT-AGG-JELLY12', 'Jelly 12 mm', 'AGGREGATE', 'cum', 'MAT-AGG', '12 mm coarse aggregate', 5.00, 10, 3.00, NULL, 0
  UNION ALL SELECT 'MAT-BLK-SOLID', 'Solid concrete block', 'MASONRY', 'nos', 'MAT-BLK', '8 inch and 6 inch solid concrete block', 18.00, 500, 3.00, NULL, 0
  UNION ALL SELECT 'MAT-BLK-BRICK', 'Table moulded brick', 'MASONRY', 'nos', 'MAT-BLK', 'Second class table moulded clay brick', 5.00, 1000, 5.00, NULL, 0
  UNION ALL SELECT 'MAT-FIN-TILE', 'Vitrified floor tile', 'TILES', 'sqft', 'MAT-FIN', 'Vitrified tile, size and finish per package', 18.00, 200, 5.00, NULL, 0
  UNION ALL SELECT 'MAT-FIN-SANITARY', 'Sanitaryware set', 'SANITARY', 'nos', 'MAT-FIN', 'WC, wash basin and CP fittings', 18.00, NULL, 0.00, NULL, 0
  UNION ALL SELECT 'MAT-ELE-WIRE', 'FR PVC copper wire', 'ELECTRICAL', 'rmt', 'MAT-ELE', 'Flame retardant PVC insulated copper wire', 18.00, 500, 2.00, NULL, 0
  UNION ALL SELECT 'MAT-ELE-SWITCH', 'Modular switch and socket', 'ELECTRICAL', 'nos', 'MAT-ELE', 'Modular switchgear, plate and box', 18.00, 50, 2.00, NULL, 0
  UNION ALL SELECT 'MAT-PLB-CPVC', 'CPVC pipe', 'PLUMBING', 'rmt', 'MAT-PLB', 'CPVC pipe for hot and cold water lines', 18.00, 100, 3.00, NULL, 0
  UNION ALL SELECT 'MAT-PLB-PVC', 'PVC drainage pipe', 'PLUMBING', 'rmt', 'MAT-PLB', 'PVC SWR drainage pipe', 18.00, 100, 3.00, NULL, 0
  UNION ALL SELECT 'MAT-CHM-WPROOF', 'Waterproofing compound', 'CHEMICALS', 'litre', 'MAT-CHM', 'Integral and coating waterproofing chemical', 18.00, 50, 2.00, 365, 1
  UNION ALL SELECT 'MAT-CHM-ADMIX', 'Concrete admixture', 'CHEMICALS', 'litre', 'MAT-CHM', 'Plasticiser and retarder admixture', 18.00, 20, 2.00, 365, 1
  UNION ALL SELECT 'MAT-FIN-PAINT-INT', 'Interior emulsion paint', 'PAINT', 'litre', 'MAT-FIN', 'Interior acrylic emulsion', 18.00, 40, 3.00, 730, 1
  UNION ALL SELECT 'MAT-FIN-PAINT-EXT', 'Exterior emulsion paint', 'PAINT', 'litre', 'MAT-FIN', 'Exterior weatherproof emulsion', 18.00, 40, 3.00, 730, 1
  UNION ALL SELECT 'MAT-FIN-PUTTY', 'Wall putty', 'PAINT', 'kg', 'MAT-FIN', 'White cement based wall putty', 18.00, 100, 5.00, 365, 1
  UNION ALL SELECT 'MAT-HW-BINDWIRE', 'Binding wire', 'HARDWARE', 'kg', 'MAT-STL', 'GI binding wire for reinforcement', 18.00, 50, 2.00, NULL, 0
  UNION ALL SELECT 'MAT-HW-NAILS', 'Nails and fasteners', 'HARDWARE', 'kg', 'MAT-FIN', 'Assorted nails, screws and fasteners', 18.00, 20, 0.00, NULL, 0
  UNION ALL SELECT 'MAT-CAR-PLY', 'Shuttering plywood', 'CARPENTRY', 'nos', 'MAT-FIN', 'Film faced shuttering plywood, 12 mm', 18.00, 20, 10.00, NULL, 0
) AS v
JOIN item_categories c ON c.code = v.cat
JOIN units u ON u.code = v.unit
JOIN cost_heads ch ON ch.code = v.head;

-- Seed: approved brands. These are exactly the brands the packages page
-- publishes, which is what makes spec 6.4 rule 6 enforceable rather than
-- decorative.
INSERT INTO item_brands (item_id, brand, is_approved)
SELECT i.id, v.brand, 1
FROM (
  SELECT 'MAT-CEM-OPC53' AS code, 'UltraTech' AS brand
  UNION ALL SELECT 'MAT-CEM-OPC53', 'ACC'
  UNION ALL SELECT 'MAT-CEM-OPC53', 'Birla Super'
  UNION ALL SELECT 'MAT-CEM-PPC', 'UltraTech'
  UNION ALL SELECT 'MAT-CEM-PPC', 'ACC'
  UNION ALL SELECT 'MAT-CEM-PPC', 'Birla Super'
  UNION ALL SELECT 'MAT-STL-FE500D', 'JSW Neo'
  UNION ALL SELECT 'MAT-STL-FE500D', 'Tata Tiscon'
  UNION ALL SELECT 'MAT-STL-FE500D', 'Indus'
  UNION ALL SELECT 'MAT-STL-FE550D', 'JSW Neo'
  UNION ALL SELECT 'MAT-STL-FE550D', 'Tata Tiscon'
  UNION ALL SELECT 'MAT-STL-FE550D', 'Indus'
  UNION ALL SELECT 'MAT-FIN-TILE', 'Kajaria'
  UNION ALL SELECT 'MAT-FIN-TILE', 'Somany'
  UNION ALL SELECT 'MAT-FIN-SANITARY', 'Jaquar'
  UNION ALL SELECT 'MAT-FIN-SANITARY', 'Hindware'
  UNION ALL SELECT 'MAT-ELE-WIRE', 'Finolex'
  UNION ALL SELECT 'MAT-ELE-SWITCH', 'Havells'
  UNION ALL SELECT 'MAT-ELE-SWITCH', 'Legrand'
  UNION ALL SELECT 'MAT-ELE-SWITCH', 'Anchor'
  UNION ALL SELECT 'MAT-CHM-WPROOF', 'Fosroc'
  UNION ALL SELECT 'MAT-CHM-WPROOF', 'Dr. Fixit'
  UNION ALL SELECT 'MAT-CHM-ADMIX', 'Fosroc'
  UNION ALL SELECT 'MAT-CHM-ADMIX', 'Dr. Fixit'
  UNION ALL SELECT 'MAT-FIN-PAINT-INT', 'Asian Paints'
  UNION ALL SELECT 'MAT-FIN-PAINT-EXT', 'Asian Paints SmartCare'
  UNION ALL SELECT 'MAT-FIN-PUTTY', 'Asian Paints'
) AS v
JOIN items i ON i.code = v.code;
