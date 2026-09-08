-- 022_place_of_supply.sql
-- The owner question in DECISIONS 17.3, settled as current behaviour for the
-- owner to correct: there is no place-of-supply field anywhere, so §6.8
-- rule 5's "GST split by place of supply (intra-Karnataka is CGST plus SGST,
-- inter-state is IGST)" has no source. The application layer supplies 'KA'
-- explicitly on every invoice insert (see src/modules/finance/service.ts and
-- DECISIONS 27.4), never a schema default.
--
-- Why NOT NULL with NO DEFAULT, and not DEFAULT 'KA': a default would make
-- 'KA' the silent answer for every insert that omits the column — including
-- the one where the client is registered in Maharashtra and the invoice is
-- inter-state. The same reasoning migration 016 applied to work_type: a
-- sentinel default keeps the sentinel reachable where it would mean
-- something, and here 'KA' by omission would mean "intra-state" for a row
-- where nobody decided that. With no default, omitting the column is refused
-- and every row states its place of supply as a recorded decision.
--
-- Shape: CHAR(2), upper-case letters only, CHECK-constrained. The GST state
-- codes are two characters ('KA', 'MH', 'TN', ...); the CHECK refuses
-- anything else at the database level rather than by convention. The full
-- code list is deliberately NOT enumerated in the CHECK — a new state code
-- is reference data, not a schema change, and the application layer
-- validates against its own list (src/modules/finance/schemas.ts). The
-- constraint here is the shape: exactly two upper-case letters.
--
-- The REGEXP is evaluated BINARY on purpose: MariaDB's REGEXP follows the
-- column's collation, which is case-insensitive here, so a plain
-- `regexp '^[A-Z]{2}$'` ADMITS 'ka' (proven by insert against the live
-- server on 2026-09-08 — the first draft of this migration shipped that
-- hole). CAST to BINARY makes the comparison case-sensitive and the CHECK
-- does what its text says.

ALTER TABLE client_invoices
  ADD COLUMN place_of_supply CHAR(2) NOT NULL AFTER invoice_date,
  ADD CONSTRAINT chk_inv_pos_shape CHECK (CAST(place_of_supply AS BINARY) REGEXP '^[A-Z]{2}$');
