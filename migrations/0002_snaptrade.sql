-- SnapTrade integration

CREATE TABLE IF NOT EXISTS snaptrade_users (
  id                TEXT PRIMARY KEY DEFAULT 'singleton',
  snaptrade_user_id TEXT NOT NULL,
  user_secret       TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE accounts ADD COLUMN snaptrade_account_id TEXT;
