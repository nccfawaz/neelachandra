-- 024_igst_column.sql
-- Gives IGST the column the spec's DDL block named and migration 009 never
-- created. This is sketch-drift in the OPPOSITE direction to §21.3: there the
-- migration carried a column the DDL sketch lacked; here the DDL block
-- (NCC_BUILD_SPEC.md §6.8, client_invoices: "igst_paise BIGINT NOT NULL
-- DEFAULT 0") named a column that 009's table never carried, and the tax
-- regime independently requires it — an inter-state invoice's tax currently
-- lives only inside total_paise, invisible to any query that must report
-- CGST, SGST and IGST separately for GSTR-1.
--
-- Row count at migration time: 0. No backfill is needed and none is written;
-- the column is NOT NULL with no default, per the migration-016 lesson
-- (DECISIONS 27.4): a DEFAULT 0 would make "no IGST" the answer given by
-- omission, including on an inter-state invoice whose writer forgot the
-- column. Every writer must state the split.
--
-- The CHECK enforces the either/or shape with the three-valued-logic rule
-- (CLAUDE.md, migration 013/014): a NULL member makes the plain form
-- UNKNOWN, which MariaDB admits. cgst_paise, sgst_paise and igst_paise are
-- all NOT NULL DEFAULT 0 in 009's table, so the columns themselves cannot be
-- NULL — but the guard is written with the IS NOT NULL conjuncts anyway, so
-- the constraint stays correct if a future migration relaxes a column, and
-- so the clause reads as the rule it is rather than relying on its inputs.
--
--   chk_inv_gst_branch: (cgst_paise IS NOT NULL AND sgst_paise IS NOT NULL
--                        AND igst_paise IS NOT NULL)
--                       AND ( (igst_paise = 0 AND cgst_paise >= 0 AND sgst_paise >= 0)
--                          OR (igst_paise > 0 AND cgst_paise = 0 AND sgst_paise = 0) )
--
-- Intra-state: IGST 0, CGST and SGST non-negative (their sum is the tax).
-- Inter-state: IGST positive, CGST and SGST exactly 0. An invoice carrying
-- both splits — the double-taxation shape — is refused.
--
-- Proven by insert in tests/integration/client-invoices.test.ts: both split
-- branches admitted, the both-branches row refused, the zero-gst shape
-- admitted, and the stored sum equals the tax portion of total_paise.

ALTER TABLE client_invoices
  ADD COLUMN igst_paise BIGINT NOT NULL AFTER sgst_paise;

ALTER TABLE client_invoices
  ADD CONSTRAINT chk_inv_gst_branch CHECK (
    cgst_paise IS NOT NULL AND sgst_paise IS NOT NULL AND igst_paise IS NOT NULL
    AND (
      (igst_paise = 0 AND cgst_paise >= 0 AND sgst_paise >= 0)
      OR (igst_paise > 0 AND cgst_paise = 0 AND sgst_paise = 0)
    )
  );
