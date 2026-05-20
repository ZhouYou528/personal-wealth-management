// Thin SQL helpers. Kept simple — D1 is SQLite with prepared statements.

import type { Account, Asset, Transaction } from "@shared/schemas";

export type Row = Record<string, unknown>;

export async function dbAll<T = Row>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const stmt = db.prepare(sql).bind(...params);
  const { results } = await stmt.all<T>();
  return (results ?? []) as T[];
}

export async function dbFirst<T = Row>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const stmt = db.prepare(sql).bind(...params);
  return (await stmt.first<T>()) as T | null;
}

export async function dbRun(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<D1Result> {
  const stmt = db.prepare(sql).bind(...params);
  return stmt.run();
}

// --- Account helpers ---

export async function getAccount(db: D1Database, id: number): Promise<Account | null> {
  return dbFirst<Account>(db, "SELECT * FROM accounts WHERE id = ?", [id]);
}

export async function listAccountsRows(db: D1Database): Promise<Account[]> {
  return dbAll<Account>(db, "SELECT * FROM accounts ORDER BY name ASC");
}

// --- Asset helpers ---

export async function getAsset(db: D1Database, id: number): Promise<Asset | null> {
  return dbFirst<Asset>(db, "SELECT * FROM assets WHERE id = ?", [id]);
}

export async function findAssetBySymbol(
  db: D1Database,
  symbol: string,
  asset_class: string,
): Promise<Asset | null> {
  return dbFirst<Asset>(
    db,
    "SELECT * FROM assets WHERE symbol = ? AND asset_class = ?",
    [symbol.toUpperCase(), asset_class],
  );
}

export async function listAssetsRows(db: D1Database): Promise<Asset[]> {
  return dbAll<Asset>(db, "SELECT * FROM assets ORDER BY symbol ASC");
}

// --- Transaction helpers ---

export async function getTransaction(
  db: D1Database,
  id: number,
): Promise<Transaction | null> {
  return dbFirst<Transaction>(
    db,
    "SELECT * FROM transactions WHERE id = ?",
    [id],
  );
}
