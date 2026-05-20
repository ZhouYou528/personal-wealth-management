-- Meridian: Personal Wealth Management
-- Run: npm run migrate:local  (development)
--      npm run migrate:prod   (production)

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('RRSP','TFSA','FHSA','RESP','Margin','Cash','Crypto','Non-registered')),
  institution TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#10B981',
  number      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK(type IN (
    'buy','sell','buy_option','sell_option','buy_crypto','sell_crypto',
    'deposit','withdraw','transfer','dividend','interest','recurring'
  )),
  symbol       TEXT,
  kind         TEXT CHECK(kind IN ('stock','etf','option','crypto','cash')),
  qty          REAL,
  price        REAL,
  total        REAL NOT NULL,
  note         TEXT,
  -- Transfer fields
  to_account   TEXT REFERENCES accounts(id),
  from_account TEXT REFERENCES accounts(id),
  -- Option fields
  option_type  TEXT CHECK(option_type IN ('call','put')),
  strike       REAL,
  expiry       TEXT,
  underlying   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_date    ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_symbol  ON transactions(symbol);

CREATE TABLE IF NOT EXISTS watchlist (
  id         TEXT PRIMARY KEY,
  symbol     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'stock' CHECK(kind IN ('stock','etf','crypto','cash')),
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  target      REAL NOT NULL,
  current     REAL NOT NULL DEFAULT 0,
  deadline    TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#10B981',
  icon        TEXT NOT NULL DEFAULT '🎯',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id      TEXT PRIMARY KEY,
  date    TEXT NOT NULL,
  symbol  TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK(kind IN ('dividend','earnings','expiry')),
  amount  REAL,
  note    TEXT
);

-- Daily portfolio value snapshots — used for the Dashboard area chart.
-- account_id = '' means the all-accounts aggregate row.
CREATE TABLE IF NOT EXISTS nav_snapshots (
  date       TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  value      REAL NOT NULL,
  PRIMARY KEY (date, account_id)
);

-- Seed data: six representative accounts
INSERT OR IGNORE INTO accounts (id, name, type, institution, color, number) VALUES
  ('acc_rrsp',   'RRSP',          'RRSP',            'Questrade',      '#10B981', '•• 4421'),
  ('acc_tfsa',   'TFSA',          'TFSA',            'Wealthsimple',   '#3B82F6', '•• 8812'),
  ('acc_margin', 'Margin',        'Margin',          'IBKR',           '#7C3AED', '•• 2290'),
  ('acc_crypto', 'Crypto Wallet', 'Crypto',          'Coinbase',       '#F97316', '•• 9934'),
  ('acc_chq',    'Chequing',      'Cash',            'RBC',            '#A1A1AA', '•• 1103'),
  ('acc_hisa',   'HISA',          'Non-registered',  'EQ Bank',        '#06B6D4', '•• 5571');
