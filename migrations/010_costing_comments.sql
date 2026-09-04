-- 010_costing_comments.sql
-- Column comments only. No schema change, no data change.
--
-- Why a separate migration rather than an edit to 005_inventory.sql: the
-- runner checksums every applied file and treats a changed checksum as a hard
-- failure (scripts/migrate.mjs). 005 has already run on the dev database, so
-- annotating it in place would break the next migrate on every database that
-- already holds it. Comments are cheap to add forward.
--
-- What this records: an out-movement is valued at the store's weighted average
-- at that moment, not at what the named batch cost. Three consecutive issue
-- lines reading 39677 against three different batch numbers is the rule
-- working, not a bug. The rule and its reasoning are DECISIONS.md 2.7; the
-- enforcement is postStockMovement in src/modules/inventory/service.ts, the
-- only writer of item_stock.
--
-- Where batch cost does live: grn_lines.rate_paise, which is the rate that
-- batch was actually received at. Joining stock_ledger.batch_no to
-- grn_lines.batch_no recovers it, so batch-level costing remains computable
-- from history if 2.7 is ever reopened.

ALTER TABLE issue_lines
  MODIFY COLUMN rate_paise BIGINT NULL
    COMMENT 'Store weighted average at the moment of issue, NOT the cost of batch_no. Batch cost is grn_lines.rate_paise. See DECISIONS.md 2.7.',
  MODIFY COLUMN batch_no VARCHAR(40) NULL
    COMMENT 'Traceability and expiry only. Does not drive costing (DECISIONS.md 2.7).';

ALTER TABLE stock_ledger
  MODIFY COLUMN rate_paise BIGINT NULL
    COMMENT 'In-movements: the received rate. Out-movements: the store weighted average at that moment, NOT the cost of batch_no. See DECISIONS.md 2.7.',
  MODIFY COLUMN value_paise BIGINT NULL
    COMMENT 'Signed value effect of this row on item_stock.value_paise. An out-movement that empties the store takes the whole remaining value rather than rate * qty, so no value is left behind zero quantity.',
  MODIFY COLUMN batch_no VARCHAR(40) NULL
    COMMENT 'Traceability and expiry only. Does not drive costing (DECISIONS.md 2.7).';

ALTER TABLE grn_lines
  MODIFY COLUMN rate_paise BIGINT NOT NULL
    COMMENT 'The rate this batch was actually received at. This is where batch-level cost lives; issue_lines.rate_paise is weighted average instead.';

ALTER TABLE item_stock
  MODIFY COLUMN value_paise BIGINT NOT NULL DEFAULT 0
    COMMENT 'Cache. value_paise / qty_on_hand is the current weighted average. Rebuildable from stock_ledger by scripts/reconcile-stock.mjs.';
