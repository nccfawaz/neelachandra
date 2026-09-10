/**
 * The (source_type, source_table) mapping of record for expenses, extracted
 * from expenses-source-mapping.test.ts so each writer suite can import it
 * (DECISIONS 29.19): the group-by in that test can only observe rows its own
 * runs left behind, so the writer-side assertion is where a wrong literal
 * actually fails.
 */
export const WRITER_MAPPING: Record<string, { sourceTable: string | null; status: string }> = {
  manual: { sourceTable: null, status: "written by finance createExpense + issueSiteAdvance ('manual', NULL, NULL)" },
  grn: { sourceTable: 'goods_receipts', status: "written by inventory postGrn (DECISIONS 29.17) — same transaction as the post, expense_id back-linked" },
  contractor_bill: { sourceTable: 'contractor_bills', status: "written by hr approveContractorBill (DECISIONS 29.8) — same transaction as the approval, expense_id back-linked" },
  equipment_deployment: { sourceTable: 'equipment_deployments', status: 'no writer yet — fk_eqd_expense exists but nothing fills it; deferred with recorded reason, DECISIONS 29.17' },
  campaign_spend: { sourceTable: 'campaigns', status: 'no writer yet — marketing phase 5; deferred with recorded reason, DECISIONS 29.17' },
  payroll: { sourceTable: null, status: 'no writer; payroll is attendance-driven, not an expense posting; recorded reason, DECISIONS 29.7' },
}
