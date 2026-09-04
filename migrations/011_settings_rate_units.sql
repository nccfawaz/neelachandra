-- 011_settings_rate_units.sql
-- Data change only. The three finance rate settings, in the representation the
-- spec uses for a percentage held in a general-purpose column.
--
-- What was wrong. 003_reference.sql:217-219 seeded them as unquoted JSON
-- numbers under data_type 'string':
--
--   ('finance.gst_default_pct',       '18.00', 'string', 0, ...)
--   ('finance.tds_default_pct',        '2.00', 'string', 0, ...)
--   ('finance.retention_default_pct',  '5.00', 'string', 0, ...)
--
-- Valid JSON, so json_valid accepted them, but numbers under a type that says
-- string, and the .00 was already lost by the time the driver returned 18. The
-- consequence was in the editor: the settings page renders String(18), the save
-- coerces 'string' back to the JS string "18", and the first time anyone pressed
-- Save on that form all three rows changed type. A reader written against a
-- fresh database would get a number; the same reader after one save would get a
-- string. Found by tests/integration/json-columns.test.ts during the JSON column
-- sweep; DECISIONS.md 12.7 records it and 13 records this fix.
--
-- Why basis points and not a decimal string. The spec settles it in three places
-- and none of them is a float:
--
--   4.3 approval_limits: "max_value BIGINT -- paise, or basis points for a pct",
--     restated in 002_rbac.sql:90-92.
--   6.7 rule 5: "quotes.discount_pct is checked against approval_limits for
--     quote_discount_pct in basis points."
--   6.8: every rate in the finance schema is DECIMAL(5,2) -- gst_pct DEFAULT
--     18.00, tds_pct DEFAULT 0, contingency_pct DEFAULT 3.00, work_done_pct,
--     threshold_pct, actual_pct. Two decimal places, exactly.
--
-- So a percentage that lives in a general column is an integer in basis points,
-- and 18.00 percent is 1800 of them. That is a lossless encoding of DECIMAL(5,2)
-- and it needs no parsing step where a float could enter: submitQuote already
-- compares a discount in basis points against approval_limits.max_value, and
-- admin/routes.tsx already renders that column as max_value / 100 with a percent
-- sign. Storing these three as decimal strings instead would put a second
-- representation of a percentage in the same codebase, and the conversion
-- between them is where the drift being avoided actually happens.
--
-- data_type becomes 'int'. The settings data_type enum is fixed by 6.2 --
-- ('string','int','money','bool','json') -- and has no decimal member, so this
-- is a choice within the enum rather than an extension of it. 'money' would
-- render 1800 as 18 in the form but hint "in rupees" and call a tax rate money;
-- 'int' renders the stored number, which is why the unit moves into the label,
-- where 6.2's "renders from settings.data_type, so adding a key needs no new UI
-- code" still holds. label is a data column and this is a data migration.
--
-- The conversion is arithmetic rather than three literals so that a value some
-- owner had already edited is carried across at its edited figure, in either the
-- seeded form (JSON number 18) or the post-save form (JSON string "18").

UPDATE settings
SET
  value_json = CAST(CAST(ROUND(CAST(JSON_UNQUOTE(value_json) AS DECIMAL(9,4)) * 100) AS SIGNED) AS CHAR),
  data_type = 'int'
WHERE key_name IN (
  'finance.gst_default_pct',
  'finance.tds_default_pct',
  'finance.retention_default_pct'
);

UPDATE settings SET label = 'Default GST rate, in basis points (1800 = 18.00%)'
  WHERE key_name = 'finance.gst_default_pct';
UPDATE settings SET label = 'Default TDS rate under section 194C, in basis points (200 = 2.00%)'
  WHERE key_name = 'finance.tds_default_pct';
UPDATE settings SET label = 'Default retention rate, in basis points (500 = 5.00%)'
  WHERE key_name = 'finance.retention_default_pct';

ALTER TABLE settings
  MODIFY COLUMN value_json JSON NOT NULL
    COMMENT 'Read only through parseJsonColumn in src/lib/json.ts: mysql2 returns this already parsed. A percentage is stored in basis points per spec 4.3 (1800 = 18.00%). See DECISIONS.md 12 and 13.';
