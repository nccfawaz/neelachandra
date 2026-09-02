-- 004_projects.sql
-- Spec 6.3: the projects tracker. clients, projects, assignments, stage
-- templates and instances, payment milestones, DPRs, quality checks, snags,
-- statutory approvals and project documents.
--
-- Notes on decisions the spec leaves to the migration:
--
--   projects.package_id has no FK yet. site_packages arrives in 008_marketing
--   and adding the constraint there keeps this file self-contained.
--
--   project_milestones.invoice_id has no FK yet, client_invoices arrives in
--   009_finance, per the spec's own "set in phase 7" comment.
--
--   daily_progress_reports.labour_contractor_id has no FK yet, per the spec's
--   "FK labour_contractors, phase 6" comment.
--
--   locations.project_id gains its FK here, now that projects exists. This is
--   the reason locations sits in 003 rather than in 005.
--
--   Stage templates are seeded from the four published process steps on
--   index.php and the milestone structure published on the packages page.
--   Weightages sum to exactly 100.00 per template because createProject
--   throws otherwise (spec 6.3 rule 1). The specific split across stages is
--   a company operating figure, so the seeded template is marked
--   is_default = 0 for the industrial variant and the residential one is
--   flagged default only because a project cannot be created without one.
--   Both are editable in the admin reference screens.

