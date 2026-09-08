-- 020_finance_views.sql
-- Spec 6.8 rule 2: the two derived views, "defined in migrations/009 as SQL
-- views so the same arithmetic is not reimplemented per report".
--
-- The DDL block at NCC_BUILD_SPEC.md:2068-2082 sketches both, and 009 never
-- created them — the first of the twelve prose-versus-DDL disagreements
-- reported before this work started. The prose wins (DECISIONS 21.3): rule 2
-- says budget, committed and actual are "always shown together", and a view
-- is the one place the arithmetic can live so the board, the budget screen
-- and the margin report cannot disagree with each other.
--
-- Two departures from the sketch, both stated:
--
--   1. Every aggregate is COALESCEd to 0. The sketch's SUM over zero rows
--      returns NULL, and rule 2's arithmetic — budget - (committed + actual)
--      — turns a NULL into a NULL budget line everywhere it is consumed. A
--      project with no POs and no expenses has committed 0 and actual 0, not
--      unknown. The three-valued-logic section of CLAUDE.md now records this
--      instance: SUM over zero rows is not zero, it is NULL.
--
--   2. v_project_committed also filters po.project_id IS NOT NULL. The sketch
--      groups by po.project_id, which drops NULL-project POs from the output
--      silently; stating the predicate makes the drop visible rather than an
--      accident of grouping. (po_lines carries no project of its own; the PO
--      header's project is the charge.)
--
-- The status filter is the sketch's: ('approved','partially_received'). The
-- purchase_orders.status ENUM on disk has seven members; the tripwire in
-- tests/integration/finance-views.test.ts enumerates them from
-- information_schema and fails when a member is added, so a new status cannot
-- silently start or stop contributing committed cost without this filter
-- being reconsidered.

CREATE OR REPLACE VIEW v_project_committed AS
SELECT
  po.project_id,
  pl.cost_head_id,
  COALESCE(SUM((pl.qty_ordered - pl.qty_received) * pl.rate_paise), 0) AS committed_paise
FROM po_lines pl
JOIN purchase_orders po ON po.id = pl.po_id
WHERE po.status IN ('approved', 'partially_received')
  AND po.project_id IS NOT NULL
GROUP BY po.project_id, pl.cost_head_id;

CREATE OR REPLACE VIEW v_project_actual AS
SELECT
  e.project_id,
  el.cost_head_id,
  COALESCE(SUM(el.amount_paise), 0) AS actual_paise
FROM expense_lines el
JOIN expenses e ON e.id = el.expense_id
WHERE e.status IN ('approved', 'part_paid', 'paid')
  AND e.voided_at IS NULL
  AND e.project_id IS NOT NULL
GROUP BY e.project_id, el.cost_head_id;
