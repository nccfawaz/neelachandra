-- 014_ca_quantity_check_null.sql
-- Repairs the CHECK constraint 013 added. Schema change only, no data change.
--
-- What was wrong. 013 wrote
--
--   CHECK ((uom = 'per_day' AND quantity IS NULL) OR (uom <> 'per_day' AND quantity > 0))
--
-- and its header claims that makes a measured row with no quantity unwritable.
-- It does not. A CHECK constraint refuses a row only when its expression
-- evaluates to FALSE; UNKNOWN passes, which is the same three-valued rule that
-- makes a UNIQUE index permissive over NULLs in 012. For uom = 'per_sqft' with
-- quantity = NULL:
--
--   ('per_sqft' = 'per_day' AND NULL IS NULL)  ->  FALSE AND TRUE   ->  FALSE
--   ('per_sqft' <> 'per_day' AND NULL > 0)     ->  TRUE  AND NULL   ->  NULL
--   FALSE OR NULL                              ->  NULL             ->  ADMITTED
--
-- So exactly the row the constraint existed to stop was the one row it let
-- through. The three other cases were refused correctly, because each of them
-- compares a quantity that is present: a day row carrying a quantity gives
-- FALSE OR FALSE, and a measured row carrying 0 or a negative gives the same.
--
-- Found by test rather than by reading: the integration case asserting the
-- refusal in both directions saw the INSERT succeed. That is the second time in
-- this slice that a constraint's stated meaning and MariaDB's NULL semantics
-- disagreed, and in the opposite direction each time -- 012 wanted the
-- permissiveness, this did not.
--
-- The fix is to test for presence before comparing, so the disjunct is FALSE
-- rather than UNKNOWN when the quantity is missing. `FALSE AND NULL` is FALSE,
-- so ordering `quantity IS NOT NULL` ahead of `quantity > 0` is what carries it.
--
-- What this does NOT change: no column, no default, no index, and no row. The
-- ALTER validates the table as it stands, so it fails loudly if a row written in
-- the window between 013 and this file used the hole. Counted before applying:
-- 0 rows in contractor_attendance, hence 0 that could block it.
--
-- The third gate stays. generateContractorBill refuses to bill a measured row
-- with a NULL quantity, and until this file that gate was not defence in depth --
-- it was the only thing standing between such a row and a payable amount. It is
-- kept because it is the layer that can say which row and which period, and
-- because a constraint is only as good as the last migration to touch it.

ALTER TABLE contractor_attendance
  DROP CONSTRAINT chk_ca_quantity;

ALTER TABLE contractor_attendance
  ADD CONSTRAINT chk_ca_quantity CHECK (
    (uom = 'per_day' AND quantity IS NULL)
    OR (uom <> 'per_day' AND quantity IS NOT NULL AND quantity > 0)
  );