CREATE TABLE clients (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(180) NOT NULL,
  client_type ENUM('individual','company','institution','government') NOT NULL,
  sector VARCHAR(80) NULL,
  gstin CHAR(15) NULL,
  pan CHAR(10) NULL,
  billing_address TEXT NULL,
  city VARCHAR(80) NULL,
  state VARCHAR(80) NOT NULL DEFAULT 'Karnataka',
  primary_contact_name VARCHAR(120) NULL,
  primary_contact_phone VARCHAR(20) NULL,
  primary_contact_email VARCHAR(190) NULL,
  status ENUM('active','dormant','blacklisted') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_clients_code (code),
  KEY idx_clients_status (status),
  CONSTRAINT fk_clients_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_clients_updated FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stage_templates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  project_type ENUM('residential_construction','commercial_construction',
    'industrial_construction','interior_fitout','civil_infrastructure',
    'machine_foundation','renovation','equipment_rental') NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tpl_type (project_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stage_template_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT UNSIGNED NOT NULL,
  seq SMALLINT NOT NULL,
  name VARCHAR(140) NOT NULL,
  weightage_pct DECIMAL(5,2) NOT NULL,
  typical_duration_days SMALLINT NULL,
  requires_quality_check TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tpl_seq (template_id, seq),
  CONSTRAINT fk_tpli_template FOREIGN KEY (template_id) REFERENCES stage_templates (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE projects (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(24) NOT NULL,
  name VARCHAR(200) NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  project_type ENUM('residential_construction','commercial_construction',
    'industrial_construction','interior_fitout','civil_infrastructure',
    'machine_foundation','renovation','equipment_rental') NOT NULL,
  delivery_model ENUM('package_per_sqft','item_rate','lumpsum','cost_plus','labour_only') NOT NULL,
  package_id BIGINT UNSIGNED NULL,             -- FK site_packages added in 008
  stage_template_id BIGINT UNSIGNED NULL,
  built_up_area_sqft DECIMAL(12,2) NULL,
  plot_area_sqft DECIMAL(12,2) NULL,
  floors_count TINYINT UNSIGNED NULL,
  site_address TEXT NOT NULL,
  city VARCHAR(80) NOT NULL,
  survey_number VARCHAR(60) NULL,
  geo_lat DECIMAL(10,7) NULL,
  geo_lng DECIMAL(10,7) NULL,
  jurisdiction ENUM('BBMP','BMRDA','BDA','Gram Panchayat','TUDA','KIADB','Other') NULL,
  scope_of_work TEXT NULL,
  compliance_standards VARCHAR(255) NULL,
  contract_value_paise BIGINT NULL,            -- gated by projects.view_cost
  contract_signed_on DATE NULL,
  rate_per_sqft_paise BIGINT NULL,             -- gated
  retention_pct DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  gst_pct DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  planned_start DATE NULL,
  planned_end DATE NULL,
  actual_start DATE NULL,
  actual_end DATE NULL,
  status ENUM('prospect','mobilising','in_progress','on_hold','snagging',
    'handed_over','defect_liability','closed','cancelled') NOT NULL DEFAULT 'mobilising',
  hold_reason VARCHAR(255) NULL,
  physical_progress_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  warranty_structural_until DATE NULL,
  warranty_general_until DATE NULL,
  is_public_showcase TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_projects_code (code),
  KEY idx_projects_status (status),
  KEY idx_projects_client (client_id),
  CONSTRAINT fk_projects_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_projects_template FOREIGN KEY (stage_template_id) REFERENCES stage_templates (id) ON DELETE RESTRICT,
  CONSTRAINT fk_projects_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_projects_updated FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE locations
  ADD CONSTRAINT fk_locations_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT;

CREATE TABLE project_assignments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  assignment_role ENUM('pm','supervisor','qs','accounts','observer') NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_assignment (project_id, user_id, assignment_role),
  KEY idx_assign_user (user_id),
  CONSTRAINT fk_assign_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_assign_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_assign_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_stages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  seq SMALLINT NOT NULL,
  name VARCHAR(140) NOT NULL,
  weightage_pct DECIMAL(5,2) NOT NULL,
  planned_start DATE NULL,
  planned_end DATE NULL,
  actual_start DATE NULL,
  actual_end DATE NULL,
  progress_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  status ENUM('not_started','in_progress','blocked','complete') NOT NULL DEFAULT 'not_started',
  blocked_reason VARCHAR(255) NULL,
  requires_quality_check TINYINT(1) NOT NULL DEFAULT 0,
  predecessor_stage_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_seq (project_id, seq),
  CONSTRAINT fk_stage_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_stage_predecessor FOREIGN KEY (predecessor_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_milestones (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  seq SMALLINT NOT NULL,
  name VARCHAR(160) NOT NULL,
  trigger_stage_id BIGINT UNSIGNED NULL,
  percent_of_contract DECIMAL(5,2) NULL,
  amount_paise BIGINT NULL,                    -- gated
  due_basis ENUM('on_stage_complete','on_date','on_certification') NOT NULL DEFAULT 'on_stage_complete',
  due_date DATE NULL,
  status ENUM('pending','ready_to_certify','certified','invoiced','part_paid','paid','waived')
    NOT NULL DEFAULT 'pending',
  certified_by BIGINT UNSIGNED NULL,
  certified_on DATE NULL,
  invoice_id BIGINT UNSIGNED NULL,             -- FK client_invoices added in 009
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ms_project_seq (project_id, seq),
  KEY idx_ms_project_status (project_id, status),
  CONSTRAINT fk_ms_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_ms_stage FOREIGN KEY (trigger_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL,
  CONSTRAINT fk_ms_certifier FOREIGN KEY (certified_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE daily_progress_reports (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  report_date DATE NOT NULL,
  weather ENUM('clear','cloudy','light_rain','heavy_rain','unworkable') NOT NULL DEFAULT 'clear',
  work_stopped_hours DECIMAL(4,1) NOT NULL DEFAULT 0,
  stoppage_reason ENUM('none','rain','material_shortage','labour_shortage',
    'power_failure','client_instruction','statutory','equipment_breakdown',
    'safety_incident') NOT NULL DEFAULT 'none',
  labour_skilled SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  labour_unskilled SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  labour_contractor_id BIGINT UNSIGNED NULL,   -- FK labour_contractors added in 007
  work_done TEXT NOT NULL,
  issues TEXT NULL,
  instructions_received TEXT NULL,
  submitted_by BIGINT UNSIGNED NOT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dpr_project_date (project_id, report_date),
  CONSTRAINT fk_dpr_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_dpr_submitter FOREIGN KEY (submitted_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_dpr_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dpr_stage_progress (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  dpr_id BIGINT UNSIGNED NOT NULL,
  project_stage_id BIGINT UNSIGNED NOT NULL,
  progress_pct_at_eod DECIMAL(5,2) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dpr_stage (dpr_id, project_stage_id),
  CONSTRAINT fk_dsp_dpr FOREIGN KEY (dpr_id) REFERENCES daily_progress_reports (id) ON DELETE CASCADE,
  CONSTRAINT fk_dsp_stage FOREIGN KEY (project_stage_id) REFERENCES project_stages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dpr_photos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  dpr_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  caption VARCHAR(200) NULL,
  taken_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dpr_photos (dpr_id),
  CONSTRAINT fk_dphoto_dpr FOREIGN KEY (dpr_id) REFERENCES daily_progress_reports (id) ON DELETE CASCADE,
  CONSTRAINT fk_dphoto_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE quality_checks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  project_stage_id BIGINT UNSIGNED NULL,
  check_type ENUM('concrete_slump','cube_test_7day','cube_test_28day','steel_test',
    'plumb_level','waterproofing_ponding','electrical_insulation',
    'plumbing_pressure','soil_compaction','other') NOT NULL,
  reference_no VARCHAR(60) NULL,
  sample_taken_on DATE NULL,
  tested_on DATE NULL,
  target_value DECIMAL(10,2) NULL,
  actual_value DECIMAL(10,2) NULL,
  unit VARCHAR(20) NULL,
  result ENUM('pass','fail','pending','retest') NOT NULL DEFAULT 'pending',
  lab_name VARCHAR(140) NULL,
  file_id BIGINT UNSIGNED NULL,
  signed_off_by BIGINT UNSIGNED NULL,
  signed_off_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_qc_project (project_id, result),
  CONSTRAINT fk_qc_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_qc_stage FOREIGN KEY (project_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL,
  CONSTRAINT fk_qc_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_qc_signer FOREIGN KEY (signed_off_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_qc_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE snags (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  location VARCHAR(160) NOT NULL,
  trade ENUM('civil','plaster','painting','electrical','plumbing','carpentry',
    'flooring','waterproofing','fabrication','other') NOT NULL,
  description TEXT NOT NULL,
  severity ENUM('cosmetic','functional','structural','safety') NOT NULL,
  raised_by BIGINT UNSIGNED NOT NULL,
  raised_on DATE NOT NULL,
  raised_source ENUM('internal','client','consultant') NOT NULL DEFAULT 'internal',
  assigned_to BIGINT UNSIGNED NULL,
  target_date DATE NULL,
  status ENUM('open','in_progress','resolved','verified','rejected','deferred') NOT NULL DEFAULT 'open',
  resolved_on DATE NULL,
  verified_by BIGINT UNSIGNED NULL,
  verified_on DATE NULL,
  before_file_id BIGINT UNSIGNED NULL,
  after_file_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_snags_project_status (project_id, status),
  CONSTRAINT fk_snag_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_snag_raiser FOREIGN KEY (raised_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_snag_assignee FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_snag_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_snag_before FOREIGN KEY (before_file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_snag_after FOREIGN KEY (after_file_id) REFERENCES files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_approvals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  authority ENUM('BBMP','BMRDA','BDA','Gram Panchayat','TUDA','KIADB','BESCOM',
    'BWSSB','KSPCB','Fire','Lift Inspectorate','Other') NOT NULL,
  approval_type VARCHAR(140) NOT NULL,
  reference_no VARCHAR(80) NULL,
  applied_on DATE NULL,
  received_on DATE NULL,
  valid_until DATE NULL,
  fee_paise BIGINT NULL,
  status ENUM('not_started','applied','queried','received','rejected','expired')
    NOT NULL DEFAULT 'not_started',
  file_id BIGINT UNSIGNED NULL,
  blocks_stage_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_appr_project (project_id, status),
  CONSTRAINT fk_appr_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_appr_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_appr_stage FOREIGN KEY (blocks_stage_id) REFERENCES project_stages (id) ON DELETE SET NULL,
  CONSTRAINT fk_appr_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_documents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  doc_type ENUM('drawing','contract','boq','sanction','photo',
    'report','handover','warranty','correspondence','other') NOT NULL,
  title VARCHAR(200) NOT NULL,
  revision VARCHAR(20) NULL,
  supersedes_id BIGINT UNSIGNED NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  file_id BIGINT UNSIGNED NOT NULL,
  visible_to_roles JSON NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pdoc_project (project_id, doc_type, is_current),
  CONSTRAINT fk_pdoc_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_pdoc_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pdoc_supersedes FOREIGN KEY (supersedes_id) REFERENCES project_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_pdoc_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: residential stage template. Stage names follow the sequence the
-- packages page publishes; weightages sum to 100.00.
INSERT INTO stage_templates (name, project_type, is_default) VALUES
  ('Residential construction, standard', 'residential_construction', 1);

INSERT INTO stage_template_items (template_id, seq, name, weightage_pct, typical_duration_days, requires_quality_check)
SELECT t.id, v.seq, v.name, v.weightage_pct, v.days, v.qc
FROM stage_templates t
CROSS JOIN (
  SELECT 1 AS seq, 'Site clearance and setting out' AS name, 3.00 AS weightage_pct, 7 AS days, 0 AS qc
  UNION ALL SELECT 2, 'Excavation and earthwork', 5.00, 10, 1
  UNION ALL SELECT 3, 'Foundation and footing', 12.00, 25, 1
  UNION ALL SELECT 4, 'Plinth beam and backfilling', 7.00, 15, 1
  UNION ALL SELECT 5, 'Ground floor RCC structure', 15.00, 35, 1
  UNION ALL SELECT 6, 'Upper floor RCC structure', 13.00, 35, 1
  UNION ALL SELECT 7, 'Block work and masonry', 8.00, 25, 0
  UNION ALL SELECT 8, 'Electrical and plumbing rough-in', 6.00, 20, 1
  UNION ALL SELECT 9, 'Plastering internal and external', 7.00, 25, 0
  UNION ALL SELECT 10, 'Flooring and tiling', 8.00, 25, 0
  UNION ALL SELECT 11, 'Painting and finishing', 8.00, 25, 0
  UNION ALL SELECT 12, 'Final fittings, testing and handover', 8.00, 15, 1
) AS v
WHERE t.name = 'Residential construction, standard';

INSERT INTO stage_templates (name, project_type, is_default) VALUES
  ('Industrial and commercial construction', 'industrial_construction', 0);

INSERT INTO stage_template_items (template_id, seq, name, weightage_pct, typical_duration_days, requires_quality_check)
SELECT t.id, v.seq, v.name, v.weightage_pct, v.days, v.qc
FROM stage_templates t
CROSS JOIN (
  SELECT 1 AS seq, 'Survey, soil investigation and layout' AS name, 4.00 AS weightage_pct, 10 AS days, 1 AS qc
  UNION ALL SELECT 2, 'Site development and levelling', 6.00, 15, 1
  UNION ALL SELECT 3, 'Foundation and machine bases', 16.00, 30, 1
  UNION ALL SELECT 4, 'RCC frame and slabs', 20.00, 45, 1
  UNION ALL SELECT 5, 'Structural steel and roofing', 14.00, 30, 1
  UNION ALL SELECT 6, 'Masonry, cladding and partitions', 10.00, 25, 0
  UNION ALL SELECT 7, 'Electrical, plumbing and HVAC services', 12.00, 30, 1
  UNION ALL SELECT 8, 'Flooring, epoxy and finishes', 8.00, 20, 1
  UNION ALL SELECT 9, 'Commissioning, testing and handover', 10.00, 20, 1
) AS v
WHERE t.name = 'Industrial and commercial construction';

INSERT INTO stage_templates (name, project_type, is_default) VALUES
  ('Interior fitout', 'interior_fitout', 0);

INSERT INTO stage_template_items (template_id, seq, name, weightage_pct, typical_duration_days, requires_quality_check)
SELECT t.id, v.seq, v.name, v.weightage_pct, v.days, v.qc
FROM stage_templates t
CROSS JOIN (
  SELECT 1 AS seq, 'Measurement, design freeze and material selection' AS name, 8.00 AS weightage_pct, 10 AS days, 0 AS qc
  UNION ALL SELECT 2, 'Demolition and civil modification', 10.00, 12, 0
  UNION ALL SELECT 3, 'Electrical and plumbing modification', 12.00, 15, 1
  UNION ALL SELECT 4, 'False ceiling and partitions', 15.00, 18, 0
  UNION ALL SELECT 5, 'Carpentry and modular units', 25.00, 30, 0
  UNION ALL SELECT 6, 'Flooring and wall finishes', 12.00, 15, 0
  UNION ALL SELECT 7, 'Painting and polishing', 10.00, 12, 0
  UNION ALL SELECT 8, 'Fittings, deep clean and handover', 8.00, 8, 1
) AS v
WHERE t.name = 'Interior fitout';

UPDATE settings
SET value_json = CAST((SELECT id FROM stage_templates WHERE is_default = 1 LIMIT 1) AS CHAR)
WHERE key_name = 'projects.default_stage_template_id';
