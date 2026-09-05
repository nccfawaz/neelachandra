-- 019: the lumpsum conjunct refuses a NULL quantity on its own.
--
-- Behaviour-preserving. The clause below admits and refuses exactly what 018's
-- admits and refuses; what changes is why. 018 added
-- `(uom <> 'lumpsum' OR quantity = 1)`, which over a NULL quantity evaluates to
-- NULL -- UNKNOWN, which a CHECK admits -- and was refused only because 014's
-- `quantity IS NOT NULL` sat beside it in the same AND. That dependency was real
-- and it was written down in two test comments, which is where DECISIONS 21.7
-- left it. A comment cannot go red. This file removes the dependency instead, so
-- the disjunct is FALSE over a NULL by itself and nothing outside it has to hold
-- for the refusal to happen.
--
-- ONE CORRECTION TO 018'S HEADER, which cannot be edited: it says the guard
-- "sits ahead of it in the same AND chain", and the ordering is not what carried
-- it. `FALSE AND UNKNOWN` is FALSE in either order and MariaDB promises no
-- evaluation order. What carried it was the sibling relationship -- the guard and
-- the disjunction being conjuncts of the same AND. Written order was incidental,
-- and a reader who took the header at its word would think reordering the clause
-- was the danger, when moving the disjunct under a different parent was.
--
-- PROVEN BEFORE THIS FILE WAS WRITTEN, per CLAUDE.md. Two proofs, both on this
-- server.
--
-- The sub-expression, which is the thing being fixed:
--
--   select ('lumpsum' <> 'lumpsum' OR NULL = 1)                        -> NULL
--   select ('lumpsum' <> 'lumpsum' OR (NULL IS NOT NULL AND NULL = 1)) -> 0
--   select (FALSE AND NULL), (NULL AND FALSE)                          -> 0, 0
--
-- The first is 018's disjunct alone and a CHECK admits it. The second is this
-- file's and a CHECK refuses it. The third pair is why 018 was nonetheless safe,
-- and why the order it was written in had nothing to do with it.
--
-- And the whole clause, on a `CREATE TABLE ... LIKE contractor_attendance` copy
-- first confirmed to carry chk_ca_quantity and chk_ca_work_type verbatim, 15
-- shapes run under 018's clause and again under this one:
--
--   lumpsum  quantity 1      ADMITTED   both        <-- the shape 018 exists for
--   lumpsum  quantity NULL   refused 4025 both      <-- the dependency in question
--   lumpsum  quantity 300    refused 4025 both
--   lumpsum  quantity 2      refused 4025 both
--   lumpsum  quantity 0.999  refused 4025 both
--   lumpsum  quantity 0      refused 4025 both
--   per_sqft quantity 300    ADMITTED   both
--   per_sqft quantity 1      ADMITTED   both
--   per_sqft quantity NULL   refused 4025 both
--   per_sqft quantity 0      refused 4025 both
--   per_cum  quantity 12.5   ADMITTED   both
--   per_kg   quantity NULL   refused 4025 both
--   per_day  quantity NULL   ADMITTED   both
--   per_day  quantity 1      refused 4025 both
--   per_day  NULL + work_type set  refused 4025 chk_ca_work_type, both
--
-- 15 shapes, 0 differences, 5 rows surviving each run. The copy's clause was then
-- re-normalised back to 018's text and compared string-equal to the live one, so
-- the "both" column is a comparison against what is actually deployed rather than
-- against a retyping of it. contractor_attendance held 0 rows when this ran; the
-- ALTER validates against stored rows regardless, which is what makes it safe on
-- a database that is not this one.
--
-- THE INNER GUARD IS REDUNDANT AND THAT IS THE POINT. `quantity IS NOT NULL`
-- appears twice in the clause below and the outer one still makes the inner one
-- logically unnecessary. Do not simplify it away: the whole defect class at
-- CLAUDE.md's "A nullable column inside a CHECK or a UNIQUE key weakens it
-- silently" is clauses that read as correct, and "this conjunct is already
-- implied" reads as correct every time. The tripwire in
-- tests/integration/hr-contractor-flow.test.ts extracts this disjunct from
-- information_schema and evaluates it alone against a NULL, so a simplification
-- fails a test rather than a code review.
--
-- WHY NOT NOT NULL WITH A SENTINEL, which is the shape CLAUDE.md prefers and 016
-- used for work_type. A sentinel needs a value outside the column's real domain,
-- and `work_type` had one: '' is not the name of any kind of work, so
-- chk_ca_work_type can make it unreachable on a measured row. `quantity` has no
-- such value. It is DECIMAL(14,3); every number a sentinel could be is either a
-- plausible measure or already refused by `quantity > 0`, and picking one -- 0,
-- or a negative -- would need a fresh exemption inside this same clause to keep
-- it unreachable on a measured row. That is the second constraint the preferred
-- shape exists to avoid, arrived at by a longer road. NULL on a per_day row is
-- also meaningful here rather than an absence of data: there is no measure,
-- because a day is the measure.
--
-- ONE ALTER, so the table is never briefly unconstrained -- 012's rule, and 014's
-- omission. DDL is not transactional in MariaDB, so the window a two-statement
-- drop-then-add leaves is real. The single-statement form was proven accepted on
-- the copy above before it was written here.

ALTER TABLE contractor_attendance
  DROP CONSTRAINT chk_ca_quantity,
  ADD CONSTRAINT chk_ca_quantity CHECK (
    (uom = 'per_day' AND quantity IS NULL)
    OR (uom <> 'per_day' AND quantity IS NOT NULL AND quantity > 0
        AND (uom <> 'lumpsum' OR (quantity IS NOT NULL AND quantity = 1)))
  );

-- The comment 018 set points a reader at 018 for the rule, and 018's clause is no
-- longer the live one. Same rule, current pointer.
ALTER TABLE contractor_attendance
  MODIFY COLUMN quantity DECIMAL(14,3) NULL
    COMMENT 'The measure a non-day rate multiplies: sqft, cum, kg. Exactly 1 on a lumpsum row, where rate_paise is the whole sum -- see 018, clause restructured by 019. NULL on a per_day row. Read through Number(): mysql2 returns DECIMAL as a string.';
