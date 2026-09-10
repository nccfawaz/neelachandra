-- 026_revision_schema_not_null.sql
-- Closes DECISIONS 21.4. site_page_revisions exists for one purpose — "every
-- publish snapshots the previous state" (spec :1387) — and its only consumer
-- is the revert route (spec :1508), which "restores a revision as a new
-- draft", writing the revision's columns back toward site_pages. The page's
-- own schema_types is NOT NULL (007:27): a revision that snapshots a page can
-- never hold NULL there, because the page it snapshotted could not. So a NULL
-- revision is a snapshot that cannot be restored — unusable on exactly the
-- path the table exists for.
--
-- Proven before this migration shipped (tests/integration/
-- revision-schema.test.ts): a NULL revision inserted against a live page, and
-- the revert's write refused by the page column's NOT NULL — the defect 21.4
-- predicted, now demonstrated rather than reasoned.
--
-- No backfill is needed for correctness of existing data: the dev database
-- holds zero revision rows and nothing in the tree writes the table yet
-- (§21.4's own survey). The MODIFY is still written with an explicit
-- backfill-before-convert step per the migration-016 lesson — a migration
-- that would fail on a hypothetical row must not exist; one that repairs the
-- hypothetical row must.
--
-- JSON NULL semantics: in MySQL, a JSON column stored as SQL NULL is
-- indistinguishable from an absent value for JSON functions; COALESCE to
-- JSON_QUOTE's empty-object shape would invent structure. Instead any
-- pre-existing NULL is backfilled from its page's current schema_types —
-- the value the revision was snapshotted from, which is the faithful
-- snapshot by definition (:1387). If the page is gone (ON DELETE CASCADE
-- means the revision went with it), no row remains to backfill.

UPDATE site_page_revisions r
  JOIN site_pages p ON p.id = r.page_id
   SET r.schema_types = p.schema_types
 WHERE r.schema_types IS NULL;

ALTER TABLE site_page_revisions
  MODIFY COLUMN schema_types JSON NOT NULL;
