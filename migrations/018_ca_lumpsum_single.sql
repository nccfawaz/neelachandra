-- 018: a lumpsum row on contractor_attendance carries a quantity of exactly 1.
--
-- Closes the question left open at DECISIONS 19.2 and answered there by
-- assumption: "`lumpsum` is reachable by the same arithmetic with `quantity` read
-- as the number of times the sum is due, which is a reading rather than a spec
-- statement". That reading was implemented and unconstrained, and it made
-- `amount_paise = rate_paise * quantity` on a row whose `rate_paise` is a whole
-- contract sum. A clerk who typed the square footage into the quantity box of a
-- lumpsum line -- and the entry grid offered exactly that box, `min=0.001`, no
-- upper bound short of 1,000,000 -- would bill the contract sum that many times.
--
-- PROVEN BEFORE THIS FILE WAS WRITTEN, per CLAUDE.md. On a `CREATE TABLE LIKE`
-- copy of contractor_attendance on this server, which was first checked to carry
-- chk_ca_quantity verbatim so that the result would mean something:
--
--   under the 014 clause     lumpsum quantity 300   ADMITTED     <-- the hole
--                            lumpsum quantity NULL  refused 4025
--                            lumpsum quantity 1     ADMITTED
--                            per_sqft quantity 300  ADMITTED
--   under the clause below   lumpsum quantity 300   refused 4025
--                            lumpsum quantity 2     refused 4025
--                            lumpsum quantity 0.999 refused 4025
--                            lumpsum quantity NULL  refused 4025
--                            lumpsum quantity 1     ADMITTED
--                            per_sqft quantity 300  ADMITTED
--                            per_day  quantity NULL ADMITTED
--
-- So the row that cost the most was the one the constraint admitted, and the two
-- shapes that must keep working still do. At 25,00,000 paise a sum, the admitted
-- row carried an amount of 75,00,00,000 paise.
--
-- AND IT IS THE SAME THREE-VALUED CLASS AGAIN, ONE GUARD AWAY. The new conjunct
-- is `(uom <> 'lumpsum' OR quantity = 1)`. Evaluated on its own against a NULL
-- quantity the server returns NULL -- `select (null = 1)` is NULL, and so is the
-- whole disjunction -- which a CHECK admits. It refuses only because 014's
-- `quantity IS NOT NULL` sits ahead of it in the same AND chain and FALSE AND
-- UNKNOWN is FALSE: `select (null is not null and null > 0 and ('lumpsum' <>
-- 'lumpsum' or null = 1))` returns 0. Both were run. This clause is safe because
-- of 014, not on its own, which is the fourth appearance of the class CLAUDE.md
-- names and the first one that was harmless on arrival.
--
-- NO GUARD ROW COUNT, AND THAT IS A DIFFERENCE FROM 017, NOT AN OVERSIGHT.
-- MariaDB validates a CHECK against the rows already stored when it is added:
-- proven on a second copy holding one lumpsum row at quantity 300, where the
-- ALTER below came back 4025 rather than succeeding. A trigger has no such
-- validation, which is why 017 had to build a temporary key to prove its own
-- precondition. This file's precondition is checked by the server. (For the
-- record, contractor_attendance held 0 rows when this ran, so nothing was at
-- stake either way -- but the ALTER is what makes that safe on a database that
-- is not this one.)
--
-- WHY PIN THE QUANTITY RATHER THAN REFUSE THE UNIT, which was the alternative and
-- is recorded as rejected at DECISIONS 21.7. Refusing `lumpsum` on this table was
-- to be paired with "require it as a directly entered bill line", and there is no
-- such line to enter it on: `contractor_bills` is a header, in this schema
-- (006:274) and in the spec (:1663-1670) alike -- `gross_paise` and the deduction
-- columns, no lines table anywhere in §6.6 -- and the spec's own comment on
-- contractor_attendance calls it "headcount per day, THE BASIS OF the contractor
-- bill". The attendance rows are the bill's detail. Adding
-- contractor_bill_lines would give `gross_paise` a second contributing source and
-- put the reconciliation of the two in the one place §6.6 rule 2 exists to close
-- ("Double-billed labour days are the most common leak in a site business"). That
-- is a spec-scale change; the spec wins, so it is flagged rather than taken.
--
-- The narrower reason: refusing the unit here would leave it on the rate card and
-- unbillable, which is the §18.2 gap that 013 was written to close, reopened for
-- one enum member. 19.2 already rejected trimming the rate card, because the enum
-- describes the business correctly and the attendance table was the side that was
-- short.
--
-- ONE, NOT NULL, and that is the other sub-choice. Pinning to 1 leaves
-- `amount_paise = rate_paise * quantity` correct for all four measured units with
-- no third branch to remember, in `recordContractorAttendance` and in
-- `generateContractorBill` both; treating lumpsum like per_day and pinning to NULL
-- would need one in each, and a branch is a thing a later reader can drop. It also
-- makes the clause below a single added conjunct rather than a restructure of a
-- clause that has already been got wrong once.
--
-- WHAT THIS DOES NOT SETTLE. Whether a lumpsum is due per occurrence or once for a
-- whole scope is still an owner question (19.2, and on the blocking list at 17.3).
-- This file does not answer it -- it makes the wrong answer unrepresentable. No row
-- can now claim more than one occurrence, so if the answer is "once per scope, and
-- attendance should not touch it", the narrowing starts from a table where every
-- lumpsum row is exactly one sum and there is no backfill decision to make.
-- Narrowing from an unbounded multiplier would have needed one.
--
-- ONE ALTER, so the table is never briefly unconstrained. 012 established that for
-- the index it renamed; 014 used two statements and left a window, and DDL is not
-- transactional in MariaDB so the window was real. The single-statement form was
-- proven to be accepted on a copy before it was written here.

ALTER TABLE contractor_attendance
  DROP CONSTRAINT chk_ca_quantity,
  ADD CONSTRAINT chk_ca_quantity CHECK (
    (uom = 'per_day' AND quantity IS NULL)
    OR (uom <> 'per_day' AND quantity IS NOT NULL AND quantity > 0
        AND (uom <> 'lumpsum' OR quantity = 1))
  );

ALTER TABLE contractor_attendance
  MODIFY COLUMN quantity DECIMAL(14,3) NULL
    COMMENT 'The measure a non-day rate multiplies: sqft, cum, kg. Exactly 1 on a lumpsum row, where rate_paise is the whole sum -- see 018. NULL on a per_day row. Read through Number(): mysql2 returns DECIMAL as a string.';
