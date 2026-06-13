-- Unified sync architecture: persist SnapTrade data into D1 so the live merge
-- in transactions.ts can be replaced by a single source of truth.
--
-- - Extends `transactions` with provenance + sync metadata so manual, CSV, and
--   SnapTrade-sourced rows can coexist in one table, deduped by (source, external_id).
-- - Adds two snapshot tables for positions/balances (overwritten on each sync).
-- - Adds `last_synced_at` to `accounts` so a 60s debounce can be enforced cheaply.

-- ── transactions: source attribution + sync metadata ──────────────
ALTER TABLE transactions ADD COLUMN source       TEXT    NOT NULL DEFAULT 'manual';
ALTER TABLE transactions ADD COLUMN external_id  TEXT;
ALTER TABLE transactions ADD COLUMN synced_at    TEXT;
ALTER TABLE transactions ADD COLUMN locked       INTEGER NOT NULL DEFAULT 0;

-- Partial unique index: dedup key for synced rows. NULL external_ids (manual)
-- are exempt so users can still create duplicate manual entries if needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_source_ext
  ON transactions(source, external_id)
  WHERE external_id IS NOT NULL;

-- ── accounts: per-account sync debounce ───────────────────────────
ALTER TABLE accounts ADD COLUMN last_synced_at TEXT;

-- ── snaptrade_positions: snapshot of holdings per account ─────────
-- DELETE-then-UPSERT pattern: each sync stamps synced_at, then we cull rows
-- with stale synced_at (closed positions). Equity + option in one table;
-- option contracts disambiguate via option_type+strike+expiry in the PK.
CREATE TABLE IF NOT EXISTS snaptrade_positions (
  account_id    TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  option_type   TEXT NOT NULL DEFAULT '',  -- '' for non-options
  strike        REAL NOT NULL DEFAULT 0,   -- 0 for non-options
  expiry        TEXT NOT NULL DEFAULT '',  -- '' for non-options
  kind          TEXT NOT NULL DEFAULT 'stock',
  qty           REAL NOT NULL,
  avg_cost      REAL,
  market_price  REAL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  underlying    TEXT,
  multiplier    REAL NOT NULL DEFAULT 1,
  synced_at     TEXT NOT NULL,
  PRIMARY KEY (account_id, symbol, option_type, strike, expiry)
);
CREATE INDEX IF NOT EXISTS idx_snap_pos_synced ON snaptrade_positions(synced_at);

-- ── snaptrade_balances: cash per account per currency ─────────────
CREATE TABLE IF NOT EXISTS snaptrade_balances (
  account_id    TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  cash          REAL NOT NULL DEFAULT 0,
  buying_power  REAL,
  synced_at     TEXT NOT NULL,
  PRIMARY KEY (account_id, currency)
);
