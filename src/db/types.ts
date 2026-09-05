// GENERATED FILE. Do not edit by hand.
// Regenerate with: npm run db:types
//
// Kysely table interfaces read from information_schema after the migrations
// in migrations/ have been applied. See scripts/gen-db-types.mjs for the
// SQL to TypeScript mapping rules and why each one is what it is.

import type { ColumnType, Generated } from 'kysely'

/**
 * DATE and DATETIME arrive as strings because the pool sets dateStrings
 * (src/db/pool.ts). Inserts accept a string or a Date so a caller can hand
 * over either without a cast.
 *
 * There are three variants of each rather than one wrapped in
 * Generated<>, because Generated<ColumnType<...>> nests two ColumnTypes
 * and Kysely then reads the outer one only: comparisons against a plain
 * string stop type checking. Spelling the optional insert out here keeps
 * eb(col, ">=", "2026-04-01") legal.
 */
type SqlDate = ColumnType<string, string | Date, string | Date>
type SqlDateGen = ColumnType<string, string | Date | undefined, string | Date>
type SqlDateNull = ColumnType<string | null, string | Date | null | undefined, string | Date | null>
type SqlJson = ColumnType<unknown, string, string>
type SqlJsonGen = ColumnType<unknown, string | undefined, string>
type SqlJsonNull = ColumnType<unknown, string | null | undefined, string | null>

