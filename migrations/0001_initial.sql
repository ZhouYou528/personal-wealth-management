-- Initial schema for Personal Wealth Management.

CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,            -- brokerage | bank | crypto_exchange | wallet | retirement | other
  currency    TEXT NOT NULL DEFAULT 'USD',
  institution TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  name        TEXT,
  asset_class TEXT NOT NULL,            -- stock | etf | option | crypto | cash | bond | other
  currency    TEXT NOT NULL DEFAULT 'USD',
  -- Option-specific fields (nullable for non-options)
  underlying  TEXT,
  option_type TEXT,                     -- call | put
  strike      REAL,
  expiry      TEXT,
  multiplier  INTEGER DEFAULT 100,
  UNIQUE(symbol, asset_class)
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id     INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  type         TEXT NOT NULL,
  trade_date   TEXT NOT NULL,
  settle_date  TEXT,
  quantity     REAL NOT NULL DEFAULT 0,
  price        REAL NOT NULL DEFAULT 0,
  fee          REAL NOT NULL DEFAULT 0,
  amount       REAL NOT NULL,
  fx_rate      REAL,
  notes        TEXT,
  external_ref TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, trade_date);
CREATE INDEX IF NOT EXISTS idx_tx_asset       ON transactions(asset_id);
CREATE INDEX IF NOT EXISTS idx_tx_type        ON transactions(type);

CREATE TABLE IF NOT EXISTS prices (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  price    REAL NOT NULL,
  currency TEXT NOT NULL,
  as_of    TEXT NOT NULL,
  source   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  date     TEXT NOT NULL,
  close    REAL NOT NULL,
  PRIMARY KEY (asset_id, date)
);

CREATE TABLE IF NOT EXISTS nav_snapshots (
  date           TEXT PRIMARY KEY,        -- yyyy-mm-dd
  total_value    REAL NOT NULL,
  breakdown_json TEXT NOT NULL
);
