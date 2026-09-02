-- 003_reference.sql
-- Spec 6.2: the reference tables the admin dashboard owns, plus the two
-- cross-module tables every later migration has a foreign key into.
--
-- Ordering note: files and locations are declared here rather than in the
-- module that first uses them. files is named in 6.3 as "shared by every
-- module" and locations is written by the project lifecycle in 6.4 rule 9,
-- so both must exist before 004. Putting them in a module migration would
-- make 004 depend on 005 and vice versa.
--
-- settings values are seeded from what the PHP currently hardcodes, per the
-- 6.2 comment. Nothing here invents a business figure: gst_default_pct is
-- the 18 percent already printed on the packages page, retention 5 percent
-- and TDS 2 percent under 194C are the values the spec's own DDL defaults
-- use. approval limits stay empty, they are open question 8.2.

CREATE TABLE files (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  storage_path VARCHAR(300) NOT NULL,          -- relative to UPLOAD_PRIVATE_DIR
  original_name VARCHAR(255) NOT NULL,
  mime VARCHAR(120) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  visibility ENUM('private','public') NOT NULL DEFAULT 'private',
  uploaded_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_files_sha (sha256),
  CONSTRAINT fk_files_user FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stock locations. central_store and transit are seeded; one row per project
-- is created by the projects service when a project reaches mobilising
-- (spec 6.4 rule 9). transit exists because transfers are two-step (rule 5)
-- and material in a lorry is neither at the source nor the destination.
CREATE TABLE locations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(24) NOT NULL,
  name VARCHAR(140) NOT NULL,
  location_type ENUM('central_store','site_store','transit','office') NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- FK projects added in 004
  address TEXT NULL,
  city VARCHAR(80) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_locations_code (code),
  KEY idx_locations_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  key_name VARCHAR(80) NOT NULL,
  value_json JSON NOT NULL,
  data_type ENUM('string','int','money','bool','json') NOT NULL DEFAULT 'string',
  is_secret TINYINT(1) NOT NULL DEFAULT 0,
  label VARCHAR(160) NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_settings_key (key_name),
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE document_numbering (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doc_type ENUM('project','quote','po','grn','expense','invoice','payment',
    'issue','requisition','transfer','lead','contractor_bill') NOT NULL,
  prefix VARCHAR(12) NOT NULL,
  fy_reset TINYINT(1) NOT NULL DEFAULT 1,
  financial_year CHAR(7) NOT NULL,
  last_number INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_numbering (doc_type, financial_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE cost_heads (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  parent_id BIGINT UNSIGNED NULL,              -- one level of nesting only
  head_type ENUM('material','labour','subcontract','equipment','statutory','overhead') NOT NULL,
  is_direct_cost TINYINT(1) NOT NULL DEFAULT 1,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cost_heads_code (code),
  KEY idx_cost_heads_parent (parent_id),
  CONSTRAINT fk_cost_heads_parent FOREIGN KEY (parent_id) REFERENCES cost_heads (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE units (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(40) NOT NULL,
  decimal_places TINYINT NOT NULL DEFAULT 2,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_units_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(60) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NULL,
  link_path VARCHAR(255) NULL,
  severity ENUM('info','warn','critical') NOT NULL DEFAULT 'info',
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif_user_unread (user_id, read_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Spec 6.5 rule 1: the contact form's destination. Phase 1 emails and drops;
-- this table is where an enquiry lands so the admin enquiry list and the
-- phase 5 promote-to-lead action have a row to work from.
CREATE TABLE enquiries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(140) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(190) NULL,
  city VARCHAR(80) NULL,
  service_interest VARCHAR(120) NULL,
  message TEXT NULL,
  source_page VARCHAR(200) NULL,               -- which public URL it came from
  utm_source VARCHAR(60) NULL,
  utm_medium VARCHAR(60) NULL,
  utm_campaign VARCHAR(80) NULL,
  ip VARBINARY(16) NULL,
  user_agent VARCHAR(255) NULL,
  status ENUM('new','contacted','promoted','spam','closed') NOT NULL DEFAULT 'new',
  handled_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_enquiries_status (status, created_at),
  CONSTRAINT fk_enquiries_user FOREIGN KEY (handled_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Spec 6.2: company KPI numbers are read from a nightly snapshot, not
-- computed live on a cold process.
CREATE TABLE dashboard_daily_snapshot (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  metric_key VARCHAR(60) NOT NULL,
  metric_value_paise BIGINT NULL,
  metric_value_count INT NULL,
  detail_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_snapshot (snapshot_date, metric_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: units named in spec 6.2.
INSERT INTO units (code, name, decimal_places) VALUES
  ('bag', 'Bag', 0),
  ('MT', 'Metric tonne', 3),
  ('kg', 'Kilogram', 2),
  ('cum', 'Cubic metre', 3),
  ('sqft', 'Square foot', 2),
  ('sqm', 'Square metre', 2),
  ('rmt', 'Running metre', 2),
  ('nos', 'Numbers', 0),
  ('litre', 'Litre', 2),
  ('day', 'Day', 1),
  ('trip', 'Trip', 0);

-- Seed: cost heads. Two levels, parents first so the self FK resolves.
INSERT INTO cost_heads (code, name, parent_id, head_type, is_direct_cost, sort_order) VALUES
  ('MAT', 'Material', NULL, 'material', 1, 10),
  ('LAB', 'Labour', NULL, 'labour', 1, 20),
  ('SUB', 'Subcontract', NULL, 'subcontract', 1, 30),
  ('EQP', 'Equipment', NULL, 'equipment', 1, 40),
  ('STA', 'Statutory and approvals', NULL, 'statutory', 1, 50),
  ('OVH', 'Overhead', NULL, 'overhead', 0, 60);

INSERT INTO cost_heads (code, name, parent_id, head_type, is_direct_cost, sort_order)
SELECT v.code, v.name, p.id, v.head_type, v.is_direct_cost, v.sort_order
FROM (
  SELECT 'MAT-CEM' AS code, 'Cement' AS name, 'MAT' AS parent_code, 'material' AS head_type, 1 AS is_direct_cost, 11 AS sort_order
  UNION ALL SELECT 'MAT-STL', 'Steel', 'MAT', 'material', 1, 12
  UNION ALL SELECT 'MAT-AGG', 'Sand and aggregate', 'MAT', 'material', 1, 13
  UNION ALL SELECT 'MAT-BLK', 'Blocks and bricks', 'MAT', 'material', 1, 14
  UNION ALL SELECT 'MAT-FIN', 'Finishing materials', 'MAT', 'material', 1, 15
  UNION ALL SELECT 'MAT-ELE', 'Electrical materials', 'MAT', 'material', 1, 16
  UNION ALL SELECT 'MAT-PLB', 'Plumbing materials', 'MAT', 'material', 1, 17
  UNION ALL SELECT 'MAT-CHM', 'Chemicals and waterproofing', 'MAT', 'material', 1, 18
  UNION ALL SELECT 'LAB-OWN', 'Own labour', 'LAB', 'labour', 1, 21
  UNION ALL SELECT 'LAB-CON', 'Contract labour', 'LAB', 'labour', 1, 22
  UNION ALL SELECT 'EQP-HIR', 'Equipment hire', 'EQP', 'equipment', 1, 41
  UNION ALL SELECT 'EQP-FUL', 'Fuel and lubricants', 'EQP', 'equipment', 1, 42
  UNION ALL SELECT 'STA-APP', 'Authority approval fees', 'STA', 'statutory', 1, 51
  UNION ALL SELECT 'OVH-OFF', 'Office overhead', 'OVH', 'overhead', 0, 61
  UNION ALL SELECT 'OVH-MKT', 'Marketing', 'OVH', 'overhead', 0, 62
  UNION ALL SELECT 'OVH-SAL', 'Salaries', 'OVH', 'overhead', 0, 63
) AS v
JOIN cost_heads p ON p.code = v.parent_code;

-- Seed: the two permanent stock locations. Project stores are created by the
-- projects service, not here.
INSERT INTO locations (code, name, location_type, city, is_active) VALUES
  ('STORE-CENTRAL', 'Central store', 'central_store', 'Bengaluru', 1),
  ('TRANSIT', 'In transit', 'transit', NULL, 1),
  ('OFFICE-HO', 'Head office', 'office', 'Bengaluru', 1);

-- Seed: settings. Values are the ones already published on the live site or
-- already defaulted in the spec DDL. Nothing invented.
INSERT INTO settings (key_name, value_json, data_type, is_secret, label) VALUES
  ('company.legal_name', JSON_QUOTE('Neelachandra Construction and Interiors'), 'string', 0, 'Company legal name'),
  ('company.gstin', JSON_QUOTE(''), 'string', 0, 'Company GSTIN'),
  ('company.address_line', JSON_QUOTE('Bengaluru, Karnataka, India'), 'string', 0, 'Company address'),
  ('company.phone_primary', JSON_QUOTE('+91 78292 92929'), 'string', 0, 'Primary phone'),
  ('company.email_enquiry', JSON_QUOTE('nccpmd@gmail.com'), 'string', 0, 'Enquiry destination email'),
  ('company.whatsapp', JSON_QUOTE('+91 78292 92929'), 'string', 0, 'WhatsApp number'),
  ('finance.gst_default_pct', '18.00', 'string', 0, 'Default GST percent'),
  ('finance.tds_default_pct', '2.00', 'string', 0, 'Default TDS percent, section 194C'),
  ('finance.retention_default_pct', '5.00', 'string', 0, 'Default retention percent'),
  ('projects.default_stage_template_id', 'null', 'int', 0, 'Default stage template'),
  ('numbering.project_prefix', JSON_QUOTE('NCC/PRJ'), 'string', 0, 'Project number prefix'),
  ('numbering.quote_prefix', JSON_QUOTE('NCC/QT'), 'string', 0, 'Quote number prefix'),
  ('numbering.po_prefix', JSON_QUOTE('NCC/PO'), 'string', 0, 'Purchase order number prefix'),
  ('numbering.grn_prefix', JSON_QUOTE('NCC/GRN'), 'string', 0, 'Goods receipt number prefix'),
  ('numbering.expense_prefix', JSON_QUOTE('NCC/EXP'), 'string', 0, 'Expense voucher number prefix'),
  ('numbering.invoice_prefix', JSON_QUOTE('NCC/INV'), 'string', 0, 'Client invoice number prefix'),
  ('numbering.payment_prefix', JSON_QUOTE('NCC/PAY'), 'string', 0, 'Payment voucher number prefix'),
  ('numbering.issue_prefix', JSON_QUOTE('NCC/ISS'), 'string', 0, 'Material issue number prefix'),
  ('numbering.requisition_prefix', JSON_QUOTE('NCC/REQ'), 'string', 0, 'Requisition number prefix'),
  ('numbering.transfer_prefix', JSON_QUOTE('NCC/TRF'), 'string', 0, 'Stock transfer number prefix'),
  ('numbering.lead_prefix', JSON_QUOTE('NCC/LD'), 'string', 0, 'Lead number prefix'),
  ('numbering.contractor_bill_prefix', JSON_QUOTE('NCC/CB'), 'string', 0, 'Contractor bill number prefix');
