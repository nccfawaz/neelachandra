-- 032: Check-in test mode (DECISIONS 31.10).
--
-- A per-employee boolean, not an env var and not a hardcoded email: who is
-- testing is a property of the person, set by HR, and it must survive
-- redeploys and work on a phone hotspot where env vars do not reach.
--
-- When set, the person may check in and out repeatedly on the same day: each
-- attempt OVERWRITES the previous reading instead of being refused, because
-- a tester walking outside the 500 m fence needs to produce a far reading
-- after an on-site one on the same day. Rows written under test mode carry
-- checkin_test = 1, so the HR day view can hold them out of its flagged
-- counts and the muster can ignore them if one ever reaches payroll.
--
-- No CHECK constraints, per the standing rule of this feature: the flag is
-- advisory data, and refusing a write on it would be one more way to strand
-- a worker at the gate.

ALTER TABLE employees
  ADD COLUMN checkin_test_mode TINYINT(1) NOT NULL DEFAULT 0 AFTER muster_excluded;

ALTER TABLE attendance
  ADD COLUMN checkin_test TINYINT(1) NOT NULL DEFAULT 0 AFTER checkout_far;
