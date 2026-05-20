import type { D1Database } from '@cloudflare/workers-types'
import type {
  Account, Transaction, WatchlistItem, Goal, CalendarEvent, NavSnapshot,
} from '@shared/types'

// ---------- Accounts ----------

export async function getAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all<Account>()
  return results
}

export async function getAccount(db: D1Database, id: string): Promise<Account | null> {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>()
}

export async function insertAccount(db: D1Database, a: Omit<Account, 'created_at'>): Promise<void> {
  await db.prepare(`
    INSERT INTO accounts (id, name, type, institution, color, number)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(a.id, a.name, a.type, a.institution, a.color, a.number).run()
}

export async function updateAccount(db: D1Database, id: string, a: Partial<Omit<Account, 'id' | 'created_at'>>): Promise<void> {
  const fields = Object.keys(a) as (keyof typeof a)[]
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => a[f])
  await db.prepare(`UPDATE accounts SET ${set} WHERE id = ?`).bind(...values, id).run()
}

export async function deleteAccount(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run()
}

// ---------- Transactions ----------

export async function getTransactions(
  db: D1Database,
  opts: { accountId?: string; symbol?: string; limit?: number; offset?: number } = {}
): Promise<Transaction[]> {
  let sql = 'SELECT * FROM transactions WHERE 1=1'
  const binds: unknown[] = []

  if (opts.accountId) { sql += ' AND account_id = ?'; binds.push(opts.accountId) }
  if (opts.symbol)    { sql += ' AND symbol = ?';     binds.push(opts.symbol) }

  sql += ' ORDER BY date DESC, created_at DESC'
  sql += ` LIMIT ${opts.limit ?? 200} OFFSET ${opts.offset ?? 0}`

  const { results } = await db.prepare(sql).bind(...binds).all<Transaction>()
  return results
}

export async function getAllTransactionsForHoldings(
  db: D1Database,
  accountId?: string
): Promise<Transaction[]> {
  let sql = 'SELECT * FROM transactions WHERE 1=1'
  const binds: unknown[] = []
  if (accountId) { sql += ' AND account_id = ?'; binds.push(accountId) }
  sql += ' ORDER BY date ASC, created_at ASC'
  const { results } = await db.prepare(sql).bind(...binds).all<Transaction>()
  return results
}

export async function getTransaction(db: D1Database, id: string): Promise<Transaction | null> {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first<Transaction>()
}

export async function insertTransaction(db: D1Database, t: Omit<Transaction, 'created_at'>): Promise<void> {
  await db.prepare(`
    INSERT INTO transactions
      (id, date, account_id, type, symbol, kind, qty, price, total, note,
       to_account, from_account, option_type, strike, expiry, underlying)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    t.id, t.date, t.account_id, t.type,
    t.symbol ?? null, t.kind ?? null,
    t.qty ?? null, t.price ?? null, t.total,
    t.note ?? null,
    t.to_account ?? null, t.from_account ?? null,
    t.option_type ?? null, t.strike ?? null,
    t.expiry ?? null, t.underlying ?? null
  ).run()
}

export async function updateTransaction(db: D1Database, id: string, t: Partial<Omit<Transaction, 'id' | 'created_at'>>): Promise<void> {
  const fields = Object.keys(t) as (keyof typeof t)[]
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => t[f] ?? null)
  await db.prepare(`UPDATE transactions SET ${set} WHERE id = ?`).bind(...values, id).run()
}

export async function deleteTransaction(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM transactions WHERE id = ?').bind(id).run()
}

// ---------- Watchlist ----------

export async function getWatchlist(db: D1Database): Promise<WatchlistItem[]> {
  const { results } = await db.prepare('SELECT * FROM watchlist ORDER BY added_at ASC').all<WatchlistItem>()
  return results
}

export async function insertWatchlistItem(db: D1Database, w: Omit<WatchlistItem, 'added_at'>): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO watchlist (id, symbol, name, kind) VALUES (?, ?, ?, ?)
  `).bind(w.id, w.symbol, w.name, w.kind).run()
}

export async function deleteWatchlistItem(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM watchlist WHERE id = ?').bind(id).run()
}

// ---------- Goals ----------

export async function getGoals(db: D1Database): Promise<Goal[]> {
  const { results } = await db.prepare('SELECT * FROM goals ORDER BY created_at ASC').all<Goal>()
  return results
}

export async function insertGoal(db: D1Database, g: Omit<Goal, 'created_at'>): Promise<void> {
  await db.prepare(`
    INSERT INTO goals (id, name, target, current, deadline, color, icon)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(g.id, g.name, g.target, g.current, g.deadline, g.color, g.icon).run()
}

export async function updateGoal(db: D1Database, id: string, g: Partial<Omit<Goal, 'id' | 'created_at'>>): Promise<void> {
  const fields = Object.keys(g) as (keyof typeof g)[]
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => g[f])
  await db.prepare(`UPDATE goals SET ${set} WHERE id = ?`).bind(...values, id).run()
}

export async function deleteGoal(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM goals WHERE id = ?').bind(id).run()
}

// ---------- Events ----------

export async function getEvents(db: D1Database): Promise<CalendarEvent[]> {
  const { results } = await db.prepare(
    'SELECT * FROM events WHERE date >= date("now") ORDER BY date ASC LIMIT 20'
  ).all<CalendarEvent>()
  return results
}

// ---------- NAV Snapshots ----------

export async function getNavSnapshots(
  db: D1Database,
  days = 365,
  accountId?: string
): Promise<NavSnapshot[]> {
  const id = accountId ?? ''
  const { results } = await db.prepare(
    `SELECT * FROM nav_snapshots WHERE account_id = ? AND date >= date('now', '-${days} days') ORDER BY date ASC`
  ).bind(id).all<NavSnapshot>()
  return results
}

export async function upsertNavSnapshot(db: D1Database, snap: NavSnapshot): Promise<void> {
  await db.prepare(`
    INSERT INTO nav_snapshots (date, account_id, value) VALUES (?, ?, ?)
    ON CONFLICT(date, account_id) DO UPDATE SET value = excluded.value
  `).bind(snap.date, snap.account_id ?? '', snap.value).run()
}
