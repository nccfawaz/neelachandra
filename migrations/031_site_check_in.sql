-- 031: Site check-in and check-out with location capture (DECISIONS 31).
--
-- Owner decision, 2026-09: attendance is never refused on location grounds.
-- A far reading is recorded and flagged for Sushma to review, and the day
-- stands. That is why there is no CHECK on the distance and no threshold
-- column the writer consults: the threshold (500 m) lives in src/lib/geo.ts
-- and is a review grouping, not a gate.
--
-- Chandrashekar (the owner) is not a worker of record: employees.muster_excluded
-- removes him from the attendance grid, the muster roll and any printed Form
-- XVI, while his row stays for name resolution. Fawaz appears normally.
--
-- Check-in and check-out each capture one location, at the moment of the
-- button press, in their own columns with their own flag. No tracking exists
-- outside those two moments.

-- One ALTER per column: MariaDB cannot reference a column added earlier in
-- the same multi-ADD statement.
-- checkin_at itself: an earlier draft of this feature left the column alone
-- outside the committed chain, so the forward chain owns creating it here.
ALTER TABLE attendance ADD COLUMN checkin_at DATETIME NULL AFTER overtime_hours;
ALTER TABLE attendance ADD COLUMN checkin_lat DECIMAL(9,6) NULL AFTER checkin_at;
ALTER TABLE attendance ADD COLUMN checkin_lng DECIMAL(9,6) NULL AFTER checkin_lat;
ALTER TABLE attendance ADD COLUMN checkin_far TINYINT(1) NOT NULL DEFAULT 0 AFTER checkin_lng;
ALTER TABLE attendance ADD COLUMN checkout_at DATETIME NULL AFTER checkin_far;
ALTER TABLE attendance ADD COLUMN checkout_lat DECIMAL(9,6) NULL AFTER checkout_at;
ALTER TABLE attendance ADD COLUMN checkout_lng DECIMAL(9,6) NULL AFTER checkout_lat;
ALTER TABLE attendance ADD COLUMN checkout_far TINYINT(1) NOT NULL DEFAULT 0 AFTER checkout_lng;

ALTER TABLE employees
  ADD COLUMN muster_excluded TINYINT(1) NOT NULL DEFAULT 0 AFTER status;
