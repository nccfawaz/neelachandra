-- 021_period_lock.sql
-- Spec 6.8 rule 7: "Period close is a real lock. Closing an accounting_periods
-- row rejects any insert or update to expenses, payments, or client_invoices
-- with a date inside it."
--
-- The prose says the lock is "enforced by a single indexed check" on
-- expenses.period_id (NCC_BUILD_SPEC.md:2146-2148). That mechanism is
-- incomplete, and it is the fourth instance of the three-valued-logic class in
-- CLAUDE.md's terms:
--
--   * period_id is stamped on approval, so a DRAFT dated inside a closed
--     period has period_id NULL and sails past any period_id check. The
--     refusal has to be about the DATE, not about the id.
--   * period_id is NULLable (a draft), so a CHECK over it admits UNKNOWN.
--   * the spec's own sketch at :2146 says "any insert or update ... with a
--     date inside it" — the DATE is the rule. The id is an optimisation the
--     prose suggests, and the prose wins (DECISIONS 21.3).
--
-- So the lock is a pair of BEFORE triggers per table, on expenses.expense_date,
-- payments.payment_date and client_invoices.invoice_date, refusing when the
-- row's date falls inside a period whose status is 'soft_closed' or 'closed'.
-- ('open' admits; 'soft_closed' is a lock, matching the ENUM member's name and
-- the route table's POST /api/finance/periods/:id/close.)
--
-- The lookup the triggers run is a range scan over accounting_periods by status
-- plus period dates, so it needs an index the spec never names:
--   KEY idx_period_lock (status, period_start, period_end)
-- idx_period_dates (period_start, period_end) exists but does not carry the
-- status predicate, and every trigger fires this query on every write to three
-- tables — the index is the cost of the lock and is added here.
--
-- The three period_id columns also gain their missing indexes (idx_exp_period,
-- idx_pay_period, idx_inv_period). The spec sketch names no KEY for them and
-- rule 7 says the lock is "enforced by a single indexed check" — which
-- presupposes an index that does not exist. This is the prose-versus-mechanism
-- divergence recorded in DECISIONS 25.2, proven by the four shapes in
-- tests/integration/period-lock.test.ts.
--
-- No client-side DELIMITER is used: migrate.mjs sends the file as one
-- multi-statement query, so the routine and trigger bodies keep their internal
-- semicolons and the statements are separated the way the server parser
-- expects. DROP ... IF EXISTS guards the retry case (the first attempt of this
-- migration applied the indexes and then failed at DELIMITER, before the
-- procedure existed).
--
-- The index additions use ADD INDEX IF NOT EXISTS for the same reason: the
-- failed first attempt left the period_id indexes in place on this database
-- (and idx_exp_period became the index backing fk_exp_period, so it cannot be
-- dropped without dropping the FK), while a fresh database — the test
-- database migrates separately — needs all four created.

ALTER TABLE accounting_periods
  ADD INDEX IF NOT EXISTS idx_period_lock (status, period_start, period_end);

ALTER TABLE expenses
  ADD INDEX IF NOT EXISTS idx_exp_period (period_id);

ALTER TABLE payments
  ADD INDEX IF NOT EXISTS idx_pay_period (period_id);

ALTER TABLE client_invoices
  ADD INDEX IF NOT EXISTS idx_inv_period (period_id);

DROP PROCEDURE IF EXISTS refuse_closed_period;

CREATE PROCEDURE refuse_closed_period(IN p_date DATE)
BEGIN
  DECLARE v_found INT DEFAULT 0;
  SELECT 1 INTO v_found
  FROM accounting_periods
  WHERE status IN ('soft_closed', 'closed')
    AND p_date BETWEEN period_start AND period_end
  LIMIT 1;
  IF v_found = 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'date falls inside a closed accounting period';
  END IF;
END;

CREATE TRIGGER trg_expenses_period_bi BEFORE INSERT ON expenses
FOR EACH ROW
BEGIN
  CALL refuse_closed_period(NEW.expense_date);
END;

CREATE TRIGGER trg_expenses_period_bu BEFORE UPDATE ON expenses
FOR EACH ROW
BEGIN
  CALL refuse_closed_period(NEW.expense_date);
END;

CREATE TRIGGER trg_payments_period_bi BEFORE INSERT ON payments
FOR EACH ROW
BEGIN
  CALL refuse_closed_period(NEW.payment_date);
END;

CREATE TRIGGER trg_payments_period_bu BEFORE UPDATE ON payments
FOR EACH ROW
BEGIN
  CALL refuse_closed_period(NEW.payment_date);
END;

CREATE TRIGGER trg_client_invoices_period_bi BEFORE INSERT ON client_invoices
FOR EACH ROW
BEGIN
  CALL refuse_closed_period(NEW.invoice_date);
END;

CREATE TRIGGER trg_client_invoices_period_bu BEFORE UPDATE ON client_invoices
FOR EACH ROW
BEGIN
  CALL refuse_closed_period(NEW.invoice_date);
END;