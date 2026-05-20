-- Optional dev seed. Run with: npm run db:seed:local

INSERT INTO accounts (name, type, currency, institution) VALUES
  ('Schwab Brokerage', 'brokerage', 'USD', 'Charles Schwab'),
  ('Chase Checking',   'bank',      'USD', 'JPMorgan Chase'),
  ('Coinbase',         'crypto_exchange', 'USD', 'Coinbase');

INSERT INTO assets (symbol, name, asset_class, currency) VALUES
  ('AAPL', 'Apple Inc.', 'stock', 'USD'),
  ('VOO',  'Vanguard S&P 500 ETF', 'etf', 'USD'),
  ('BTC',  'Bitcoin',  'crypto', 'USD');

-- Sample transactions
INSERT INTO transactions (account_id, asset_id, type, trade_date, quantity, price, fee, amount, notes) VALUES
  (1, 1, 'buy',     '2025-09-15', 10, 220.00, 1.00, -2201.00, 'Sample AAPL buy'),
  (1, 2, 'buy',     '2025-10-01', 5,  500.00, 1.00, -2501.00, 'Sample VOO buy'),
  (1, 1, 'dividend','2026-02-15', 0,  2.50,   0,    25.00,    'AAPL dividend'),
  (2, NULL, 'deposit',  '2025-09-01', 0, 5000, 0, 5000, 'Initial deposit'),
  (2, NULL, 'interest', '2026-01-31', 0, 12.34, 0, 12.34, 'Monthly interest'),
  (3, 3, 'buy', '2025-11-05', 0.05, 70000, 0, -3500, 'BTC purchase');
