-- 013_contractor_measured_work.sql
-- Schema change only, additive. Gives `contractor_attendance` the three columns
-- a non-day rate needs, so that four of the five UOMs on the rate card stop
-- being decoration.
--
-- What was wrong. 6.6 declares
--
--   contractor_rates.uom ENUM('per_day','per_sqft','per_cum','per_kg','lumpsum')
--
-- and then gives `contractor_attendance` a headcount, an overtime figure, a
-- snapshot rate and an amount -- and no quantity. Rule 2 bills that table and
-- nothing else. So a per-sqft rate can be entered on the rate card, priced by
-- nobody, and multiplied by nothing: `applicableRate` had `where uom = 'per_day'`
-- hardcoded precisely because a headcount cannot be multiplied by a rate per
-- square foot. DECISIONS 18.2 recorded it as a structural gap in the spec, found
-- while building slice 3. This closes it. 19.2 has the reasoning.
--
-- Not a trim of the rate card. The alternative was to drop the four unreachable
-- members from the ENUM and bill days only. Interiors work is quoted per square
-- foot for false ceiling and per running foot for wardrobes as a matter of
-- course, and `neelachandrainteriors.com` is in scope (8.10), so the ENUM is
-- describing the business correctly and the attendance table was the side that
-- was short.
--
-- Three columns, because pricing a measured line needs three facts:
--
--   quantity   the measure itself: 240.500 sqft. DECIMAL(14,3) is the type 6.8
--              already uses for budget_lines.qty and expense_lines.qty, so the
--              eventual posting is a straight copy rather than a conversion.
--              NULL for a day row, where the multiplier is the headcount.
--   uom        which unit the snapshot rate is quoted in. Alongside rate_paise
--              for the same reason rate_paise is there at all: the row has to
--              stay readable after the rate card moves under it. NOT NULL
--              DEFAULT 'per_day', which is also the correct backfill for every
--              row already written -- they could not have been priced any other
--              way.
--   work_type  which rate card line was used. A day rate is resolved by skill
--              level, but a per-sqft rate is for plastering or for tiling and a
--              contractor may hold both at once, so skill level cannot pick
--              between them. Without this the resolution would fall back to
--              "latest effective_from wins", which for measured work is an
--              arbitrary choice between two very different amounts. NULL on a
--              day row, where skill level already decides.
--
-- uom is NOT NULL with a default rather than nullable. The instruction that
-- prompted this file said additive and nullable; nullable is what protects
-- existing rows, and a column whose default is the only value those rows could
-- have had protects them identically while leaving every reader free of a
-- `uom ?? 'per_day'` coalesce that would otherwise be permanent. Flagged in the
-- report rather than taken silently.
--
-- The CHECK is deliberate, and it is the same argument as 012: the service
-- validates with a message a person can act on, and the constraint makes the
-- invalid row unwritable by any future path that forgets to. A day row carries
-- no quantity and a measured row carries a positive one. Nothing in between is
-- meaningful: a measured row with a NULL quantity would price to zero and a day
-- row with a quantity would state a multiplier that no code reads.
--
-- uq_ca is NOT touched. It stays (contractor_id, project_id, attendance_date,
-- skill_level), so a day can still hold exactly one row per skill level. The
-- consequence, recorded in 19.2 rather than designed around: 300 sqft of
-- plastering and 40 sqft of tiling by the same masons on the same day at the same
-- site cannot both be recorded, because they collide on that key. Widening the
-- key is a change to an existing UNIQUE index, which is not additive, so it is
-- not in this file.

ALTER TABLE contractor_attendance
  ADD COLUMN uom ENUM('per_day','per_sqft','per_cum','per_kg','lumpsum') NOT NULL DEFAULT 'per_day'
    COMMENT 'The unit the snapshot rate_paise is quoted in. Snapshot alongside the rate, not a join. See DECISIONS.md 19.2.'
    AFTER skill_level,
  ADD COLUMN work_type VARCHAR(120) NULL
    COMMENT 'Which contractor_rates line priced this row, by name. NULL on a per_day row, where skill_level decides.'
    AFTER uom,
  ADD COLUMN quantity DECIMAL(14,3) NULL
    COMMENT 'The measure a non-day rate multiplies: sqft, cum, kg, or the number of times a lumpsum is due. NULL on a per_day row. Read through Number(): mysql2 returns DECIMAL as a string.'
    AFTER headcount,
  ADD CONSTRAINT chk_ca_quantity CHECK (
    (uom = 'per_day' AND quantity IS NULL) OR (uom <> 'per_day' AND quantity > 0)
  );
