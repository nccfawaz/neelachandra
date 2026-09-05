-- 015_expense_source_pair.sql
-- Schema change only, no data change. Closes the other half of what 012 started:
-- `uq_exp_source` stops one upstream document being posted twice, and nothing
-- stopped a row from naming an upstream document it does not have.
--
-- What was wrong. 012 made (source_table, source_id) UNIQUE and both nullable,
-- deliberately: a UNIQUE index treats a row with a NULL in an indexed column as
-- distinct from every other row, so manual expenses -- both columns NULL, the
-- majority of the table -- do not collide with each other. 19.1 records that
-- reasoning and it stands. But the same permissiveness admits a row with
--
--   source_table = 'contractor_bills', source_id = NULL
--
-- which claims to be the posting of an upstream document and points at no row.
-- The index cannot refuse it. It is not a duplicate of anything, because a NULL
-- is not equal to another NULL for indexing purposes, so two such rows do not
-- even collide with each other. There is no version of a UNIQUE index over this
-- pair that rejects it: an index constrains rows against each other, and this
-- row is wrong on its own. That is what a CHECK is for.
--
-- Why it matters more than it looks. 6.8 rule 1 is the "actuals are never typed
-- where another module already produced them" rule: the pair is the evidence of
-- which document produced the money. A half-populated pair is worse than an
-- empty one, because `source_table IS NOT NULL` is the natural way to ask "is
-- this a posted actual or a manual entry", and such a row answers posted while
-- being unreconcilable to anything. The reverse shape, source_id with no
-- source_table, is an orphan id that no join can resolve.
--
-- Written with the 014 lesson applied, and this time the clause is total by
-- construction rather than by a guard bolted on. `IS NULL` and `IS NOT NULL`
-- never evaluate to UNKNOWN -- they are the two predicates in SQL that always
-- return TRUE or FALSE over a NULL -- so the disjunction below has no third
-- outcome to leak through:
--
--   ('contractor_bills' IS NULL AND NULL IS NULL)      -> FALSE AND TRUE -> FALSE
--   ('contractor_bills' IS NOT NULL AND NULL IS NOT NULL) -> TRUE AND FALSE -> FALSE
--   FALSE OR FALSE                                     -> FALSE          -> REFUSED
--
-- The two sentinel members are in the same constraint because they are the same
-- defect, not a second one. A row carrying source_table = '' or source_id = 0
-- satisfies both-or-neither and still refers to nothing: '' is not a table name
-- and 0 is not an AUTO_INCREMENT id. Both comparisons sit behind the IS NOT NULL
-- test in the same conjunct, so neither can be reached with a NULL operand.
--
-- What this does NOT do: it says nothing about source_type. Tying source_type
-- 'manual' to a NULL pair would mean writing the map from each ENUM member to
-- its table name into the constraint -- six branches to edit every time a
-- posting path lands, and two members ('campaign_spend', 'payroll') have no
-- posting path yet. The pair constraint holds whatever source_type says, which
-- is why it is the one that closes the hole. Recorded in DECISIONS 20 as
-- considered and rejected rather than left unnoticed.
--
-- Precondition, counted before applying: expenses holds 0 rows, so 0 rows can
-- block the ALTER. It is a validating ALTER, so it would fail loudly if any
-- existing row were half-populated rather than admitting it.

ALTER TABLE expenses
  ADD CONSTRAINT chk_exp_source_pair CHECK (
    (source_table IS NULL AND source_id IS NULL)
    OR (
      source_table IS NOT NULL AND source_table <> ''
      AND source_id IS NOT NULL AND source_id > 0
    )
  );
