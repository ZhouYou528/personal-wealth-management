CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  institution TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#10B981',
  number      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  tx_date      TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  symbol       TEXT,
  kind         TEXT,
  qty          REAL,
  price        REAL,
  total        REAL NOT NULL,
  note         TEXT,
  to_account   TEXT,
  from_account TEXT,
  option_type  TEXT,
  strike       REAL,
  expiry       TEXT,
  underlying   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_date    ON transactions(tx_date);
CREATE INDEX IF NOT EXISTS idx_tx_symbol  ON transactions(symbol);

CREATE TABLE IF NOT EXISTS watchlist (
  id       TEXT PRIMARY KEY,
  symbol   TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'stock',
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  target     REAL NOT NULL,
  current    REAL NOT NULL DEFAULT 0,
  deadline   TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#10B981',
  icon       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  amount     REAL,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS nav_snapshots (
  snap_date  TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  value      REAL NOT NULL,
  PRIMARY KEY (snap_date, account_id)
);

INSERT OR IGNORE INTO accounts (id, name, type, institution, color, number) VALUES
  ('acc_rrsp',   'RRSP',          'RRSP',            'Questrade',    '#10B981', '4421'),
  ('acc_tfsa',   'TFSA',          'TFSA',             'Wealthsimple', '#3B82F6', '8812'),
  ('acc_margin', 'Margin',        'Margin',            'IBKR',         '#7C3AED', '2290'),
  ('acc_crypto', 'Crypto Wallet', 'Crypto',            'Coinbase',     '#F97316', '9934'),
  ('acc_chq',    'Chequing',      'Cash',              'RBC',          '#A1A1AA', '1103'),
  ('acc_hisa',   'HISA',          'Non-registered',    'EQ Bank',      '#06B6D4', '5571');