export interface AccountingPeriodsTable {
  id: Generated<number>
  financial_year: string
  month: number
  period_start: SqlDate
  period_end: SqlDate
  status: Generated<'open' | 'soft_closed' | 'closed'>
  closed_by: Generated<number | null>
  closed_at: SqlDateNull
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface AdjustmentLinesTable {
  id: Generated<number>
  adjustment_id: number
  item_id: number
  qty_system: number
  qty_physical: number
  qty_diff: number
  rate_paise: Generated<number | null>
  created_at: SqlDateGen
}

export interface ApplicantInterviewsTable {
  id: Generated<number>
  applicant_id: number
  round_no: Generated<number>
  scheduled_at: SqlDate
  mode: Generated<'in_person' | 'phone' | 'video'>
  interviewer_employee_id: Generated<number | null>
  outcome: Generated<'pending' | 'pass' | 'fail' | 'no_show'>
  feedback: Generated<string | null>
  score: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ApplicantStageHistoryTable {
  id: Generated<number>
  applicant_id: number
  from_stage: Generated<string | null>
  to_stage: string
  moved_by: number
  moved_at: SqlDateGen
  note: Generated<string | null>
}

export interface ApplicantsTable {
  id: Generated<number>
  job_opening_id: number
  full_name: string
  phone: string
  email: Generated<string | null>
  current_employer: Generated<string | null>
  total_experience_years: Generated<number | null>
  current_ctc_paise: Generated<number | null>
  expected_ctc_paise: Generated<number | null>
  notice_period_days: Generated<number | null>
  resume_file_id: Generated<number | null>
  source: Generated<'referral' | 'naukri' | 'indeed' | 'website' | 'walk_in' | 'linkedin' | 'consultant' | 'other'>
  referred_by_employee_id: Generated<number | null>
  stage: Generated<'applied' | 'screening' | 'shortlisted' | 'interview_1' | 'interview_2' | 'technical_test' | 'reference_check' | 'offer_made' | 'offer_accepted' | 'offer_declined' | 'joined' | 'rejected' | 'on_hold'>
  rejection_reason: Generated<string | null>
  rating: Generated<number | null>
  converted_employee_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ApprovalLimitsTable {
  id: Generated<number>
  role_key: string
  document_type: 'expense' | 'purchase_order' | 'quote_discount_pct' | 'payment_release'
  max_value: number
  requires_second_approval_above: Generated<number | null>
  effective_from: SqlDate
  effective_to: SqlDateNull
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface AttendanceTable {
  id: Generated<number>
  employee_id: number
  attendance_date: SqlDate
  project_id: Generated<number | null>
  status: 'present' | 'absent' | 'half_day' | 'weekly_off' | 'holiday' | 'paid_leave' | 'unpaid_leave' | 'on_duty_travel' | 'comp_off'
  in_time: Generated<string | null>
  out_time: Generated<string | null>
  overtime_hours: Generated<number>
  marked_by: number
  marked_at: SqlDateGen
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  remarks: Generated<string | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface AuditLogTable {
  id: Generated<number>
  user_id: Generated<number | null>
  action: string
  entity_type: Generated<string | null>
  entity_id: Generated<number | null>
  before_json: Generated<string | null>
  after_json: Generated<string | null>
  ip: Generated<Buffer | null>
  created_at: SqlDateGen
}

export interface BankAccountsTable {
  id: Generated<number>
  account_name: string
  bank_name: string
  account_no_last4: Generated<string | null>
  ifsc: Generated<string | null>
  account_type: Generated<'current' | 'savings' | 'od' | 'cc'>
  opening_balance_paise: Generated<number>
  opening_date: SqlDateNull
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface BudgetLinesTable {
  id: Generated<number>
  budget_id: number
  cost_head_id: number
  project_stage_id: Generated<number | null>
  description: Generated<string | null>
  qty: Generated<number | null>
  unit_id: Generated<number | null>
  rate_paise: Generated<number | null>
  amount_paise: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface CampaignSpendTable {
  id: Generated<number>
  campaign_id: number
  spend_date: SqlDate
  amount_paise: number
  impressions: Generated<number | null>
  clicks: Generated<number | null>
  entry_mode: Generated<'manual' | 'api'>
  expense_id: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface CampaignsTable {
  id: Generated<number>
  name: string
  channel: 'organic' | 'paid_search' | 'paid_social' | 'referral' | 'direct' | 'walk_in' | 'whatsapp' | 'call' | 'listing_site' | 'other'
  platform: Generated<string | null>
  objective: Generated<'leads' | 'awareness' | 'recruitment' | 'remarketing'>
  target_geo: Generated<string | null>
  target_project_type: Generated<string | null>
  utm_source: Generated<string | null>
  utm_medium: Generated<string | null>
  utm_campaign: Generated<string | null>
  budget_paise: Generated<number | null>
  start_date: SqlDateNull
  end_date: SqlDateNull
  status: Generated<'planned' | 'active' | 'paused' | 'completed' | 'cancelled'>
  owner_user_id: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ClientInvoicesTable {
  id: Generated<number>
  invoice_no: string
  project_id: number
  client_id: number
  invoice_date: SqlDate
  due_date: SqlDate
  invoice_type: Generated<'advance' | 'milestone' | 'running_account' | 'extra_work' | 'final' | 'retention_release'>
  milestone_id: Generated<number | null>
  work_done_pct: Generated<number | null>
  taxable_paise: Generated<number>
  cgst_paise: Generated<number>
  sgst_paise: Generated<number>
  gst_pct: Generated<number>
  total_paise: Generated<number>
  retention_paise: Generated<number>
  advance_adjusted_paise: Generated<number>
  tds_deducted_by_client_paise: Generated<number>
  net_receivable_paise: Generated<number>
  received_paise: Generated<number>
  status: Generated<'draft' | 'sent' | 'part_paid' | 'paid' | 'overdue' | 'disputed' | 'cancelled'>
  sent_at: SqlDateNull
  narration: Generated<string | null>
  period_id: Generated<number | null>
  created_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ClientsTable {
  id: Generated<number>
  code: string
  name: string
  client_type: 'individual' | 'company' | 'institution' | 'government'
  sector: Generated<string | null>
  gstin: Generated<string | null>
  pan: Generated<string | null>
  billing_address: Generated<string | null>
  city: Generated<string | null>
  state: Generated<string>
  primary_contact_name: Generated<string | null>
  primary_contact_phone: Generated<string | null>
  primary_contact_email: Generated<string | null>
  status: Generated<'active' | 'dormant' | 'blacklisted'>
  created_by: Generated<number | null>
  updated_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface CompetitorsTable {
  id: Generated<number>
  name: string
  notes: Generated<string | null>
  typical_rate_per_sqft_paise: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ConsumptionNormsTable {
  id: Generated<number>
  item_id: number
  project_type: 'residential_construction' | 'commercial_construction' | 'industrial_construction' | 'interior_fitout' | 'civil_infrastructure' | 'machine_foundation' | 'renovation' | 'equipment_rental'
  qty_per_sqft: number
  note: Generated<string | null>
  set_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ContractorAttendanceTable {
  id: Generated<number>
  contractor_id: number
  project_id: number
  attendance_date: SqlDate
  skill_level: 'skilled' | 'semi_skilled' | 'unskilled' | 'mason' | 'carpenter' | 'barbender' | 'plumber' | 'electrician' | 'painter' | 'helper'
  uom: Generated<'per_day' | 'per_sqft' | 'per_cum' | 'per_kg' | 'lumpsum'>
  work_type: Generated<string | null>
  headcount: number
  quantity: Generated<number | null>
  overtime_hours: Generated<number>
  rate_paise: number
  amount_paise: number
  recorded_by: number
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  bill_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ContractorBillsTable {
  id: Generated<number>
  bill_no: string
  contractor_id: number
  project_id: number
  period_from: SqlDate
  period_to: SqlDate
  gross_paise: Generated<number>
  advance_recovered_paise: Generated<number>
  retention_paise: Generated<number>
  tds_paise: Generated<number>
  penalty_paise: Generated<number>
  net_payable_paise: Generated<number>
  status: Generated<'draft' | 'submitted' | 'verified' | 'approved' | 'paid' | 'disputed'>
  verified_by: Generated<number | null>
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  expense_id: Generated<number | null>
  created_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ContractorRatesTable {
  id: Generated<number>
  contractor_id: number
  project_id: Generated<number | null>
  work_type: string
  uom: 'per_day' | 'per_sqft' | 'per_cum' | 'per_kg' | 'lumpsum'
  skill_level: Generated<'skilled' | 'semi_skilled' | 'unskilled' | 'mason' | 'carpenter' | 'barbender' | 'plumber' | 'electrician' | 'painter' | 'helper' | null>
  rate_paise: number
  effective_from: SqlDate
  effective_to: SqlDateNull
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface CostHeadsTable {
  id: Generated<number>
  code: string
  name: string
  parent_id: Generated<number | null>
  head_type: 'material' | 'labour' | 'subcontract' | 'equipment' | 'statutory' | 'overhead'
  is_direct_cost: Generated<number>
  sort_order: Generated<number>
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface DailyProgressReportsTable {
  id: Generated<number>
  project_id: number
  report_date: SqlDate
  weather: Generated<'clear' | 'cloudy' | 'light_rain' | 'heavy_rain' | 'unworkable'>
  work_stopped_hours: Generated<number>
  stoppage_reason: Generated<'none' | 'rain' | 'material_shortage' | 'labour_shortage' | 'power_failure' | 'client_instruction' | 'statutory' | 'equipment_breakdown' | 'safety_incident'>
  labour_skilled: Generated<number>
  labour_unskilled: Generated<number>
  labour_contractor_id: Generated<number | null>
  work_done: string
  issues: Generated<string | null>
  instructions_received: Generated<string | null>
  submitted_by: number
  submitted_at: SqlDateGen
  reviewed_by: Generated<number | null>
  reviewed_at: SqlDateNull
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface DashboardDailySnapshotTable {
  id: Generated<number>
  snapshot_date: SqlDate
  metric_key: string
  metric_value_paise: Generated<number | null>
  metric_value_count: Generated<number | null>
  detail_json: Generated<string | null>
  created_at: SqlDateGen
}

export interface DepartmentsTable {
  id: Generated<number>
  code: string
  name: string
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface DesignationsTable {
  id: Generated<number>
  code: string
  name: string
  department_id: Generated<number | null>
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface DocumentNumberingTable {
  id: Generated<number>
  doc_type: 'project' | 'quote' | 'po' | 'grn' | 'expense' | 'invoice' | 'payment' | 'issue' | 'requisition' | 'transfer' | 'lead' | 'contractor_bill'
  prefix: string
  fy_reset: Generated<number>
  financial_year: string
  last_number: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface DprPhotosTable {
  id: Generated<number>
  dpr_id: number
  file_id: number
  caption: Generated<string | null>
  taken_at: SqlDateNull
  created_at: SqlDateGen
}

export interface DprStageProgressTable {
  id: Generated<number>
  dpr_id: number
  project_stage_id: number
  progress_pct_at_eod: number
  created_at: SqlDateGen
}

export interface EmailLogTable {
  id: Generated<number>
  template_key: string
  recipient: string
  entity_type: Generated<string | null>
  entity_id: Generated<number | null>
  status: 'sent' | 'failed'
  response_json: Generated<string | null>
  error_message: Generated<string | null>
  created_at: SqlDateGen
}

export interface EmployeeCompensationTable {
  id: Generated<number>
  employee_id: number
  effective_from: SqlDate
  effective_to: SqlDateNull
  ctc_annual_paise: number
  basic_paise: Generated<number | null>
  hra_paise: Generated<number | null>
  conveyance_paise: Generated<number | null>
  special_allowance_paise: Generated<number | null>
  site_allowance_paise: Generated<number | null>
  employer_pf_paise: Generated<number | null>
  employer_esi_paise: Generated<number | null>
  revision_reason: Generated<string | null>
  approved_by: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface EmployeeDocumentsTable {
  id: Generated<number>
  employee_id: number
  doc_type: 'aadhaar' | 'pan' | 'passport' | 'driving_licence' | 'educational' | 'experience' | 'offer_letter' | 'appointment_letter' | 'police_verification' | 'medical_fitness' | 'safety_training' | 'trade_certificate' | 'other'
  document_no: Generated<string | null>
  issued_on: SqlDateNull
  expires_on: SqlDateNull
  file_id: number
  verified_by: Generated<number | null>
  verified_on: SqlDateNull
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface EmployeesTable {
  id: Generated<number>
  employee_code: string
  user_id: Generated<number | null>
  full_name: string
  father_or_spouse_name: Generated<string | null>
  date_of_birth: SqlDateNull
  gender: Generated<'male' | 'female' | 'other' | null>
  blood_group: Generated<string | null>
  personal_phone: Generated<string | null>
  personal_email: Generated<string | null>
  emergency_contact_name: Generated<string | null>
  emergency_contact_phone: Generated<string | null>
  permanent_address: Generated<string | null>
  current_address: Generated<string | null>
  department_id: Generated<number | null>
  designation_id: Generated<number | null>
  reporting_to_employee_id: Generated<number | null>
  employment_type: Generated<'permanent' | 'probation' | 'contract' | 'intern' | 'consultant'>
  date_of_joining: SqlDate
  probation_until: SqlDateNull
  date_of_exit: SqlDateNull
  exit_type: Generated<'resigned' | 'terminated' | 'retired' | 'contract_ended' | 'absconded' | null>
  exit_reason: Generated<string | null>
  base_location_id: Generated<number | null>
  pan: Generated<string | null>
  aadhaar_last4: Generated<string | null>
  uan: Generated<string | null>
  pf_number: Generated<string | null>
  esi_number: Generated<string | null>
  bank_account_name: Generated<string | null>
  bank_account_no: Generated<string | null>
  bank_ifsc: Generated<string | null>
  status: Generated<'active' | 'on_notice' | 'on_leave' | 'suspended' | 'exited'>
  created_by: Generated<number | null>
  updated_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface EnquiriesTable {
  id: Generated<number>
  name: string
  phone: string
  email: Generated<string | null>
  city: Generated<string | null>
  service_interest: Generated<string | null>
  message: Generated<string | null>
  source_page: Generated<string | null>
  utm_source: Generated<string | null>
  utm_medium: Generated<string | null>
  utm_campaign: Generated<string | null>
  ip: Generated<Buffer | null>
  user_agent: Generated<string | null>
  status: Generated<'new' | 'contacted' | 'promoted' | 'spam' | 'closed'>
  handled_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface EquipmentTable {
  id: Generated<number>
  code: string
  name: string
  equipment_type: string
  ownership: 'owned' | 'hired'
  current_location_id: Generated<number | null>
  current_project_id: Generated<number | null>
  hire_rate_per_day_paise: Generated<number | null>
  hire_vendor_id: Generated<number | null>
  next_service_due: SqlDateNull
  insurance_valid_until: SqlDateNull
  status: Generated<'available' | 'deployed' | 'under_repair' | 'retired'>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface EquipmentDeploymentsTable {
  id: Generated<number>
  equipment_id: number
  project_id: number
  from_date: SqlDate
  to_date: SqlDateNull
  meter_start: Generated<number | null>
  meter_end: Generated<number | null>
  operator_name: Generated<string | null>
  expense_id: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ExpenseAttachmentsTable {
  id: Generated<number>
  expense_id: number
  file_id: number
  kind: Generated<'bill' | 'receipt' | 'measurement_sheet' | 'photo' | 'approval_mail' | 'other'>
  created_at: SqlDateGen
}

export interface ExpenseLinesTable {
  id: Generated<number>
  expense_id: number
  cost_head_id: number
  project_stage_id: Generated<number | null>
  item_id: Generated<number | null>
  description: Generated<string | null>
  qty: Generated<number | null>
  rate_paise: Generated<number | null>
  amount_paise: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ExpensesTable {
  id: Generated<number>
  expense_no: string
  expense_date: SqlDate
  project_id: Generated<number | null>
  expense_type: 'material_purchase' | 'labour_contractor' | 'subcontract' | 'equipment_hire' | 'equipment_fuel' | 'transport' | 'statutory_fee' | 'professional_fee' | 'salary' | 'site_overhead' | 'office_overhead' | 'marketing' | 'travel' | 'utilities' | 'repair_maintenance' | 'insurance' | 'interest' | 'other'
  payee_type: 'vendor' | 'contractor' | 'employee' | 'authority' | 'other'
  vendor_id: Generated<number | null>
  contractor_id: Generated<number | null>
  employee_id: Generated<number | null>
  payee_name: Generated<string | null>
  source_type: Generated<'manual' | 'grn' | 'contractor_bill' | 'equipment_deployment' | 'campaign_spend' | 'payroll'>
  source_table: Generated<string | null>
  source_id: Generated<number | null>
  bill_no: Generated<string | null>
  bill_date: SqlDateNull
  taxable_paise: Generated<number>
  cgst_paise: Generated<number>
  sgst_paise: Generated<number>
  igst_paise: Generated<number>
  tds_section: Generated<string | null>
  tds_pct: Generated<number>
  tds_paise: Generated<number>
  total_paise: Generated<number>
  net_payable_paise: Generated<number>
  paid_paise: Generated<number>
  is_reimbursable: Generated<number>
  advance_settlement_of: Generated<number | null>
  status: Generated<'draft' | 'pending_approval' | 'approved' | 'rejected' | 'part_paid' | 'paid' | 'void'>
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  second_approved_by: Generated<number | null>
  second_approved_at: SqlDateNull
  rejected_reason: Generated<string | null>
  voided_at: SqlDateNull
  voided_by: Generated<number | null>
  void_reason: Generated<string | null>
  period_id: Generated<number | null>
  narration: Generated<string | null>
  created_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface FilesTable {
  id: Generated<number>
  storage_path: string
  original_name: string
  mime: string
  size_bytes: number
  sha256: string
  visibility: Generated<'private' | 'public'>
  uploaded_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface GoodsReceiptsTable {
  id: Generated<number>
  grn_no: string
  po_id: Generated<number | null>
  vendor_id: number
  location_id: number
  project_id: Generated<number | null>
  received_on: SqlDate
  vehicle_no: Generated<string | null>
  invoice_no: Generated<string | null>
  invoice_date: SqlDateNull
  invoice_amount_paise: Generated<number | null>
  weighbridge_slip_no: Generated<string | null>
  gate_entry_no: Generated<string | null>
  status: Generated<'draft' | 'posted' | 'cancelled'>
  received_by: number
  inspected_by: Generated<number | null>
  expense_id: Generated<number | null>
  posted_at: SqlDateNull
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface GrnLinesTable {
  id: Generated<number>
  grn_id: number
  po_line_id: Generated<number | null>
  item_id: number
  brand: Generated<string | null>
  qty_challan: number
  qty_received: number
  qty_accepted: number
  qty_rejected: Generated<number>
  rejection_reason: Generated<string | null>
  batch_no: Generated<string | null>
  manufacture_date: SqlDateNull
  expiry_date: SqlDateNull
  rate_paise: number
  test_certificate_file_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface InvoiceLinesTable {
  id: Generated<number>
  invoice_id: number
  description: string
  qty: Generated<number | null>
  unit_id: Generated<number | null>
  rate_paise: Generated<number | null>
  amount_paise: number
  sort_order: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface IssueLinesTable {
  id: Generated<number>
  issue_id: number
  item_id: number
  qty_issued: number
  qty_returned: Generated<number>
  rate_paise: Generated<number | null>
  cost_head_id: Generated<number | null>
  batch_no: Generated<string | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ItemBrandsTable {
  id: Generated<number>
  item_id: number
  brand: string
  is_approved: Generated<number>
  approved_by: Generated<number | null>
  note: Generated<string | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ItemCategoriesTable {
  id: Generated<number>
  code: string
  name: string
  parent_id: Generated<number | null>
  sort_order: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ItemStockTable {
  item_id: number
  location_id: number
  qty_on_hand: Generated<number>
  value_paise: Generated<number>
  last_txn_id: Generated<number | null>
  updated_at: SqlDateGen
}

export interface ItemsTable {
  id: Generated<number>
  code: string
  name: string
  category_id: number
  unit_id: number
  cost_head_id: Generated<number | null>
  specification: Generated<string | null>
  hsn_code: Generated<string | null>
  gst_pct: Generated<number>
  reorder_level: Generated<number | null>
  wastage_allowance_pct: Generated<number>
  shelf_life_days: Generated<number | null>
  is_batch_tracked: Generated<number>
  is_active: Generated<number>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface JobOpeningsTable {
  id: Generated<number>
  code: string
  title: string
  department_id: Generated<number | null>
  designation_id: Generated<number | null>
  openings: Generated<number>
  employment_type: Generated<'permanent' | 'probation' | 'contract' | 'intern' | 'consultant'>
  experience_min_years: Generated<number | null>
  experience_max_years: Generated<number | null>
  budget_ctc_min_paise: Generated<number | null>
  budget_ctc_max_paise: Generated<number | null>
  location_city: Generated<string | null>
  job_description: string
  requirements: Generated<string | null>
  status: Generated<'draft' | 'open' | 'on_hold' | 'filled' | 'cancelled'>
  is_published_on_site: Generated<number>
  target_close_date: SqlDateNull
  hiring_manager_employee_id: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LabourContractorsTable {
  id: Generated<number>
  code: string
  name: string
  vendor_id: Generated<number | null>
  contact_phone: Generated<string | null>
  pan: Generated<string | null>
  gstin: Generated<string | null>
  trade_specialisation: Generated<string | null>
  licence_no: Generated<string | null>
  licence_valid_until: SqlDateNull
  esi_registered: Generated<number>
  pf_registered: Generated<number>
  wc_policy_no: Generated<string | null>
  wc_policy_valid_until: SqlDateNull
  rating: Generated<number | null>
  status: Generated<'active' | 'on_hold' | 'blacklisted'>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LeadActivitiesTable {
  id: Generated<number>
  lead_id: number
  activity_type: 'call_out' | 'call_in' | 'whatsapp' | 'email' | 'meeting' | 'site_visit' | 'quote_sent' | 'follow_up' | 'note' | 'status_change'
  occurred_at: SqlDateGen
  duration_minutes: Generated<number | null>
  outcome: Generated<'connected' | 'no_answer' | 'busy' | 'wrong_number' | 'call_back_later' | 'not_interested' | 'positive' | 'negative' | 'neutral' | null>
  summary: string
  next_action: Generated<string | null>
  next_action_date: SqlDateNull
  file_id: Generated<number | null>
  created_by: number
  created_at: SqlDateGen
}

export interface LeadSourcesTable {
  id: Generated<number>
  code: string
  name: string
  channel: 'organic' | 'paid_search' | 'paid_social' | 'referral' | 'direct' | 'walk_in' | 'whatsapp' | 'call' | 'listing_site' | 'other'
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LeadStageHistoryTable {
  id: Generated<number>
  lead_id: number
  from_stage: Generated<string | null>
  to_stage: string
  changed_by: number
  changed_at: SqlDateGen
  days_in_previous_stage: Generated<number | null>
  note: Generated<string | null>
}

export interface LeadsTable {
  id: Generated<number>
  lead_no: string
  enquiry_id: Generated<number | null>
  client_id: Generated<number | null>
  contact_name: string
  phone: string
  alt_phone: Generated<string | null>
  email: Generated<string | null>
  lead_source_id: Generated<number | null>
  campaign_id: Generated<number | null>
  referred_by_client_id: Generated<number | null>
  enquiry_type: Generated<'residential_construction' | 'commercial_construction' | 'industrial_construction' | 'interior_fitout' | 'renovation' | 'equipment_rental' | 'consultation_only'>
  site_city: Generated<string | null>
  site_locality: Generated<string | null>
  survey_number: Generated<string | null>
  plot_area_sqft: Generated<number | null>
  plot_dimensions: Generated<string | null>
  target_built_up_sqft: Generated<number | null>
  floors_wanted: Generated<number | null>
  jurisdiction: Generated<'BBMP' | 'BMRDA' | 'BDA' | 'Gram Panchayat' | 'TUDA' | 'KIADB' | 'Other' | null>
  plot_ownership: Generated<'owned_clear_title' | 'owned_under_verification' | 'agreement_stage' | 'joint_development' | 'not_yet_purchased' | null>
  has_sanctioned_plan: Generated<number | null>
  has_architect: Generated<number | null>
  architect_name: Generated<string | null>
  budget_min_paise: Generated<number | null>
  budget_max_paise: Generated<number | null>
  preferred_package_id: Generated<number | null>
  funding_mode: Generated<'self' | 'home_loan' | 'loan_sanctioned' | 'loan_applied' | 'company_capex' | null>
  expected_start: Generated<'immediate' | 'within_1_month' | '1_to_3_months' | '3_to_6_months' | 'beyond_6_months' | 'exploring' | null>
  stage: Generated<'new' | 'contacted' | 'qualified' | 'site_visit_scheduled' | 'site_visit_done' | 'estimate_shared' | 'quote_sent' | 'negotiation' | 'verbal_agreement' | 'won' | 'lost' | 'dormant' | 'disqualified'>
  stage_changed_at: SqlDateGen
  score: Generated<number>
  temperature: Generated<'hot' | 'warm' | 'cold'>
  assigned_to: Generated<number | null>
  assigned_at: SqlDateNull
  next_action: Generated<string | null>
  next_action_date: SqlDateNull
  first_response_at: SqlDateNull
  expected_value_paise: Generated<number | null>
  probability_pct: Generated<number | null>
  lost_reason: Generated<'price' | 'timeline' | 'competitor' | 'plot_issue' | 'loan_rejected' | 'postponed' | 'no_response' | 'out_of_scope' | 'duplicate' | 'other' | null>
  lost_to_competitor: Generated<string | null>
  lost_notes: Generated<string | null>
  converted_project_id: Generated<number | null>
  created_by: Generated<number | null>
  updated_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LeaveBalancesTable {
  id: Generated<number>
  employee_id: number
  leave_type_id: number
  financial_year: string
  opening: Generated<number>
  accrued: Generated<number>
  availed: Generated<number>
  encashed: Generated<number>
  balance: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LeaveRequestsTable {
  id: Generated<number>
  employee_id: number
  leave_type_id: number
  from_date: SqlDate
  to_date: SqlDate
  days: number
  reason: Generated<string | null>
  handover_to_employee_id: Generated<number | null>
  status: Generated<'pending' | 'approved' | 'rejected' | 'cancelled' | 'withdrawn'>
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  reject_reason: Generated<string | null>
  file_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LeaveTypesTable {
  id: Generated<number>
  code: string
  name: string
  annual_quota: Generated<number | null>
  is_paid: Generated<number>
  carry_forward_max: Generated<number | null>
  requires_document: Generated<number>
  min_notice_days: Generated<number>
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LocationsTable {
  id: Generated<number>
  code: string
  name: string
  location_type: 'central_store' | 'site_store' | 'transit' | 'office'
  project_id: Generated<number | null>
  address: Generated<string | null>
  city: Generated<string | null>
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface LoginAttemptsTable {
  id: Generated<number>
  email: Generated<string | null>
  ip: Generated<Buffer | null>
  succeeded: number
  attempted_at: SqlDateGen
}

export interface MaterialIssuesTable {
  id: Generated<number>
  issue_no: string
  location_id: number
  project_id: number
  project_stage_id: Generated<number | null>
  issued_on: SqlDate
  issued_to_type: Generated<'own_labour' | 'labour_contractor' | 'subcontractor'>
  labour_contractor_id: Generated<number | null>
  received_by_name: Generated<string | null>
  purpose: Generated<string | null>
  status: Generated<'posted' | 'cancelled'>
  issued_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface MaterialRequisitionsTable {
  id: Generated<number>
  req_no: string
  project_id: number
  project_stage_id: Generated<number | null>
  requested_by: number
  required_by_date: SqlDateNull
  status: Generated<'draft' | 'submitted' | 'approved' | 'partially_ordered' | 'ordered' | 'closed' | 'rejected'>
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  reject_reason: Generated<string | null>
  remarks: Generated<string | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface NotificationsTable {
  id: Generated<number>
  user_id: number
  kind: string
  title: string
  body: Generated<string | null>
  link_path: Generated<string | null>
  severity: Generated<'info' | 'warn' | 'critical'>
  read_at: SqlDateNull
  created_at: SqlDateGen
}

export interface PackageSpecGroupsTable {
  id: Generated<number>
  package_id: number
  group_name: string
  sort_order: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface PackageSpecLinesTable {
  id: Generated<number>
  group_id: number
  label: string
  spec_value: string
  item_id: Generated<number | null>
  brand_options: Generated<string | null>
  sort_order: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface PasswordResetTokensTable {
  id: Generated<number>
  user_id: number
  token_hash: string
  purpose: 'invite' | 'reset'
  expires_at: SqlDate
  used_at: SqlDateNull
  created_ip: Generated<Buffer | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface PaymentAllocationsTable {
  id: Generated<number>
  payment_id: number
  document_type: 'expense' | 'contractor_bill' | 'client_invoice' | 'advance'
  document_id: number
  allocated_paise: number
  created_at: SqlDateGen
}

export interface PaymentsTable {
  id: Generated<number>
  payment_no: string
  payment_date: SqlDate
  direction: 'outgoing' | 'incoming'
  mode: Generated<'bank_transfer' | 'neft' | 'rtgs' | 'imps' | 'upi' | 'cheque' | 'cash' | 'card' | 'adjustment'>
  bank_account_id: Generated<number | null>
  reference_no: Generated<string | null>
  amount_paise: number
  payee_or_payer: string
  vendor_id: Generated<number | null>
  contractor_id: Generated<number | null>
  employee_id: Generated<number | null>
  client_id: Generated<number | null>
  project_id: Generated<number | null>
  status: Generated<'recorded' | 'cleared' | 'bounced' | 'cancelled'>
  cleared_on: SqlDateNull
  bounce_reason: Generated<string | null>
  narration: Generated<string | null>
  period_id: Generated<number | null>
  created_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface PermissionsTable {
  id: Generated<number>
  key: string
  module: string
  label: string
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface PoLinesTable {
  id: Generated<number>
  po_id: number
  item_id: number
  brand: Generated<string | null>
  qty_ordered: number
  rate_paise: number
  gst_pct: Generated<number>
  qty_received: Generated<number>
  line_total_paise: Generated<number>
  cost_head_id: Generated<number | null>
  remarks: Generated<string | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ProjectApprovalsTable {
  id: Generated<number>
  project_id: number
  authority: 'BBMP' | 'BMRDA' | 'BDA' | 'Gram Panchayat' | 'TUDA' | 'KIADB' | 'BESCOM' | 'BWSSB' | 'KSPCB' | 'Fire' | 'Lift Inspectorate' | 'Other'
  approval_type: string
  reference_no: Generated<string | null>
  applied_on: SqlDateNull
  received_on: SqlDateNull
  valid_until: SqlDateNull
  fee_paise: Generated<number | null>
  status: Generated<'not_started' | 'applied' | 'queried' | 'received' | 'rejected' | 'expired'>
  file_id: Generated<number | null>
  blocks_stage_id: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ProjectAssignmentsTable {
  id: Generated<number>
  project_id: number
  user_id: number
  assignment_role: 'pm' | 'supervisor' | 'qs' | 'accounts' | 'observer'
  from_date: SqlDate
  to_date: SqlDateNull
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ProjectBudgetsTable {
  id: Generated<number>
  project_id: number
  version: Generated<number>
  budget_type: Generated<'original' | 'revised' | 'forecast'>
  total_paise: Generated<number>
  contingency_pct: Generated<number>
  target_margin_pct: Generated<number | null>
  prepared_by: number
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  revision_reason: Generated<string | null>
  status: Generated<'draft' | 'approved' | 'superseded'>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ProjectDocumentsTable {
  id: Generated<number>
  project_id: number
  doc_type: 'drawing' | 'contract' | 'boq' | 'sanction' | 'photo' | 'report' | 'handover' | 'warranty' | 'correspondence' | 'other'
  title: string
  revision: Generated<string | null>
  supersedes_id: Generated<number | null>
  is_current: Generated<number>
  file_id: number
  visible_to_roles: Generated<string | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ProjectMilestonesTable {
  id: Generated<number>
  project_id: number
  seq: number
  name: string
  trigger_stage_id: Generated<number | null>
  percent_of_contract: Generated<number | null>
  amount_paise: Generated<number | null>
  due_basis: Generated<'on_stage_complete' | 'on_date' | 'on_certification'>
  due_date: SqlDateNull
  status: Generated<'pending' | 'ready_to_certify' | 'certified' | 'invoiced' | 'part_paid' | 'paid' | 'waived'>
  certified_by: Generated<number | null>
  certified_on: SqlDateNull
  invoice_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ProjectStagesTable {
  id: Generated<number>
  project_id: number
  seq: number
  name: string
  weightage_pct: number
  planned_start: SqlDateNull
  planned_end: SqlDateNull
  actual_start: SqlDateNull
  actual_end: SqlDateNull
  progress_pct: Generated<number>
  status: Generated<'not_started' | 'in_progress' | 'blocked' | 'complete'>
  blocked_reason: Generated<string | null>
  requires_quality_check: Generated<number>
  predecessor_stage_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface ProjectsTable {
  id: Generated<number>
  code: string
  name: string
  client_id: number
  project_type: 'residential_construction' | 'commercial_construction' | 'industrial_construction' | 'interior_fitout' | 'civil_infrastructure' | 'machine_foundation' | 'renovation' | 'equipment_rental'
  delivery_model: 'package_per_sqft' | 'item_rate' | 'lumpsum' | 'cost_plus' | 'labour_only'
  package_id: Generated<number | null>
  stage_template_id: Generated<number | null>
  built_up_area_sqft: Generated<number | null>
  plot_area_sqft: Generated<number | null>
  floors_count: Generated<number | null>
  site_address: string
  city: string
  survey_number: Generated<string | null>
  geo_lat: Generated<number | null>
  geo_lng: Generated<number | null>
  jurisdiction: Generated<'BBMP' | 'BMRDA' | 'BDA' | 'Gram Panchayat' | 'TUDA' | 'KIADB' | 'Other' | null>
  scope_of_work: Generated<string | null>
  compliance_standards: Generated<string | null>
  contract_value_paise: Generated<number | null>
  contract_signed_on: SqlDateNull
  rate_per_sqft_paise: Generated<number | null>
  retention_pct: Generated<number>
  gst_pct: Generated<number>
  planned_start: SqlDateNull
  planned_end: SqlDateNull
  actual_start: SqlDateNull
  actual_end: SqlDateNull
  status: Generated<'prospect' | 'mobilising' | 'in_progress' | 'on_hold' | 'snagging' | 'handed_over' | 'defect_liability' | 'closed' | 'cancelled'>
  hold_reason: Generated<string | null>
  physical_progress_pct: Generated<number>
  warranty_structural_until: SqlDateNull
  warranty_general_until: SqlDateNull
  is_public_showcase: Generated<number>
  created_by: Generated<number | null>
  updated_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface PurchaseOrdersTable {
  id: Generated<number>
  po_no: string
  vendor_id: number
  project_id: Generated<number | null>
  requisition_id: Generated<number | null>
  po_date: SqlDate
  expected_delivery: SqlDateNull
  delivery_location_id: number
  subtotal_paise: Generated<number>
  gst_paise: Generated<number>
  freight_paise: Generated<number>
  total_paise: Generated<number>
  payment_terms_days: Generated<number | null>
  advance_pct: Generated<number>
  status: Generated<'draft' | 'pending_approval' | 'approved' | 'partially_received' | 'received' | 'short_closed' | 'cancelled'>
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  second_approved_by: Generated<number | null>
  second_approved_at: SqlDateNull
  short_close_reason: Generated<string | null>
  terms: Generated<string | null>
  created_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface QualityChecksTable {
  id: Generated<number>
  project_id: number
  project_stage_id: Generated<number | null>
  check_type: 'concrete_slump' | 'cube_test_7day' | 'cube_test_28day' | 'steel_test' | 'plumb_level' | 'waterproofing_ponding' | 'electrical_insulation' | 'plumbing_pressure' | 'soil_compaction' | 'other'
  reference_no: Generated<string | null>
  sample_taken_on: SqlDateNull
  tested_on: SqlDateNull
  target_value: Generated<number | null>
  actual_value: Generated<number | null>
  unit: Generated<string | null>
  result: Generated<'pass' | 'fail' | 'pending' | 'retest'>
  lab_name: Generated<string | null>
  file_id: Generated<number | null>
  signed_off_by: Generated<number | null>
  signed_off_at: SqlDateNull
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface QuoteLinesTable {
  id: Generated<number>
  quote_id: number
  line_type: Generated<'package' | 'addon' | 'exclusion_note' | 'extra_work' | 'discount'>
  description: string
  qty: Generated<number | null>
  unit_id: Generated<number | null>
  rate_paise: Generated<number | null>
  amount_paise: Generated<number>
  cost_head_id: Generated<number | null>
  sort_order: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface QuotesTable {
  id: Generated<number>
  quote_no: string
  revision: Generated<number>
  lead_id: number
  package_id: Generated<number | null>
  quote_date: SqlDate
  valid_until: SqlDate
  pricing_basis: Generated<'per_sqft' | 'item_rate' | 'lumpsum'>
  built_up_area_sqft: Generated<number | null>
  rate_per_sqft_paise: Generated<number | null>
  base_amount_paise: Generated<number>
  extras_amount_paise: Generated<number>
  discount_pct: Generated<number>
  discount_amount_paise: Generated<number>
  discount_approved_by: Generated<number | null>
  subtotal_paise: Generated<number>
  gst_pct: Generated<number>
  gst_paise: Generated<number>
  total_paise: Generated<number>
  exclusions: Generated<string | null>
  payment_schedule_json: Generated<string | null>
  status: Generated<'draft' | 'pending_approval' | 'approved' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired' | 'superseded'>
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  sent_at: SqlDateNull
  accepted_at: SqlDateNull
  rejected_reason: Generated<string | null>
  supersedes_quote_id: Generated<number | null>
  created_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface RateLimitHitsTable {
  id: Generated<number>
  bucket: string
  window_start: SqlDate
  hit_count: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface RequisitionLinesTable {
  id: Generated<number>
  requisition_id: number
  item_id: number
  qty_requested: number
  qty_approved: Generated<number | null>
  qty_ordered: Generated<number>
  remarks: Generated<string | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface RolePermissionsTable {
  role_id: number
  permission_id: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface RolesTable {
  id: Generated<number>
  key: string
  label: string
  description: Generated<string | null>
  require_2fa: Generated<number>
  scope_to_assigned_projects: Generated<number>
  is_system: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SafetyIncidentsTable {
  id: Generated<number>
  project_id: number
  incident_date: SqlDate
  incident_time: Generated<string | null>
  severity: 'near_miss' | 'first_aid' | 'medical_treatment' | 'lost_time' | 'permanent_disability' | 'fatality'
  affected_person_type: 'employee' | 'contract_labour' | 'visitor' | 'third_party'
  employee_id: Generated<number | null>
  contractor_id: Generated<number | null>
  affected_person_name: Generated<string | null>
  description: string
  immediate_action: Generated<string | null>
  root_cause: Generated<string | null>
  corrective_action: Generated<string | null>
  reported_to_authority: Generated<number>
  authority_reference: Generated<string | null>
  days_lost: Generated<number>
  closed_on: SqlDateNull
  reported_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SeoKeywordsTable {
  id: Generated<number>
  keyword: string
  page_id: Generated<number | null>
  target_city: Generated<string | null>
  search_volume: Generated<number | null>
  current_rank: Generated<number | null>
  last_checked_on: SqlDateNull
  is_tracked: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SettingsTable {
  id: Generated<number>
  key_name: string
  value_json: string
  data_type: Generated<'string' | 'int' | 'money' | 'bool' | 'json'>
  is_secret: Generated<number>
  label: string
  updated_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SiteFaqsTable {
  id: Generated<number>
  page_id: Generated<number | null>
  question: string
  answer: string
  sort_order: Generated<number>
  is_published: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SitePackagesTable {
  id: Generated<number>
  name: string
  slug: string
  rate_per_sqft_paise: number
  is_most_popular: Generated<number>
  min_area_sqft: Generated<number | null>
  summary: Generated<string | null>
  sort_order: Generated<number>
  is_active: Generated<number>
  effective_from: SqlDate
  effective_to: SqlDateNull
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SitePageRevisionsTable {
  id: Generated<number>
  page_id: number
  revision_no: number
  content_json: string
  title: string
  meta_description: Generated<string | null>
  schema_types: Generated<string | null>
  changed_by: number
  changed_at: SqlDateGen
  change_note: Generated<string | null>
}

export interface SitePagesTable {
  id: Generated<number>
  slug: string
  title: string
  h1: Generated<string | null>
  meta_description: Generated<string | null>
  canonical_path: Generated<string | null>
  og_image_file_id: Generated<number | null>
  schema_types: string
  sitemap_priority: Generated<number>
  sitemap_changefreq: Generated<'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'>
  noindex: Generated<number>
  status: Generated<'draft' | 'published' | 'archived'>
  published_at: SqlDateNull
  published_by: Generated<number | null>
  content_json: string
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SiteServicesTable {
  id: Generated<number>
  slug: string
  name: string
  summary: Generated<string | null>
  body_json: Generated<string | null>
  icon: Generated<string | null>
  sort_order: Generated<number>
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SiteShowcaseTable {
  id: Generated<number>
  project_id: Generated<number | null>
  title: string
  client_display_name: Generated<string | null>
  location: Generated<string | null>
  built_up_area_display: Generated<string | null>
  project_type_display: Generated<string | null>
  scope_of_work: Generated<string | null>
  client_sector: Generated<string | null>
  delivery_status: Generated<string | null>
  compliance_standards: Generated<string | null>
  cover_file_id: Generated<number | null>
  sort_order: Generated<number>
  is_published: Generated<number>
  client_consent_on_file: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SiteShowcaseImagesTable {
  id: Generated<number>
  showcase_id: number
  file_id: number
  caption: Generated<string | null>
  sort_order: Generated<number>
  created_at: SqlDateGen
}

export interface SiteTeamTable {
  id: Generated<number>
  name: string
  job_title: Generated<string | null>
  bio: Generated<string | null>
  photo_file_id: Generated<number | null>
  employee_id: Generated<number | null>
  sort_order: Generated<number>
  is_published: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SiteTestimonialsTable {
  id: Generated<number>
  author_name: string
  author_location: Generated<string | null>
  project_id: Generated<number | null>
  rating: Generated<number | null>
  body: string
  source: 'google' | 'direct' | 'email' | 'whatsapp'
  source_url: Generated<string | null>
  collected_on: SqlDateNull
  is_published: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SiteVisitsTable {
  id: Generated<number>
  lead_id: number
  scheduled_at: SqlDate
  visited_at: SqlDateNull
  visited_by: Generated<number | null>
  status: Generated<'scheduled' | 'completed' | 'client_no_show' | 'rescheduled' | 'cancelled'>
  soil_type: Generated<string | null>
  road_access: Generated<'good' | 'narrow' | 'no_access' | null>
  water_availability: Generated<'borewell' | 'corporation' | 'tanker' | 'none' | null>
  power_availability: Generated<number | null>
  neighbouring_structures: Generated<string | null>
  level_difference_ft: Generated<number | null>
  demolition_required: Generated<number | null>
  tree_cutting_permission_needed: Generated<number | null>
  access_constraints: Generated<string | null>
  feasibility: Generated<'feasible' | 'feasible_with_conditions' | 'not_feasible' | null>
  conditions_notes: Generated<string | null>
  estimated_extra_cost_paise: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface SnagsTable {
  id: Generated<number>
  project_id: number
  location: string
  trade: 'civil' | 'plaster' | 'painting' | 'electrical' | 'plumbing' | 'carpentry' | 'flooring' | 'waterproofing' | 'fabrication' | 'other'
  description: string
  severity: 'cosmetic' | 'functional' | 'structural' | 'safety'
  raised_by: number
  raised_on: SqlDate
  raised_source: Generated<'internal' | 'client' | 'consultant'>
  assigned_to: Generated<number | null>
  target_date: SqlDateNull
  status: Generated<'open' | 'in_progress' | 'resolved' | 'verified' | 'rejected' | 'deferred'>
  resolved_on: SqlDateNull
  verified_by: Generated<number | null>
  verified_on: SqlDateNull
  before_file_id: Generated<number | null>
  after_file_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface StageTemplateItemsTable {
  id: Generated<number>
  template_id: number
  seq: number
  name: string
  weightage_pct: number
  typical_duration_days: Generated<number | null>
  requires_quality_check: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface StageTemplatesTable {
  id: Generated<number>
  name: string
  project_type: Generated<'residential_construction' | 'commercial_construction' | 'industrial_construction' | 'interior_fitout' | 'civil_infrastructure' | 'machine_foundation' | 'renovation' | 'equipment_rental' | null>
  is_default: Generated<number>
  is_active: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface StockAdjustmentsTable {
  id: Generated<number>
  location_id: number
  adjustment_date: SqlDate
  reason: 'physical_count' | 'damage' | 'theft' | 'expiry' | 'wastage' | 'correction'
  narration: string
  approved_by: Generated<number | null>
  approved_at: SqlDateNull
  created_by: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface StockLedgerTable {
  id: Generated<number>
  item_id: number
  location_id: number
  txn_date: SqlDate
  txn_type: 'grn' | 'issue' | 'return' | 'transfer_out' | 'transfer_in' | 'adjustment' | 'opening'
  ref_table: string
  ref_id: number
  qty_in: Generated<number>
  qty_out: Generated<number>
  rate_paise: Generated<number | null>
  value_paise: Generated<number | null>
  balance_after: number
  project_id: Generated<number | null>
  batch_no: Generated<string | null>
  created_by: number
  created_at: SqlDateGen
}

export interface StockTransfersTable {
  id: Generated<number>
  transfer_no: string
  from_location_id: number
  to_location_id: number
  dispatched_on: SqlDate
  received_on: SqlDateNull
  vehicle_no: Generated<string | null>
  status: Generated<'in_transit' | 'received' | 'cancelled'>
  dispatched_by: number
  received_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface TransferLinesTable {
  id: Generated<number>
  transfer_id: number
  item_id: number
  qty_sent: number
  qty_received: Generated<number | null>
  shortage_qty: Generated<number | null>
  rate_paise: Generated<number | null>
  batch_no: Generated<string | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface UnitsTable {
  id: Generated<number>
  code: string
  name: string
  decimal_places: Generated<number>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface UserPermissionOverridesTable {
  id: Generated<number>
  user_id: number
  permission_id: number
  effect: 'grant' | 'deny'
  granted_by: number
  granted_at: SqlDateGen
  note: string
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface UserRecoveryCodesTable {
  id: Generated<number>
  user_id: number
  code_hash: string
  used_at: SqlDateNull
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface UserRolesTable {
  user_id: number
  role_id: number
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface UserSessionsTable {
  id: string
  user_id: number
  created_at: SqlDateGen
  last_seen_at: SqlDateGen
  expires_at: SqlDate
  ip: Generated<Buffer | null>
  user_agent: Generated<string | null>
  totp_verified: Generated<number>
  csrf_token: string
  revoked_at: SqlDateNull
}

export interface UsersTable {
  id: Generated<number>
  email: string
  full_name: string
  phone: Generated<string | null>
  password_hash: Generated<string | null>
  password_algo: Generated<'argon2id' | 'bcrypt'>
  must_change_password: Generated<number>
  password_changed_at: SqlDateNull
  totp_secret: Generated<Buffer | null>
  totp_confirmed_at: SqlDateNull
  status: Generated<'invited' | 'active' | 'suspended' | 'inactive'>
  failed_login_count: Generated<number>
  locked_until: SqlDateNull
  last_login_at: SqlDateNull
  last_login_ip: Generated<Buffer | null>
  employee_id: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface VendorItemRatesTable {
  id: Generated<number>
  vendor_id: number
  item_id: number
  rate_paise: number
  valid_from: SqlDate
  valid_to: SqlDateNull
  freight_included: Generated<number>
  min_order_qty: Generated<number | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface VendorsTable {
  id: Generated<number>
  code: string
  name: string
  vendor_type: 'material' | 'equipment_hire' | 'subcontractor' | 'service' | 'transport'
  gstin: Generated<string | null>
  pan: Generated<string | null>
  msme_udyam_no: Generated<string | null>
  contact_name: Generated<string | null>
  phone: Generated<string | null>
  email: Generated<string | null>
  address: Generated<string | null>
  city: Generated<string | null>
  payment_terms_days: Generated<number>
  bank_account_name: Generated<string | null>
  bank_account_no: Generated<string | null>
  bank_ifsc: Generated<string | null>
  rating_quality: Generated<number | null>
  rating_timeliness: Generated<number | null>
  status: Generated<'active' | 'on_hold' | 'blacklisted'>
  blacklist_reason: Generated<string | null>
  created_by: Generated<number | null>
  created_at: SqlDateGen
  updated_at: SqlDateGen
}

export interface Database {
  accounting_periods: AccountingPeriodsTable
  adjustment_lines: AdjustmentLinesTable
  applicant_interviews: ApplicantInterviewsTable
  applicant_stage_history: ApplicantStageHistoryTable
  applicants: ApplicantsTable
  approval_limits: ApprovalLimitsTable
  attendance: AttendanceTable
  audit_log: AuditLogTable
  bank_accounts: BankAccountsTable
  budget_lines: BudgetLinesTable
  campaign_spend: CampaignSpendTable
  campaigns: CampaignsTable
  client_invoices: ClientInvoicesTable
  clients: ClientsTable
  competitors: CompetitorsTable
  consumption_norms: ConsumptionNormsTable
  contractor_attendance: ContractorAttendanceTable
  contractor_bills: ContractorBillsTable
  contractor_rates: ContractorRatesTable
  cost_heads: CostHeadsTable
  daily_progress_reports: DailyProgressReportsTable
  dashboard_daily_snapshot: DashboardDailySnapshotTable
  departments: DepartmentsTable
  designations: DesignationsTable
  document_numbering: DocumentNumberingTable
  dpr_photos: DprPhotosTable
  dpr_stage_progress: DprStageProgressTable
  email_log: EmailLogTable
  employee_compensation: EmployeeCompensationTable
  employee_documents: EmployeeDocumentsTable
  employees: EmployeesTable
  enquiries: EnquiriesTable
  equipment: EquipmentTable
  equipment_deployments: EquipmentDeploymentsTable
  expense_attachments: ExpenseAttachmentsTable
  expense_lines: ExpenseLinesTable
  expenses: ExpensesTable
  files: FilesTable
  goods_receipts: GoodsReceiptsTable
  grn_lines: GrnLinesTable
  invoice_lines: InvoiceLinesTable
  issue_lines: IssueLinesTable
  item_brands: ItemBrandsTable
  item_categories: ItemCategoriesTable
  item_stock: ItemStockTable
  items: ItemsTable
  job_openings: JobOpeningsTable
  labour_contractors: LabourContractorsTable
  lead_activities: LeadActivitiesTable
  lead_sources: LeadSourcesTable
  lead_stage_history: LeadStageHistoryTable
  leads: LeadsTable
  leave_balances: LeaveBalancesTable
  leave_requests: LeaveRequestsTable
  leave_types: LeaveTypesTable
  locations: LocationsTable
  login_attempts: LoginAttemptsTable
  material_issues: MaterialIssuesTable
  material_requisitions: MaterialRequisitionsTable
  notifications: NotificationsTable
  package_spec_groups: PackageSpecGroupsTable
  package_spec_lines: PackageSpecLinesTable
  password_reset_tokens: PasswordResetTokensTable
  payment_allocations: PaymentAllocationsTable
  payments: PaymentsTable
  permissions: PermissionsTable
  po_lines: PoLinesTable
  project_approvals: ProjectApprovalsTable
  project_assignments: ProjectAssignmentsTable
  project_budgets: ProjectBudgetsTable
  project_documents: ProjectDocumentsTable
  project_milestones: ProjectMilestonesTable
  project_stages: ProjectStagesTable
  projects: ProjectsTable
  purchase_orders: PurchaseOrdersTable
  quality_checks: QualityChecksTable
  quote_lines: QuoteLinesTable
  quotes: QuotesTable
  rate_limit_hits: RateLimitHitsTable
  requisition_lines: RequisitionLinesTable
  role_permissions: RolePermissionsTable
  roles: RolesTable
  safety_incidents: SafetyIncidentsTable
  seo_keywords: SeoKeywordsTable
  settings: SettingsTable
  site_faqs: SiteFaqsTable
  site_packages: SitePackagesTable
  site_page_revisions: SitePageRevisionsTable
  site_pages: SitePagesTable
  site_services: SiteServicesTable
  site_showcase: SiteShowcaseTable
  site_showcase_images: SiteShowcaseImagesTable
  site_team: SiteTeamTable
  site_testimonials: SiteTestimonialsTable
  site_visits: SiteVisitsTable
  snags: SnagsTable
  stage_template_items: StageTemplateItemsTable
  stage_templates: StageTemplatesTable
  stock_adjustments: StockAdjustmentsTable
  stock_ledger: StockLedgerTable
  stock_transfers: StockTransfersTable
  transfer_lines: TransferLinesTable
  units: UnitsTable
  user_permission_overrides: UserPermissionOverridesTable
  user_recovery_codes: UserRecoveryCodesTable
  user_roles: UserRolesTable
  user_sessions: UserSessionsTable
  users: UsersTable
  vendor_item_rates: VendorItemRatesTable
  vendors: VendorsTable
}
