import { Hono } from "hono";
import { dbAll } from "../db/queries";
import { computePositions } from "../lib/positions";
import type { Env } from "../types";

export const portfolioRoutes = new Hono<{ Bindings: Env }>();

portfolioRoutes.get("/positions", async (c) => {
  const positions = await computePositions(c.env.DB);
  return c.json(positions);
});

portfolioRoutes.get("/net-worth", async (c) => {
  const positions = await computePositions(c.env.DB);
  let total = 0;
  const byClass: Record<string, number> = {};
  const stale: { symbol: string; reason: string }[] = [];
  const TWO_DAYS_MS = 2 * 24 * 3600 * 1000;
  const now = Date.now();

  for (const p of positions) {
    if (p.market_value === null) {
      stale.push({ symbol: p.symbol, reason: "no current price" });
      continue;
    }
    total += p.market_value;
    byClass[p.asset_class] = (byClass[p.asset_class] ?? 0) + p.market_value;
    if (p.price_as_of) {
      const age = now - new Date(p.price_as_of).getTime();
      if (age > TWO_DAYS_MS && p.asset_class !== "cash") {
        stale.push({
          symbol: p.symbol,
          reason: `price > ${Math.floor(age / 86400000)}d old`,
        });
      }
    }
  }

  return c.json({
    total,
    by_class: byClass,
    as_of: new Date().toISOString(),
    stale_assets: stale,
  });
});

portfolioRoutes.get("/nav-history", async (c) => {
  const range = c.req.query("range") ?? "3M";
  let cutoff: string;
  const today = new Date();
  switch (range) {
    case "1M":
      cutoff = new Date(today.getTime() - 31 * 86400000)
        .toISOString()
        .slice(0, 10);
      break;
    case "3M":
      cutoff = new Date(today.getTime() - 93 * 86400000)
        .toISOString()
        .slice(0, 10);
      break;
    case "1Y":
      cutoff = new Date(today.getTime() - 366 * 86400000)
        .toISOString()
        .slice(0, 10);
      break;
    case "ALL":
    default:
      cutoff = "1970-01-01";
  }
  const rows = await dbAll<{ date: string; total_value: number }>(
    c.env.DB,
    `SELECT date, total_value FROM nav_snapshots
     WHERE date >= ? ORDER BY date ASC`,
    [cutoff],
  );
  return c.json(rows.map((r) => ({ date: r.date, total: r.total_value })));
});
