-- Rename snaptrade_* → broker_* now that both SnapTrade AND IBKR Flex write
-- to these tables. The original names predate the IBKR integration and are
-- misleading.

ALTER TABLE snaptrade_positions RENAME TO broker_positions;
ALTER TABLE snaptrade_balances  RENAME TO broker_balances;
