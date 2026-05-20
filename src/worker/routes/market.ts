import { Hono } from "hono";
import { dbAll, dbRun } from "../db/queries";
import { getQuote, type AssetClassLite } from "../adapters/router";
import type { Env } from "../types";
import type { Asset } from "@shared/schemas";

export const marketRoutes = new Hono<{ Bindings: Env }>();

marketRoutes.get("/quote", async (c) => {
  const symbol = c.req.query("symbol");
  const assetClass = (c.req.query("class") ?? "stock") as AssetClassLite;
  if (!symbol) return c.json({ error: "symbol required" }, 400);
  const q = await getQuote(c.env, symbol, assetClass);
  return c.json(q);
});

// POST /api/market/refresh — re-fetch quotes for every asset currently held.
marketRoutes.post("/refresh", async (c) => {
  // Held assets = assets that appear in any transaction with non-zero qty,
  // excluding cash (priced internally).
  const heldAssets = await dbAll<Asset>(
    c.env.DB,
    `SELECT a.* FROM assets a
     WHERE a.asset_class != 'cash'
       AND a.id IN (
         SELECT DISTINCT asset_id FROM transactions WHERE asset_id IS NOT NULL
       )`,
  );

  let refreshed = 0;
  let failed = 0;
  for (const a of heldAssets) {
    try {
      const q = await getQuote(c.env, a.symbol, a.asset_class as AssetClassLite);
      await dbRun(
        c.env.DB,
        `INSERT INTO prices (asset_id, price, currency, as_of, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           price = excluded.price,
           currency = excluded.currency,
           as_of = excluded.as_of,
           source = excluded.source`,
        [a.id, q.price, q.currency, q.as_of, q.source],
      );
      refreshed++;
    } catch (e) {
      console.warn(`[refresh] ${a.symbol}: ${(e as Error).message}`);
      failed++;
    }
  }
  return c.json({ refreshed, failed });
});
