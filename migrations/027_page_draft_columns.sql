-- 027_page_draft_columns.sql
-- Closes the divergence DECISIONS 29.29/§20.3 recorded: spec :1505 says the
-- block editor "Saves to `draft`, never to live", but editPage wrote
-- content_json straight onto the live row, so editing a published page
-- changed the public site with no publish act. Spec :1359: "publishing is a
-- deliberate act with a preview"; :1506: preview "renders the draft through
-- the real public layout ... so what is previewed is what publishes".
--
-- The shape: draft columns beside the live columns on site_pages. The edit
-- route writes only the draft columns; the publish route (:1507) snapshots
-- the live row to site_page_revisions, copies draft -> live, and stamps
-- published_at/published_by. The public read path (the live columns) is
-- untouched by editing, so the site never changes until publish. Revert
-- (:1508) "restores a revision as a new draft" — it writes the draft
-- columns, and the live site is stable until the operator publishes.
--
-- Alternatives rejected (logged in DECISIONS):
--  - a draft-revision pointer (edits write a flagged revision; publish
--    promotes it): tangles the revert route (:1508 restores *as a draft*,
--    which a promote-pointer cannot express without a second flag) and
--    overloads site_page_revisions, whose NOT NULL narrowing (migration
--    026) exists for restorability, not for holding working drafts.
--  - status-column only (today's shape): "live copy held in the latest
--    published revision" forces every public read through the revisions
--    table and makes the *first* draft of a never-published page
--    unrepresentable.
--
-- No backfill: the columns are new and nullable; a page with no draft yet
-- has NULL draft columns and publish refuses (nothing to publish).
-- Forward-only, additive, no existing column modified.

ALTER TABLE site_pages
  ADD COLUMN draft_title VARCHAR(200) NULL AFTER title,
  ADD COLUMN draft_meta_description VARCHAR(320) NULL AFTER meta_description,
  ADD COLUMN draft_schema_types JSON NULL AFTER schema_types,
  ADD COLUMN draft_content_json JSON NULL AFTER content_json;
