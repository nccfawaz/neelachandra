-- Finance slice 3 (spec 6.8 rules 6 and 8, and the allocation targets).
--
-- 1. contractor_bills.paid_paise: payment_allocations.document_type already
--    accepts 'contractor_bill' (009), but the table had no column for the
--    allocated figure, so an allocation target with no writer. The column
--    follows expenses.paid_paise and the same single-writer rule (DECISIONS
--    26.3): the payment allocator writes it and nothing else.
--
-- 2. settings row site_advance_open_threshold: rule 6's threshold in paise.
--    A settings row rather than a constant so the owner can move it without a
--    deploy; a missing row reads as "no advance may be issued while any is
--    open", the conservative reading, not an unbounded one.

ALTER TABLE contractor_bills
  ADD COLUMN paid_paise BIGINT NOT NULL DEFAULT 0 AFTER net_payable_paise;

INSERT INTO settings (key_name, value_json, data_type, label)
VALUES ('site_advance_open_threshold', '5000000', 'money',
  'Refuse a new site advance to an employee whose open advance exceeds this many paise (6.8 rule 6)')
ON DUPLICATE KEY UPDATE label = VALUES(label);
