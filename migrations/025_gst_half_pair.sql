-- 025_gst_half_pair.sql
-- Closes the CGST/SGST half-pair. Migration 024's chk_inv_gst_branch enforced
-- that an invoice carries either CGST+SGST or IGST, but admitted a row with
-- CGST 9,000 and SGST 0 — half the intra-state split, the same wrong-on-its-
-- own shape 015's chk_exp_source_pair closes for the expenses source pair.
-- Proven by direct insert before this migration shipped: both half-pairs
-- (CGST 9,000/SGST 0 and the mirror) were ADMITTED, alongside the two
-- legitimate branches and the all-zero row.
--
-- The replacement clause adds `cgst_paise = sgst_paise` to the intra-state
-- branch. splitGst (src/lib/money.ts) computes the halves as tax−floor(tax/2)
-- and floor(tax/2), so the odd paisa lands on CGST and the two are equal only
-- when the tax is even — for an odd tax, CGST = SGST + 1, and a strict
-- equality would refuse a legitimate row. Hence the inequality:
--
--   ABS(cgst_paise - sgst_paise) <= 1
--
-- which permits the one-paisa rounding difference and refuses a half-pair
-- (one half zero, the other non-zero) by a margin no rounding can produce.
--
-- All-zero is permitted ON PURPOSE, not by accident: gst_pct 0 is a real
-- invoice shape (a zero-rated or exempt supply), and the zero-gst branch of
-- client-invoices.test.ts proves it stores 0/0/0 with total = taxable. The
-- CHECK cannot distinguish "zero because exempt" from "zero because the
-- writer forgot" — no column records the intended rate alongside the split —
-- so the guard is on the SHAPE (no half-pairs, no double taxation) and the
-- writer-side rule (place_of_supply is the only split input, 29.5) carries
-- the rest.
--
-- NOT satisfiable trivially: every member is NOT NULL (009's columns), the
-- IS NOT NULL conjuncts keep the clause from evaluating UNKNOWN (the
-- migration-013/014 rule), and the intra branch requires the IGST column to
-- be exactly 0 while the inter branch requires both halves exactly 0 — a row
-- cannot satisfy both branches at once, and the adversarial probe set above
-- (both half-pairs, all-zero, both legitimate branches) is the case list the
-- clause was written against.
--
-- Row count at migration time: 0 client_invoices rows carry a half-pair (the
-- only live rows came from the service, which never produces one), so no
-- backfill or data repair is needed. Proven safe by re-running the probe
-- set after the migration: the two half-pairs refuse with chk_inv_gst_branch,
-- the three legitimate shapes admit.

ALTER TABLE client_invoices DROP CONSTRAINT chk_inv_gst_branch;

ALTER TABLE client_invoices ADD CONSTRAINT chk_inv_gst_branch CHECK (
  cgst_paise IS NOT NULL AND sgst_paise IS NOT NULL AND igst_paise IS NOT NULL
  AND (
    (igst_paise = 0 AND cgst_paise >= 0 AND sgst_paise >= 0
      AND ABS(cgst_paise - sgst_paise) <= 1)
    OR (igst_paise > 0 AND cgst_paise = 0 AND sgst_paise = 0)
  )
);
