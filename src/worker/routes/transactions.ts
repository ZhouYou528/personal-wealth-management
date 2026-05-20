import { Hono } from "hono";
import { TransactionCreate } from "@shared/schemas";
import { dbAll, dbRun, getTransaction } from "../db/queries";
import type { Env } from "../types";

export const transactionsRoutes = new Hono<{ Bindings: Env }>();

transactionsRoutes.get("/", async (c) => {
  const account_id = c.req.query("account_id");
  const asset_id = c.req.query("asset_id");
  const type = c.req.query("type");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 1000);

  const where: string[] = [];
  const params: unknown[] = [];
  if (account_id) {
    where.push("account_id = ?");
    params.push(Number(account_id));
  }
  if (asset_id) {
    where.push("asset_id = ?");
    params.push(Number(asset_id));
  }
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  if (from) {
    where.push("trade_date >= ?");
    params.push(from);
  }
  if (to) {
    where.push("trade_date <= ?");
    params.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  const rows = await dbAll(
    c.env.DB,
    `SELECT * FROM transactions ${whereSql}
     ORDER BY trade_date DESC, id DESC
     LIMIT ?`,
    params,
  );
  return c.json(rows);
});

transactionsRoutes.post("/", async (c) => {
  const data = TransactionCreate.parse(await c.req.json());
  const res = await dbRun(
    c.env.DB,
    `INSERT INTO transactions
       (account_id, asset_id, type, trade_date, settle_date,
        quantity, price, fee, amount, fx_rate, notes, external_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.account_id,
      data.asset_id ?? null,
      data.type,
      data.trade_date,
      data.settle_date ?? null,
      data.quantity ?? 0,
      data.price ?? 0,
      data.fee ?? 0,
      data.amount,
      data.fx_rate ?? null,
      data.notes ?? null,
      data.external_ref ?? null,
    ],
  );
  const created = await getTransaction(c.env.DB, Number(res.meta.last_row_id));
  return c.json(created, 201);
});

transactionsRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await getTransaction(c.env.DB, id);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const patch = TransactionCreate.partial().parse(await c.req.json());
  const merged = { ...existing, ...patch };
  await dbRun(
    c.env.DB,
    `UPDATE transactions SET
      account_id = ?, asset_id = ?, type = ?, trade_date = ?, settle_date = ?,
      quantity = ?, price = ?, fee = ?, amount = ?, fx_rate = ?, notes = ?, external_ref = ?
     WHERE id = ?`,
    [
      merged.account_id,
      merged.asset_id ?? null,
      merged.type,
      merged.trade_date,
      merged.settle_date ?? null,
      merged.quantity ?? 0,
      merged.price ?? 0,
      merged.fee ?? 0,
      merged.amount,
      merged.fx_rate ?? null,
      merged.notes ?? null,
      merged.external_ref ?? null,
      id,
    ],
  );
  return c.json(await getTransaction(c.env.DB, id));
});

transactionsRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await dbRun(c.env.DB, "DELETE FROM transactions WHERE id = ?", [id]);
  return c.body(null, 204);
});
