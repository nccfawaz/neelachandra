-- 006_hr.sql
-- Spec 6.6: employees, compensation, documents, attendance, leave, labour
-- contractors, contractor attendance and bills, safety incidents, and
-- recruiting.
--
-- Two spec commitments encoded here:
--
--   Compensation is a separate effective-dated table, not columns on
--   employees, so hr.employee_view can be granted without exposing pay
--   (6.6 rule 5).
--
--   Only aadhaar_last4 is stored, never the full number (6.6 rule 6).
--
-- Leave type quotas are open question 8.6. The leave_types rows are seeded
-- with the statutory names but annual_quota NULL, so the HR screen sets the
-- company figure rather than the migration inventing one.
--
-- users.employee_id gains its foreign key here, per the 001 comment.

CREATE TABLE departments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dept_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE designations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_desig_code (code),
  CONSTRAINT fk_desig_dept FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employees (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_code VARCHAR(20) NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  full_name VARCHAR(140) NOT NULL,
  father_or_spouse_name VARCHAR(140) NULL,
  date_of_birth DATE NULL,
  gender ENUM('male','female','other') NULL,
  blood_group VARCHAR(5) NULL,
  personal_phone VARCHAR(20) NULL,
  personal_email VARCHAR(190) NULL,
  emergency_contact_name VARCHAR(120) NULL,
  emergency_contact_phone VARCHAR(20) NULL,
  permanent_address TEXT NULL,
  current_address TEXT NULL,
  department_id BIGINT UNSIGNED NULL,
  designation_id BIGINT UNSIGNED NULL,
  reporting_to_employee_id BIGINT UNSIGNED NULL,
  employment_type ENUM('permanent','probation','contract','intern','consultant')
    NOT NULL DEFAULT 'probation',
  date_of_joining DATE NOT NULL,
  probation_until DATE NULL,
  date_of_exit DATE NULL,
  exit_type ENUM('resigned','terminated','retired','contract_ended','absconded') NULL,
  exit_reason VARCHAR(255) NULL,
  base_location_id BIGINT UNSIGNED NULL,
  pan CHAR(10) NULL,
  aadhaar_last4 CHAR(4) NULL,                  -- full Aadhaar deliberately not stored
  uan VARCHAR(12) NULL,
  pf_number VARCHAR(30) NULL,
  esi_number VARCHAR(20) NULL,
  bank_account_name VARCHAR(140) NULL,
  bank_account_no VARCHAR(30) NULL,
  bank_ifsc CHAR(11) NULL,
  status ENUM('active','on_notice','on_leave','suspended','exited') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emp_code (employee_code),
  UNIQUE KEY uq_emp_user (user_id),
  KEY idx_emp_status (status),
  CONSTRAINT fk_emp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_emp_dept FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_emp_desig FOREIGN KEY (designation_id) REFERENCES designations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_emp_reports FOREIGN KEY (reporting_to_employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_emp_location FOREIGN KEY (base_location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_emp_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_emp_updated FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD CONSTRAINT fk_users_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT;

CREATE TABLE employee_compensation (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  ctc_annual_paise BIGINT NOT NULL,
  basic_paise BIGINT NULL,
  hra_paise BIGINT NULL,
  conveyance_paise BIGINT NULL,
  special_allowance_paise BIGINT NULL,
  site_allowance_paise BIGINT NULL,
  employer_pf_paise BIGINT NULL,
  employer_esi_paise BIGINT NULL,
  revision_reason VARCHAR(160) NULL,
  approved_by BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_comp_emp (employee_id, effective_from),
  CONSTRAINT fk_comp_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_comp_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_comp_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employee_documents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  doc_type ENUM('aadhaar','pan','passport','driving_licence','educational',
    'experience','offer_letter','appointment_letter','police_verification',
    'medical_fitness','safety_training','trade_certificate','other') NOT NULL,
  document_no VARCHAR(60) NULL,
  issued_on DATE NULL,
  expires_on DATE NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  verified_by BIGINT UNSIGNED NULL,
  verified_on DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_empdoc_expiry (expires_on),
  KEY idx_empdoc_emp (employee_id),
  CONSTRAINT fk_empdoc_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_empdoc_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_empdoc_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE attendance (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  attendance_date DATE NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- NULL falls to overhead
  status ENUM('present','absent','half_day','weekly_off','holiday',
    'paid_leave','unpaid_leave','on_duty_travel','comp_off') NOT NULL,
  in_time TIME NULL,
  out_time TIME NULL,
  overtime_hours DECIMAL(4,1) NOT NULL DEFAULT 0,
  marked_by BIGINT UNSIGNED NOT NULL,
  marked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  remarks VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_att (employee_id, attendance_date),
  KEY idx_att_project_date (project_id, attendance_date),
  CONSTRAINT fk_att_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_att_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_att_marker FOREIGN KEY (marked_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_att_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE leave_types (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(80) NOT NULL,
  annual_quota DECIMAL(4,1) NULL,              -- open question 8.6, set in the HR screen
  is_paid TINYINT(1) NOT NULL DEFAULT 1,
  carry_forward_max DECIMAL(4,1) NULL,
  requires_document TINYINT(1) NOT NULL DEFAULT 0,
  min_notice_days SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_leave_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE leave_balances (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  financial_year CHAR(7) NOT NULL,
  opening DECIMAL(5,1) NOT NULL DEFAULT 0,
  accrued DECIMAL(5,1) NOT NULL DEFAULT 0,
  availed DECIMAL(5,1) NOT NULL DEFAULT 0,
  encashed DECIMAL(5,1) NOT NULL DEFAULT 0,
  balance DECIMAL(5,1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bal (employee_id, leave_type_id, financial_year),
  CONSTRAINT fk_bal_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_bal_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE leave_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  days DECIMAL(4,1) NOT NULL,
  reason VARCHAR(255) NULL,
  handover_to_employee_id BIGINT UNSIGNED NULL,
  status ENUM('pending','approved','rejected','cancelled','withdrawn') NOT NULL DEFAULT 'pending',
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  reject_reason VARCHAR(255) NULL,
  file_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_lr_emp (employee_id, status),
  CONSTRAINT fk_lr_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_lr_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE RESTRICT,
  CONSTRAINT fk_lr_handover FOREIGN KEY (handover_to_employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_lr_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_lr_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE labour_contractors (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(180) NOT NULL,
  vendor_id BIGINT UNSIGNED NULL,
  contact_phone VARCHAR(20) NULL,
  pan CHAR(10) NULL,
  gstin CHAR(15) NULL,
  trade_specialisation VARCHAR(160) NULL,
  licence_no VARCHAR(60) NULL,
  licence_valid_until DATE NULL,
  esi_registered TINYINT(1) NOT NULL DEFAULT 0,
  pf_registered TINYINT(1) NOT NULL DEFAULT 0,
  wc_policy_no VARCHAR(60) NULL,
  wc_policy_valid_until DATE NULL,
  rating TINYINT NULL,
  status ENUM('active','on_hold','blacklisted') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lc_code (code),
  KEY idx_lc_status (status),
  CONSTRAINT fk_lc_vendor FOREIGN KEY (vendor_id) REFERENCES vendors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_lc_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE daily_progress_reports
  ADD CONSTRAINT fk_dpr_contractor FOREIGN KEY (labour_contractor_id) REFERENCES labour_contractors (id) ON DELETE RESTRICT;

ALTER TABLE material_issues
  ADD CONSTRAINT fk_issue_contractor FOREIGN KEY (labour_contractor_id) REFERENCES labour_contractors (id) ON DELETE RESTRICT;

CREATE TABLE contractor_rates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  contractor_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NULL,
  work_type VARCHAR(120) NOT NULL,
  uom ENUM('per_day','per_sqft','per_cum','per_kg','lumpsum') NOT NULL,
  skill_level ENUM('skilled','semi_skilled','unskilled','mason','carpenter',
    'barbender','plumber','electrician','painter','helper') NULL,
  rate_paise BIGINT NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_cr (contractor_id, effective_from),
  CONSTRAINT fk_cr_contractor FOREIGN KEY (contractor_id) REFERENCES labour_contractors (id) ON DELETE CASCADE,
  CONSTRAINT fk_cr_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cr_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contractor_bills (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bill_no VARCHAR(24) NOT NULL,
  contractor_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  gross_paise BIGINT NOT NULL DEFAULT 0,
  advance_recovered_paise BIGINT NOT NULL DEFAULT 0,
  retention_paise BIGINT NOT NULL DEFAULT 0,
  tds_paise BIGINT NOT NULL DEFAULT 0,
  penalty_paise BIGINT NOT NULL DEFAULT 0,
  net_payable_paise BIGINT NOT NULL DEFAULT 0,
  status ENUM('draft','submitted','verified','approved','paid','disputed') NOT NULL DEFAULT 'draft',
  verified_by BIGINT UNSIGNED NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  expense_id BIGINT UNSIGNED NULL,             -- FK expenses added in 009
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cb_no (bill_no),
  KEY idx_cb_contractor (contractor_id, status),
  CONSTRAINT fk_cb_contractor FOREIGN KEY (contractor_id) REFERENCES labour_contractors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cb_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cb_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cb_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cb_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contractor_attendance (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  contractor_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  attendance_date DATE NOT NULL,
  skill_level ENUM('skilled','semi_skilled','unskilled','mason','carpenter',
    'barbender','plumber','electrician','painter','helper') NOT NULL,
  headcount SMALLINT UNSIGNED NOT NULL,
  overtime_hours DECIMAL(5,1) NOT NULL DEFAULT 0,
  rate_paise BIGINT NOT NULL,                  -- snapshot, not a join
  amount_paise BIGINT NOT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  bill_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ca (contractor_id, project_id, attendance_date, skill_level),
  KEY idx_ca_bill (bill_id),
  CONSTRAINT fk_ca_contractor FOREIGN KEY (contractor_id) REFERENCES labour_contractors (id) ON DELETE CASCADE,
  CONSTRAINT fk_ca_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ca_recorder FOREIGN KEY (recorded_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ca_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ca_bill FOREIGN KEY (bill_id) REFERENCES contractor_bills (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE safety_incidents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  incident_date DATE NOT NULL,
  incident_time TIME NULL,
  severity ENUM('near_miss','first_aid','medical_treatment','lost_time',
    'permanent_disability','fatality') NOT NULL,
  affected_person_type ENUM('employee','contract_labour','visitor','third_party') NOT NULL,
  employee_id BIGINT UNSIGNED NULL,
  contractor_id BIGINT UNSIGNED NULL,
  affected_person_name VARCHAR(140) NULL,
  description TEXT NOT NULL,
  immediate_action TEXT NULL,
  root_cause TEXT NULL,
  corrective_action TEXT NULL,
  reported_to_authority TINYINT(1) NOT NULL DEFAULT 0,
  authority_reference VARCHAR(80) NULL,
  days_lost SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  closed_on DATE NULL,
  reported_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_si_project (project_id, incident_date),
  CONSTRAINT fk_si_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_si_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_si_contractor FOREIGN KEY (contractor_id) REFERENCES labour_contractors (id) ON DELETE RESTRICT,
  CONSTRAINT fk_si_reporter FOREIGN KEY (reported_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE job_openings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  title VARCHAR(140) NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  designation_id BIGINT UNSIGNED NULL,
  openings TINYINT UNSIGNED NOT NULL DEFAULT 1,
  employment_type ENUM('permanent','probation','contract','intern','consultant')
    NOT NULL DEFAULT 'permanent',
  experience_min_years TINYINT NULL,
  experience_max_years TINYINT NULL,
  budget_ctc_min_paise BIGINT NULL,
  budget_ctc_max_paise BIGINT NULL,
  location_city VARCHAR(80) NULL,
  job_description TEXT NOT NULL,
  requirements TEXT NULL,
  status ENUM('draft','open','on_hold','filled','cancelled') NOT NULL DEFAULT 'draft',
  is_published_on_site TINYINT(1) NOT NULL DEFAULT 0,
  target_close_date DATE NULL,
  hiring_manager_employee_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jo_code (code),
  KEY idx_jo_status (status, is_published_on_site),
  CONSTRAINT fk_jo_dept FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_jo_desig FOREIGN KEY (designation_id) REFERENCES designations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_jo_manager FOREIGN KEY (hiring_manager_employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_jo_created FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applicants (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_opening_id BIGINT UNSIGNED NOT NULL,
  full_name VARCHAR(140) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(190) NULL,
  current_employer VARCHAR(160) NULL,
  total_experience_years DECIMAL(4,1) NULL,
  current_ctc_paise BIGINT NULL,
  expected_ctc_paise BIGINT NULL,
  notice_period_days SMALLINT NULL,
  resume_file_id BIGINT UNSIGNED NULL,
  source ENUM('referral','naukri','indeed','website','walk_in','linkedin','consultant','other')
    NOT NULL DEFAULT 'website',
  referred_by_employee_id BIGINT UNSIGNED NULL,
  stage ENUM('applied','screening','shortlisted','interview_1','interview_2',
    'technical_test','reference_check','offer_made','offer_accepted',
    'offer_declined','joined','rejected','on_hold') NOT NULL DEFAULT 'applied',
  rejection_reason VARCHAR(255) NULL,
  rating TINYINT NULL,
  converted_employee_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_app_opening (job_opening_id, stage),
  CONSTRAINT fk_app_opening FOREIGN KEY (job_opening_id) REFERENCES job_openings (id) ON DELETE CASCADE,
  CONSTRAINT fk_app_resume FOREIGN KEY (resume_file_id) REFERENCES files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_app_referrer FOREIGN KEY (referred_by_employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_app_converted FOREIGN KEY (converted_employee_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applicant_stage_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  applicant_id BIGINT UNSIGNED NOT NULL,
  from_stage VARCHAR(30) NULL,
  to_stage VARCHAR(30) NOT NULL,
  moved_by BIGINT UNSIGNED NOT NULL,
  moved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note VARCHAR(500) NULL,
  KEY idx_ash_applicant (applicant_id, moved_at),
  CONSTRAINT fk_ash_applicant FOREIGN KEY (applicant_id) REFERENCES applicants (id) ON DELETE CASCADE,
  CONSTRAINT fk_ash_user FOREIGN KEY (moved_by) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applicant_interviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  applicant_id BIGINT UNSIGNED NOT NULL,
  round_no TINYINT NOT NULL DEFAULT 1,
  scheduled_at DATETIME NOT NULL,
  mode ENUM('in_person','phone','video') NOT NULL DEFAULT 'in_person',
  interviewer_employee_id BIGINT UNSIGNED NULL,
  outcome ENUM('pending','pass','fail','no_show') NOT NULL DEFAULT 'pending',
  feedback TEXT NULL,
  score TINYINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ai_applicant (applicant_id, round_no),
  CONSTRAINT fk_ai_applicant FOREIGN KEY (applicant_id) REFERENCES applicants (id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_interviewer FOREIGN KEY (interviewer_employee_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: departments and designations. Designations are the four job titles
-- the site's own JSON-LD already publishes, plus the site roles the spec's
-- role list names. Nothing invented beyond what is already published.
INSERT INTO departments (code, name) VALUES
  ('MGMT', 'Management'),
  ('OPS', 'Operations'),
  ('PROC', 'Procurement and stores'),
  ('SITE', 'Site execution'),
  ('ACCT', 'Accounts and finance'),
  ('HR', 'Human resources'),
  ('SALES', 'Sales and marketing');

INSERT INTO designations (code, name, department_id)
SELECT v.code, v.name, d.id
FROM (
  SELECT 'FOUNDER' AS code, 'Founder' AS name, 'MGMT' AS dept
  UNION ALL SELECT 'OPS-ANALYST', 'Operations Analyst', 'OPS'
  UNION ALL SELECT 'PROC-LEAD', 'Procurement Lead', 'PROC'
  UNION ALL SELECT 'TECH-ADVISOR', 'Technical Advisor', 'MGMT'
  UNION ALL SELECT 'PROJ-MGR', 'Project Manager', 'SITE'
  UNION ALL SELECT 'SITE-SUP', 'Site Supervisor', 'SITE'
  UNION ALL SELECT 'SITE-ENGR', 'Site Engineer', 'SITE'
  UNION ALL SELECT 'ACCT-MGR', 'Accounts Manager', 'ACCT'
  UNION ALL SELECT 'HR-MGR', 'HR Manager', 'HR'
  UNION ALL SELECT 'SALES-EXEC', 'Sales Executive', 'SALES'
  UNION ALL SELECT 'STOREKEEPER', 'Storekeeper', 'PROC'
) AS v
JOIN departments d ON d.code = v.dept;

-- Seed: leave types. Names only, quotas are open question 8.6.
INSERT INTO leave_types (code, name, annual_quota, is_paid, requires_document, min_notice_days) VALUES
  ('EL', 'Earned leave', NULL, 1, 0, 3),
  ('CL', 'Casual leave', NULL, 1, 0, 1),
  ('SL', 'Sick leave', NULL, 1, 1, 0),
  ('LWP', 'Leave without pay', NULL, 0, 0, 1),
  ('COMP', 'Compensatory off', NULL, 1, 0, 1),
  ('MAT', 'Maternity leave', NULL, 1, 1, 30),
  ('PAT', 'Paternity leave', NULL, 1, 1, 15);
