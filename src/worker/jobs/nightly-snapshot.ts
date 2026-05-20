// Cron job: refresh prices, then write a NAV snapshot row for today.

import { computePositions } from "../lib/positions";
import { dbAll, dbRun } from "../db/queries";
import { getQuote, type AssetClassLite } from "../adapters/router";
import type { Env } from "../types";
import type { Asset } from "@shared/schemas";

export async function runNightlySnapshot(env: Env): Promise<void> {
  // 1. Refresh prices for everything held (skip cash; options best-effort).
  const heldAssets = await dbAll<Asset>(
    env.DB,
    `SELECT a.* FROM assets a
     WHERE a.asset_class NOT IN ('cash')
       AND a.id IN (
         SELECT DISTINCT asset_id FROM transactions WHERE asset_id IS NOT NULL
       )`,
  );

  for (const a of heldAssets) {
    try {
      const q = await getQuote(env, a.symbol, a.asset_class as AssetClassLite);
      await dbRun(
        env.DB,
        `INSERT INTO prices (asset_id, price, currency, as_of, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           price = excluded.price, currency = excluded.currency,
           as_of = excluded.as_of, source = excluded.source`,
        [a.id, q.price, q.currency, q.as_of, q.source],
      );
    } catch (e) {
      console.warn(`[cron] price refresh failed for ${a.symbol}:`, (e as Error).message);
    }
  }

  // 2. Compute net worth and write snapshot.
  const positions = await computePositions(env.DB);
  let total = 0;
  const breakdown: Record<string, number> = {};
  for (const p of positions) {
    if (p.market_value === null) continue;
    total += p.market_value;
    breakdown[p.asset_class] =
      (breakdown[p.asset_class] ?? 0) + p.market_value;
  }
  const today = new Date().toISOString().slice(0, 10);
  await dbRun(
    env.DB,
    `INSERT INTO nav_snapshots (date, total_value, breakdown_json)
     VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       total_value = excluded.total_value,
       breakdown_json = excluded.breakdown_json`,
    [today, total, JSON.stringify(breakdown)],
  );
  console.log(`[cron] snapshot ${today}: $${total.toFixed(2)}`);
}
