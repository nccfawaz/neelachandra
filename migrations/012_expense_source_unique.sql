-- 012_expense_source_unique.sql
-- Schema change only. Makes the double-posting guard a constraint rather than a
-- convention: expenses (source_table, source_id) becomes UNIQUE.
--
-- Why now, before 6.8 exists. Rule 1 of 6.8 is explicit about the mechanism and
-- not only the outcome:
--
--   "A unique index on (source_table, source_id) where both are non-null makes
--    double posting impossible at the database level rather than by convention."
--
-- Nothing posts into expenses yet. When 6.8 lands, five posting paths -- GRN,
-- contractor bill, equipment deployment, campaign spend, payroll -- will each be
-- written on the assumption that a second attempt is refused underneath them.
-- Adding the constraint after those five exist means auditing five call sites
-- and whatever rows they have already written; adding it while the table is
-- empty costs one ALTER. expenses held 0 rows and 0 duplicate
-- (source_table, source_id) groups when this file was written, checked against
-- the dev database rather than assumed.
--
-- Where the divergence actually is. Not in 009_finance.sql. The spec's own DDL
-- block for expenses, at NCC_BUILD_SPEC.md:2013, writes
--
--   KEY idx_exp_source (source_table, source_id)
--
-- and 009_finance.sql:140 reproduced it faithfully. Rule 1, at :2137, then calls
-- that same index unique. The spec contradicts itself, and the migration matched
-- the half that is a schema sketch rather than the half that is a behavioural
-- guarantee. The guarantee wins here: a KEY is an access path and promises
-- nothing, while rule 1 is a statement about what the database refuses, and it
-- is the only sentence in 6.8 that says how double counting is prevented at all.
-- Recorded as a spec-internal conflict in DECISIONS 19.1 rather than settled by
-- editing either line of the spec.
--
-- NULL stays permissive, and that is the requirement rather than a hole in it.
-- Rule 1 says "where both are non-null", and MariaDB has no partial index to
-- carry that clause. It does not need one: a UNIQUE index treats any row with a
-- NULL in an indexed column as distinct from every other row, so unlimited rows
-- may hold (NULL, NULL) while ('contractor_bills', 7) may appear once. The whole
-- manual class rule 1 closes on -- statutory fees, professional fees, site
-- overheads, travel -- carries no source document and is untouched.
-- tests/integration/hr-contractor-flow.test.ts asserts both halves: several
-- NULL-source rows insert, and a repeated non-null pair comes back ER_DUP_ENTRY
-- from the driver rather than from a service check.
--
-- A row with source_table set and source_id NULL is exempt by the same rule.
-- Nothing writes one, and 009's own comment at :8 treats the pair as a unit.
--
-- The index is renamed rather than altered under its old name. Every other
-- unique key in this schema is uq_ (uq_expense_no, uq_period, uq_budget,
-- uq_cb_no, uq_ca), and an index called idx_ that silently refuses an insert is
-- the sort of name that costs somebody an afternoon. One ALTER does the DROP and
-- the ADD, so there is no window in which the pair is indexed by neither.

ALTER TABLE expenses
  DROP INDEX idx_exp_source,
  ADD UNIQUE KEY uq_exp_source (source_table, source_id),
  MODIFY COLUMN source_table VARCHAR(40) NULL
    COMMENT 'With source_id, UNIQUE as uq_exp_source per spec 6.8 rule 1: one expense per upstream document. NULL for manual entry and deliberately not constrained. See DECISIONS.md 19.',
  MODIFY COLUMN source_id BIGINT UNSIGNED NULL
    COMMENT 'The upstream row id, e.g. contractor_bills.id. Unique with source_table; NULL for manual entry.';
