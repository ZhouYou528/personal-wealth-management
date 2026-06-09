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
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  target      REAL NOT NULL,
  current     REAL NOT NULL DEFAULT 0,            -- fallback when no accounts are linked
  deadline    TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#10B981',
  icon        TEXT NOT NULL DEFAULT '',
  account_ids TEXT,                                -- JSON array of account IDs whose
                                                   -- combined value auto-fills `current`
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Target allocation plans. User defines target percentages per asset kind
-- (stock/etf/mutual_fund/option/crypto/cash) and a scope (all accounts or a
-- specific subset). The app then surfaces drift between actual & target and
-- suggests rebalancing trades.
CREATE TABLE IF NOT EXISTS allocation_plans (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  scope_account_ids TEXT,                                   -- JSON array; null/empty = all
  targets           TEXT NOT NULL,                          -- JSON: { stock: 70, etf: 20, ... }
  drift_threshold   REAL NOT NULL DEFAULT 5,                -- absolute % drift to flag
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recurring transaction rules. The daily cron walks active rules and creates
-- real transactions when their schedule fires (catching up if the cron was
-- offline or the start_date is backdated). `last_fired` is the date most
-- recently materialized; `next_due = last_fired + frequency` (or `start_date`
-- if `last_fired` is null).
CREATE TABLE IF NOT EXISTS recurring_rules (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  tx_type     TEXT NOT NULL,           -- 'deposit' | 'withdraw' | 'buy' | etc.
  symbol      TEXT,                    -- nullable for cash flows
  kind        TEXT,
  qty         REAL,
  price       REAL,
  total       REAL NOT NULL,
  frequency   TEXT NOT NULL,           -- 'biweekly' | 'monthly' | 'quarterly'
  start_date  TEXT NOT NULL,
  end_date    TEXT,
  last_fired  TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  amount     REAL,
  note       TEXT
);

-- User-set "mark to market" prices for illiquid holdings (e.g. options).
-- Keyed by the holding id produced by computeHoldings:
--   stock/etf/crypto: "${account_id}:${symbol}"
--   option:           "${account_id}:${symbol}:${type}:${strike}:${expiry}"
CREATE TABLE IF NOT EXISTS holding_marks (
  holding_key TEXT PRIMARY KEY,
  price       REAL NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- snap_date primary-keyed nav values.
-- `source` = 'cost'   → cost-basis snapshot written by /api/nav/backfill (historical reconstruction)
-- `source` = 'market' → market-value snapshot written by the daily cron at 22:00 UTC
-- The backfill only deletes/rewrites 'cost' rows, so cron data accumulates permanently.
CREATE TABLE IF NOT EXISTS nav_snapshots (
  snap_date  TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  value      REAL NOT NULL,
  source     TEXT NOT NULL DEFAULT 'cost',
  PRIMARY KEY (snap_date, account_id)
);

-- Credit card churning tracker
CREATE TABLE IF NOT EXISTS credit_cards (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  issuer              TEXT NOT NULL,
  network             TEXT NOT NULL DEFAULT 'Visa',
  market              TEXT NOT NULL DEFAULT 'US',       -- 'US' | 'CA'
  status              TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'cancelled'
  open_date           TEXT NOT NULL,
  cancel_date         TEXT,
  annual_fee          REAL NOT NULL DEFAULT 0,
  first_year_free     INTEGER NOT NULL DEFAULT 0,
  bureau              TEXT NOT NULL DEFAULT 'Experian', -- Experian | Equifax | TransUnion
  hard_pull           INTEGER NOT NULL DEFAULT 1,
  bonus               INTEGER NOT NULL DEFAULT 0,       -- points
  currency            TEXT NOT NULL DEFAULT 'UR',       -- MR/UR/C1/TYP/Aeroplan/Avion/ScenePlus/Cash
  bonus_met           INTEGER NOT NULL DEFAULT 0,
  bonus_met_date      TEXT,
  min_spend_req       REAL NOT NULL DEFAULT 0,
  min_spend_deadline  TEXT,
  min_spend_current   REAL NOT NULL DEFAULT 0,
  points_balance      INTEGER NOT NULL DEFAULT 0,
  note                TEXT,
  c1                  TEXT NOT NULL DEFAULT '#1d6b4a',
  c2                  TEXT NOT NULL DEFAULT '#0f4530',
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO accounts (id, name, type, institution, color, number) VALUES
  ('acc_rrsp',   'RRSP',          'RRSP',            'Questrade',    '#10B981', '4421'),
  ('acc_tfsa',   'TFSA',          'TFSA',             'Wealthsimple', '#3B82F6', '8812'),
  ('acc_margin', 'Margin',        'Margin',            'IBKR',         '#7C3AED', '2290'),
  ('acc_crypto', 'Crypto Wallet', 'Crypto',            'Coinbase',     '#F97316', '9934'),
  ('acc_chq',    'Chequing',      'Cash',              'RBC',          '#A1A1AA', '1103'),
  ('acc_hisa',   'HISA',          'Non-registered',    'EQ Bank',      '#06B6D4', '5571');
