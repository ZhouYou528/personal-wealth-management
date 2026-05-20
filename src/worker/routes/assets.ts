import { Hono } from "hono";
import { AssetCreate } from "@shared/schemas";
import {
  dbAll,
  dbRun,
  findAssetBySymbol,
  getAsset,
  listAssetsRows,
} from "../db/queries";
import type { Env } from "../types";

export const assetsRoutes = new Hono<{ Bindings: Env }>();

assetsRoutes.get("/", async (c) => {
  return c.json(await listAssetsRows(c.env.DB));
});

assetsRoutes.get("/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json([]);
  const rows = await dbAll(
    c.env.DB,
    `SELECT * FROM assets
     WHERE symbol LIKE ? OR name LIKE ?
     ORDER BY symbol ASC LIMIT 10`,
    [`${q.toUpperCase()}%`, `%${q}%`],
  );
  return c.json(rows);
});

assetsRoutes.post("/", async (c) => {
  const data = AssetCreate.parse(await c.req.json());
  await dbRun(
    c.env.DB,
    `INSERT OR IGNORE INTO assets
       (symbol, name, asset_class, currency, underlying, option_type, strike, expiry, multiplier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.symbol.toUpperCase(),
      data.name ?? null,
      data.asset_class,
      data.currency,
      data.underlying ?? null,
      data.option_type ?? null,
      data.strike ?? null,
      data.expiry ?? null,
      data.multiplier ?? null,
    ],
  );
  const created = await findAssetBySymbol(c.env.DB, data.symbol, data.asset_class);
  return c.json(created, 201);
});

assetsRoutes.get("/:id", async (c) => {
  const a = await getAsset(c.env.DB, Number(c.req.param("id")));
  if (!a) return c.json({ error: "Not found" }, 404);
  return c.json(a);
});
