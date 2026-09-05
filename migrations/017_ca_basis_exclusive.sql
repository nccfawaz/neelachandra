-- 017: one skill level on one date takes a day rate or measured rates, never both.
--
-- SUPERSEDES A STATEMENT IN 016's HEADER, which cannot be edited: `scripts/migrate.mjs`
-- refuses an applied file whose checksum has changed, so the correction has to live
-- here. 016 says of this pair that "contractorAttendanceSchema goes on refusing that
-- pair with a message a person can act on". That was true of one form submission and
-- of nothing else -- see below. From here the refusal is the server's.
--
-- DECISIONS 21.5, resolved in the database rather than left split across two
-- layers. Until this file the pair below was refused by `contractorAttendanceSchema`
-- and admitted by every other caller:
--
--   mason  per_day   ''            headcount 4  quantity NULL   -- a day's gang
--   mason  per_sqft  'Plastering'  headcount 4  quantity 300    -- the same gang?
--
-- Two rows, both billing, and nothing in them says whether they are two disjoint
-- gangs or one gang paid twice for the same day. The policy question is still open
-- and still recorded at 21.5; what is closed here is WHERE the answer lives. The
-- refusal is now the server's, so a script, a later route, or an import that never
-- touches the zod schema gets the same answer the form does.
--
-- AND THE FORM WAS NEVER THE COVER IT LOOKED LIKE. `contractorAttendanceSchema`
-- validates one submission. A day row entered in the morning and a measured row for
-- the same gang entered in the afternoon are two submissions, so the schema never saw
-- them together -- the pair went in through the front door of the very form the
-- refusal was written for, and all the refusal caught was a clerk who typed both
-- lines into one grid. That, rather than the layering, is why this file exists.
--
-- WHY A TRIGGER, WHICH IS THE FIRST ONE IN THIS SCHEMA.
--
-- Not a preference. No UNIQUE index can express this rule, and the proof is two
-- lines. Let f(row) be whatever expression the key is built over. To refuse the
-- pair, a day row must collide with a measured row at the same skill:
--
--   f(mason, per_day, '') == f(mason, per_sqft, 'Plastering')
--
-- The same requirement applied to the next work type gives
--
--   f(mason, per_day, '') == f(mason, per_sqft, 'Tiling')
--
-- and therefore f(Plastering) == f(Tiling) -- two measured work types at one skill
-- level collide, which is exactly the pair migration 016 exists to permit. There is
-- no per-row expression that separates them, so there is no index, generated column
-- or otherwise. Proven against this server before this file was written, on two
-- copies of the table: under the real five-column `uq_ca` the day-plus-measured
-- pair inserted clean, and under the four-column key it collapses to, the pair was
-- refused 1062 -- and so was `('Plastering', 'Tiling')`. Both candidate shapes fail,
-- in opposite directions. A CHECK cannot see another row at all.
--
-- That leaves a trigger, and a trigger has to read the table it is defined on.
-- MariaDB permits that for a BEFORE trigger reading (never writing) its subject
-- table; also proven on a copy before this was written -- the pair was refused
-- SQLSTATE 45000 / errno 1644 in both insertion orders, and `('Plastering',
-- 'Tiling')` inserted clean.
--
-- BOTH DIRECTIONS, AND WHY THE UPDATE TRIGGER IS NOT REDUNDANT.
--
-- Insert order does not matter, so the day-then-measured and measured-then-day
-- cases are one trigger. UPDATE is a separate hole: `uq_ca` refuses a change that
-- lands on an existing key, but moving a measured row onto a skill level that
-- already has a day row does not land on it -- (helper, 'Painting', per_sqft) with
-- skill_level updated to 'mason' becomes (mason, 'Painting', per_sqft) beside
-- (mason, '', per_day), a pair the key sees as two different rows. `id <> NEW.id`
-- is load bearing in that trigger: during a BEFORE UPDATE the row still holds its
-- old `uom`, so a legitimate single-row basis change would otherwise collide with
-- itself and be refused.
--
-- THE MESSAGE IS SHORT ON PURPOSE. SIGNAL caps MESSAGE_TEXT at 128 characters and
-- a person should never see this one: `recordContractorAttendance` checks the same
-- rule behind the FOR UPDATE it already holds over the day and refuses with a
-- message naming the skill, the work and what to do instead. The trigger is the
-- guarantee, not the explanation. It names itself so a grep from the raw error
-- lands here.

-- FIRST, PROVE THE EXISTING ROWS DO NOT ALREADY CONTRADICT IT. A trigger applies to
-- writes from here on and says nothing about what is already stored, so installing
-- one without this leaves the schema asserting a guarantee the data may break. The
-- collapsing four-column key is the shape that cannot be used as the real key --
-- proof above -- but it is exactly the right shape for a one-off check: a group
-- holding both bases yields two DISTINCT tuples differing only in `is_day`, and the
-- key refuses the second with 1062 naming `uq_guard`. Temporary, per-connection,
-- dropped in the same file; a violation fails the migration rather than being
-- admitted.

CREATE TEMPORARY TABLE tmp_ca_basis_guard (
  contractor_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  attendance_date DATE NOT NULL,
  skill_level VARCHAR(20) NOT NULL,
  is_day TINYINT NOT NULL,
  UNIQUE KEY uq_guard (contractor_id, project_id, attendance_date, skill_level)
) ENGINE=InnoDB;

INSERT INTO tmp_ca_basis_guard
  (contractor_id, project_id, attendance_date, skill_level, is_day)
SELECT DISTINCT contractor_id, project_id, attendance_date, skill_level, (uom = 'per_day')
FROM contractor_attendance;

DROP TEMPORARY TABLE tmp_ca_basis_guard;

CREATE TRIGGER trg_ca_basis_bi BEFORE INSERT ON contractor_attendance
FOR EACH ROW
BEGIN
  DECLARE clash INT DEFAULT 0;
  SELECT COUNT(*) INTO clash FROM contractor_attendance
   WHERE contractor_id = NEW.contractor_id
     AND project_id = NEW.project_id
     AND attendance_date = NEW.attendance_date
     AND skill_level = NEW.skill_level
     AND (uom = 'per_day') <> (NEW.uom = 'per_day');
  IF clash > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'trg_ca_basis: one skill level on one date takes a day rate or measured rates, not both';
  END IF;
END;

CREATE TRIGGER trg_ca_basis_bu BEFORE UPDATE ON contractor_attendance
FOR EACH ROW
BEGIN
  DECLARE clash INT DEFAULT 0;
  SELECT COUNT(*) INTO clash FROM contractor_attendance
   WHERE contractor_id = NEW.contractor_id
     AND project_id = NEW.project_id
     AND attendance_date = NEW.attendance_date
     AND skill_level = NEW.skill_level
     AND id <> NEW.id
     AND (uom = 'per_day') <> (NEW.uom = 'per_day');
  IF clash > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'trg_ca_basis: one skill level on one date takes a day rate or measured rates, not both';
  END IF;
END;
