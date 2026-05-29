-- 0002_option_cash.sql
-- Create explicit companion cash transactions for all existing option transactions.
-- Premiums are now visible as deposit/withdraw entries in the transaction ledger.
-- After deploying this alongside the updated positions.ts (which no longer calls
-- adjustCash for buy/sell option), cash balances remain unchanged.

INSERT INTO transactions (id, tx_date, account_id, type, symbol, kind, total, note, created_at)
SELECT
  'otc' || lower(hex(randomblob(8))),
  tx_date,
  account_id,
  CASE WHEN type = 'sell_option' THEN 'deposit' ELSE 'withdraw' END,
  'CASH',
  'cash',
  total,
  '[opt-cash:' || id || '] Option premium · ' || COALESCE(symbol, ''),
  created_at
FROM transactions
WHERE type IN ('buy_option', 'sell_option')
  AND total != 0
  AND NOT EXISTS (
    SELECT 1 FROM transactions t2
    WHERE t2.note LIKE '[opt-cash:' || transactions.id || ']%'
  );
