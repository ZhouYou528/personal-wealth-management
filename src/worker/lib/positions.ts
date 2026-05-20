// Compute open positions from the transactions ledger.
// Cost basis: weighted-average. Sells reduce qty but keep avg_cost (until qty -> 0,
// then avg_cost resets to 0 on next buy).

import type { Position } from "@shared/schemas";
import { dbAll } from "../db/queries";

interface TxRow {
  id: number;
  account_id: number;
  asset_id: number | null;
  type: string;
  trade_date: string;
  quantity: number;
  price: number;
  fee: number;
  amount: number;
}

interface AssetRow {
  id: number;
  symbol: string;
  name: string | null;
  asset_class: string;
  currency: string;
}

interface AccountRow {
  id: number;
  name: string;
  currency: string;
}

interface PriceRow {
  asset_id: number;
  price: number;
  currency: string;
  as_of: string;
}

// Map (account_id, asset_id) -> running position
interface Running {
  qty: number;
  avg_cost: number;
  cost_basis: number; // qty * avg_cost (for convenience)
  last_tx_price: number; // for option mark fallback
}

const QTY_AFFECTING = new Set([
  "buy",
  "sell",
  "transfer_in",
  "transfer_out",
  "split",
  "option_exercise",
  "option_assignment",
  "option_expiry",
  "staking_reward",
  "airdrop",
  "gift_in",
  "gift_out",
  "adjustment",
]);

