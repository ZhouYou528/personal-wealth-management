import { Hono } from "hono";
import { AccountCreate } from "@shared/schemas";
import { dbAll, dbFirst, dbRun, getAccount } from "../db/queries";
import type { Env } from "../types";

export const accountsRoutes = new Hono<{ Bindings: Env }>();

accountsRoutes.get("/", async (c) => {
  const rows = await dbAll(c.env.DB, "SELECT * FROM accounts ORDER BY name ASC");
  return c.json(rows);
});

accountsRoutes.post("/", async (c) => {
  const data = AccountCreate.parse(await c.req.json());
  const res = await dbRun(
    c.env.DB,
    `INSERT INTO accounts (name, type, currency, institution)
     VALUES (?, ?, ?, ?)`,
    [data.name, data.type, data.currency, data.institution ?? null],
  );
  const id = res.meta.last_row_id;
  const created = await getAccount(c.env.DB, Number(id));
  return c.json(created, 201);
});

accountsRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const data = AccountCreate.partial().parse(await c.req.json());
  const existing = await getAccount(c.env.DB, id);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const merged = { ...existing, ...data };
  await dbRun(
    c.env.DB,
    `UPDATE accounts SET name = ?, type = ?, currency = ?, institution = ?
     WHERE id = ?`,
    [
      merged.name,
      merged.type,
      merged.currency,
      merged.institution ?? null,
      id,
    ],
  );
  return c.json(await getAccount(c.env.DB, id));
});

accountsRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // Check for transactions referencing this account
  const tx = await dbFirst<{ n: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?",
    [id],
  );
  if (tx && tx.n > 0) {
    return c.json(
      {
        error: `Account has ${tx.n} transaction(s). Delete transactions first.`,
      },
      409,
    );
  }
  await dbRun(c.env.DB, "DELETE FROM accounts WHERE id = ?", [id]);
  return c.body(null, 204);
});
