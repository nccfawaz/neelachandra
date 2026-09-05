-- 016_ca_unique_work_type.sql
-- Schema change only, no data change: 0 rows in contractor_attendance, counted
-- before applying. Widens uq_ca to include work_type, which 013 deferred, and
-- makes work_type a column a UNIQUE key can actually be built on.
--
-- What was wrong. 013 added work_type and left uq_ca alone, recording the
-- consequence in its own header (013:59-65) and in DECISIONS 19.2 rather than
-- designing around it:
--
--   300 sqft of plastering and 40 sqft of tiling by the same masons on the same
--   day at the same site cannot both be recorded, because they collide on
--   (contractor_id, project_id, attendance_date, skill_level).
--
-- Since 013, work_type is *required* on a measured row -- schemas.ts refuses a
-- measured line that does not name its work, and service.ts refuses it again --
-- so a unique key that omits it is provably too narrow. Skill level cannot
-- distinguish plastering from tiling; that is the whole reason work_type exists.
-- Widening an existing UNIQUE index is not additive, which is why it is here and
-- not in 013.
--
-- THE TRAP, and it is the reason this file changes the column as well as the key.
-- Adding a NULLABLE column to a UNIQUE key does not widen the key. It punches a
-- hole in it. A UNIQUE index treats a row with a NULL in an indexed column as
-- distinct from every other row -- the same three-valued rule as 012, 013 and
-- 015, appearing for the fourth time in this schema -- and work_type is NULL on
-- every per_day row by 013's design. Measured on this server before writing the
-- ALTER, on a throwaway table with UNIQUE KEY (a, w) and w nullable:
--
--   INSERT (1, NULL)  -> ACCEPTED
--   INSERT (1, NULL)  -> ACCEPTED     <- not a duplicate of anything
--   INSERT (1, NULL)  -> ACCEPTED
--   INSERT (1, 'x')   -> ACCEPTED
--   INSERT (1, 'x')   -> REFUSED 1062
--
-- So the naive widen would have stopped uq_ca refusing two identical per_day
-- rows, which are the majority of this table: four masons at a day rate could be
-- recorded twice for one day at one site and billed twice, and no constraint
-- would have said a word. It would have removed a guarantee the table has today
-- in the course of adding one. That is worse than leaving the key narrow.
--
-- So work_type becomes NOT NULL DEFAULT ''. A key member that can be NULL is not
-- a key member. The precedent is 013's own: it chose `uom NOT NULL DEFAULT
-- 'per_day'` over nullable and wrote out why -- a column whose default is the
-- only value those rows could have had protects them identically while leaving
-- every reader free of a coalesce that would otherwise be permanent. The same
-- argument applies here and is already visible in the code: routes.tsx keys the
-- measured grid on `workType ?? ''` in two places, so '' is the de facto
-- encoding of "this row names no work" before this migration ratifies it.
--
-- '' here is NOT the sentinel 015 refused. There, source_table = '' claimed to
-- name a table and named nothing, so it was a lie about the row's own contents.
-- Here '' is the fact itself: a day row is priced by headcount at a skill rate
-- and has no work type to name. The CHECK below makes '' unreachable on a
-- measured row, so it can only ever mean the one thing.
--
-- chk_ca_work_type does two jobs. The first is defence in depth of a rule that
-- until now lived only in the zod schema and the service: a measured row must
-- name its work. The second is the one that matters more, and it is what BOUNDS
-- the relaxation this file performs. Widening a unique key always permits rows
-- it used to refuse, so the widening has to be confined to the case that needs
-- it. Without `uom = 'per_day' AND work_type = ''`, two mason day rows annotated
-- differently -- 'morning' and 'afternoon', say -- would sit in the key as
-- distinct rows, both insert, and both bill. Forcing '' on a day row is what
-- keeps "one day rate row per skill level per date" true after the widen.
--
-- Total by construction, not by a guard: uom is NOT NULL and work_type is NOT
-- NULL once the MODIFY below runs, so neither comparison can take a NULL operand
-- and no branch can evaluate to UNKNOWN. This is the 014 lesson applied at the
-- point of writing rather than in a repair.
--
-- What this file newly PERMITS and did not before, flagged rather than hidden: a
-- day row and a measured row at the same skill level on the same day, because ''
-- and 'Plastering' are different key values. Four masons on a day rate plus four
-- masons plastering 300 sqft, same date, same site. That may be two disjoint
-- gangs, or it may be one gang billed twice, and nothing in the row says which.
-- No key containing work_type can refuse it. It was not asked for and it is not
-- ratified, so contractorAttendanceSchema goes on refusing that pair with a
-- message a person can act on, and DECISIONS 21.5 records it as an owner
-- question rather than a decision taken here.
--
-- uom is deliberately NOT added to the key. work_type already names the rate
-- card line, and two units for one named work on one date -- plastering measured
-- both per_sqft and per_cum -- is a data entry error rather than a legitimate
-- pair. Adding uom would make that pair recordable for no gain.
--
-- The day rate ambiguity is unaffected and stays open. contractor_rates.work_type
-- is NOT NULL, so every rate line is named including per_day ones, and
-- applicableRate ignores the name for a day row and sets `ambiguous` when two
-- lines match. Forcing work_type = '' means a day row cannot record which of two
-- same-skill day rates priced it. rate_paise is snapshotted and the ambiguity is
-- written to the audit row, which is what covers it; the fix belongs to the rate
-- card, not to attendance.
--
-- Statement order is load bearing. Backfill before the MODIFY, or a NULL blocks
-- it; MODIFY before the index swap, or the new key is built over a nullable
-- column; the CHECK last, so it validates against the final column definition.
-- All four are validating operations against 0 rows, so any row that contradicted
-- them would fail the migration loudly rather than be admitted.

UPDATE contractor_attendance SET work_type = '' WHERE work_type IS NULL;

ALTER TABLE contractor_attendance
  MODIFY COLUMN work_type VARCHAR(120) NOT NULL DEFAULT ''
    COMMENT 'Which contractor_rates line priced this row, by name. Empty on a per_day row, where skill_level decides. NOT NULL because uq_ca contains it: see 016.';

ALTER TABLE contractor_attendance
  DROP INDEX uq_ca,
  ADD UNIQUE KEY uq_ca (contractor_id, project_id, attendance_date, skill_level, work_type);

ALTER TABLE contractor_attendance
  ADD CONSTRAINT chk_ca_work_type CHECK (
    (uom = 'per_day' AND work_type = '')
    OR (uom <> 'per_day' AND work_type <> '')
  );
