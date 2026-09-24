-- 033: Remember the site a person checked in at (DECISIONS 31.12).
--
-- The check-out panel renders no site dropdown -- the worker already said
-- where they are at check-in, and asking again at check-out is one more
-- question standing between a worker at a gate and going home. The check-out
-- therefore resolves its site from THIS column, written at check-in.
--
-- VARCHAR(40) holds the prefixed key ('office:3', 'project:12'), not a bare
-- id: the two id spaces must never collide, and resolveCheckinSite already
-- consumes this exact shape. NULL means the row predates 033 or was written
-- by a path that carried no site; check-out against such a row is refused
-- with a message that names the gap, never invented.
--
-- No CHECK constraints, per the standing rule of this feature.

ALTER TABLE attendance
  ADD COLUMN checkin_site_key VARCHAR(40) NULL AFTER checkin_test;