export async function computePositions(
  db: D1Database,
): Promise<Position[]> {
  const [txs, assets, accounts, prices] = await Promise.all([
    dbAll<TxRow>(
      db,
      `SELECT id, account_id, asset_id, type, trade_date, quantity, price, fee, amount
       FROM transactions
       WHERE asset_id IS NOT NULL
       ORDER BY trade_date ASC, id ASC`,
    ),
    dbAll<AssetRow>(db, `SELECT id, symbol, name, asset_class, currency FROM assets`),
    dbAll<AccountRow>(db, `SELECT id, name, currency FROM accounts`),
    dbAll<PriceRow>(db, `SELECT asset_id, price, currency, as_of FROM prices`),
  ]);

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const priceByAsset = new Map(prices.map((p) => [p.asset_id, p]));

  const running = new Map<string, Running>(); // key = `${account_id}:${asset_id}`

  for (const t of txs) {
    if (!t.asset_id) continue;
    if (!QTY_AFFECTING.has(t.type)) continue; // dividends don't change position
    const key = `${t.account_id}:${t.asset_id}`;
    const cur = running.get(key) ?? {
      qty: 0,
      avg_cost: 0,
      cost_basis: 0,
      last_tx_price: 0,
    };

    let qtyDelta = 0;
    let cashImpact = 0; // for cost-basis update (sign matters)

    switch (t.type) {
      case "buy":
      case "transfer_in":
      case "option_exercise":
      case "option_assignment":
        qtyDelta = +t.quantity;
        cashImpact = -(t.quantity * t.price + t.fee); // negative = money out
        break;
      case "sell":
      case "transfer_out":
        qtyDelta = -t.quantity;
        cashImpact = t.quantity * t.price - t.fee;
        break;
      case "split":
        // quantity field holds the multiplier ratio (e.g. 2 for 2-for-1)
        qtyDelta = cur.qty * (t.quantity - 1);
        cashImpact = 0;
        // Adjust avg cost so cost_basis stays constant.
        if (cur.qty + qtyDelta > 0 && cur.cost_basis !== 0) {
          cur.avg_cost = cur.cost_basis / (cur.qty + qtyDelta);
        }
        break;
      case "staking_reward":
      case "airdrop":
      case "gift_in":
        qtyDelta = +t.quantity;
        cashImpact = 0; // cost basis stays the same; these are "free" units
        break;
      case "gift_out":
      case "option_expiry":
        qtyDelta = -t.quantity;
        cashImpact = 0;
        break;
      case "adjustment":
        qtyDelta = t.quantity;
        cashImpact = t.amount;
        break;
    }

    const newQty = cur.qty + qtyDelta;

    if (qtyDelta > 0 && cashImpact < 0) {
      // Weighted-average cost update on buy-style increase.
      const newCostBasis = cur.cost_basis + Math.abs(cashImpact);
      cur.cost_basis = newCostBasis;
      cur.avg_cost = newQty > 0 ? newCostBasis / newQty : 0;
    } else if (qtyDelta < 0) {
      // Sell: reduce cost basis proportionally; avg_cost unchanged until qty=0.
      const removed = Math.min(Math.abs(qtyDelta), cur.qty) * cur.avg_cost;
      cur.cost_basis = Math.max(0, cur.cost_basis - removed);
      if (newQty <= 0) {
        cur.cost_basis = 0;
        cur.avg_cost = 0;
      }
    }

    cur.qty = newQty;
    if (t.price > 0) cur.last_tx_price = t.price;
    running.set(key, cur);
  }

  const positions: Position[] = [];
  for (const [key, r] of running) {
    if (Math.abs(r.qty) < 1e-9) continue; // closed position
    const [accIdStr, assetIdStr] = key.split(":");
    const accId = Number(accIdStr);
    const assetId = Number(assetIdStr);
    const a = assetById.get(assetId);
    const acc = accountById.get(accId);
    if (!a || !acc) continue;

    const priceRow = priceByAsset.get(assetId);
    let current_price: number | null = priceRow?.price ?? null;
    let price_as_of: string | null = priceRow?.as_of ?? null;
    // For options on free tier, fall back to last transaction price as the mark.
    if (current_price === null && a.asset_class === "option") {
      current_price = r.last_tx_price || null;
      price_as_of = price_as_of ?? null;
    }
    const multiplier =
      a.asset_class === "option" ? 100 : 1; // honor option contract multiplier

    const market_value =
      current_price !== null ? current_price * r.qty * multiplier : null;
    const unrealized_pl =
      market_value !== null
        ? market_value - r.cost_basis
        : null;
    const unrealized_pl_pct =
      unrealized_pl !== null && r.cost_basis > 0
        ? unrealized_pl / r.cost_basis
        : null;

    positions.push({
      asset_id: assetId,
      symbol: a.symbol,
      name: a.name,
      asset_class: a.asset_class as Position["asset_class"],
      account_id: accId,
      account_name: acc.name,
      quantity: r.qty,
      avg_cost: r.avg_cost,
      cost_basis: r.cost_basis,
      current_price,
      market_value,
      unrealized_pl,
      unrealized_pl_pct,
      price_as_of,
    });
  }

  // Cash positions: balance per cash account = sum(amount) of all txs for that account
  // for which asset_id IS NULL (and also adjust for buy/sell cash effects? No —
  // those move cash and we model them via separate transfer/withdraw/deposit
  // entries by convention. To simplify v1, we compute cash = sum(amount) across
  // all transactions of that account, which naturally includes buys/sells.)
  const cashByAccount = await dbAll<{ account_id: number; cash: number }>(
    db,
    `SELECT account_id, COALESCE(SUM(amount), 0) AS cash
     FROM transactions
     GROUP BY account_id`,
  );
  for (const { account_id, cash } of cashByAccount) {
    const acc = accountById.get(account_id);
    if (!acc) continue;
    if (Math.abs(cash) < 0.005) continue;
    positions.push({
      asset_id: -account_id, // synthetic id so the row has a stable key
      symbol: `${acc.currency} cash`,
      name: `${acc.name} cash balance`,
      asset_class: "cash",
      account_id,
      account_name: acc.name,
      quantity: cash,
      avg_cost: 1,
      cost_basis: cash,
      current_price: 1,
      market_value: cash,
      unrealized_pl: 0,
      unrealized_pl_pct: 0,
      price_as_of: new Date().toISOString(),
    });
  }

  return positions.sort(
    (a, b) => (b.market_value ?? 0) - (a.market_value ?? 0),
  );
}
