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
  if (fields.length === 0) return
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
  opts: { accountId?: string; symbol?: string; limit?: number; offset?: number; since?: string } = {}
): Promise<Transaction[]> {
  let sql = 'SELECT * FROM transactions WHERE 1=1'
  const binds: unknown[] = []

  if (opts.accountId) { sql += ' AND account_id = ?'; binds.push(opts.accountId) }
  if (opts.symbol)    { sql += ' AND symbol = ?';     binds.push(opts.symbol) }
  if (opts.since)     { sql += ' AND tx_date >= ?';   binds.push(opts.since) }

  sql += ' ORDER BY tx_date DESC, created_at DESC'
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
  sql += ' ORDER BY tx_date ASC, created_at ASC'
  const { results } = await db.prepare(sql).bind(...binds).all<Transaction>()
  return results
}

export async function getTransaction(db: D1Database, id: string): Promise<Transaction | null> {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first<Transaction>()
}

export async function insertTransaction(db: D1Database, t: Omit<Transaction, 'created_at'>): Promise<void> {
  await db.prepare(`
    INSERT INTO transactions
      (id, tx_date, account_id, type, symbol, kind, qty, price, total, note,
       to_account, from_account, option_type, strike, expiry, underlying)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    t.id, t.tx_date, t.account_id, t.type,
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
  if (fields.length === 0) return
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => t[f] ?? null)
  await db.prepare(`UPDATE transactions SET ${set} WHERE id = ?`).bind(...values, id).run()
}

export async function deleteTransaction(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM transactions WHERE id = ?').bind(id).run()
}

export async function updateTransactionsBySymbol(
  db: D1Database,
  symbol: string,
  patch: Partial<Pick<Transaction, 'kind'>>,
  accountId?: string,
): Promise<number> {
  const fields = Object.keys(patch) as (keyof typeof patch)[]
  if (fields.length === 0) return 0
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => patch[f] ?? null)
  let sql = `UPDATE transactions SET ${set} WHERE symbol = ?`
  const binds: unknown[] = [...values, symbol]
  if (accountId) { sql += ' AND account_id = ?'; binds.push(accountId) }
  const result = await db.prepare(sql).bind(...binds).run()
  return result.meta?.changes ?? 0
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

type GoalRow = Omit<Goal, 'account_ids'> & { account_ids: string | null }

function parseGoal(row: GoalRow): Goal {
  let ids: string[] | undefined
  if (row.account_ids) {
    try { ids = JSON.parse(row.account_ids) } catch { ids = undefined }
  }
  return { ...row, account_ids: ids }
}

export async function getGoals(db: D1Database): Promise<Goal[]> {
  const { results } = await db.prepare('SELECT * FROM goals ORDER BY created_at ASC').all<GoalRow>()
  return results.map(parseGoal)
}

export async function insertGoal(db: D1Database, g: Omit<Goal, 'created_at'>): Promise<void> {
  const accountIdsJSON = g.account_ids && g.account_ids.length > 0 ? JSON.stringify(g.account_ids) : null
  await db.prepare(`
    INSERT INTO goals (id, name, target, current, deadline, color, icon, account_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(g.id, g.name, g.target, g.current, g.deadline, g.color, g.icon, accountIdsJSON).run()
}

export async function updateGoal(db: D1Database, id: string, g: Partial<Omit<Goal, 'id' | 'created_at'>>): Promise<void> {
  const fields = Object.keys(g) as (keyof typeof g)[]
  if (fields.length === 0) return
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => {
    const v = g[f]
    // Serialize the array column before binding
    if (f === 'account_ids') return Array.isArray(v) && v.length > 0 ? JSON.stringify(v) : null
    return v ?? null
  })
  await db.prepare(`UPDATE goals SET ${set} WHERE id = ?`).bind(...values, id).run()
}

export async function deleteGoal(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM goals WHERE id = ?').bind(id).run()
}

// ---------- Events ----------

export async function getEvents(db: D1Database): Promise<CalendarEvent[]> {
  const { results } = await db.prepare(
    'SELECT * FROM events WHERE event_date >= date("now") ORDER BY event_date ASC LIMIT 20'
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
    `SELECT snap_date, account_id, value, source FROM nav_snapshots
       WHERE account_id = ? AND snap_date >= date('now', '-${days} days')
       ORDER BY snap_date ASC`
  ).bind(id).all<NavSnapshot>()
  return results
}

export async function upsertNavSnapshot(db: D1Database, snap: NavSnapshot): Promise<void> {
  const source = snap.source ?? 'cost'
  await db.prepare(`
    INSERT INTO nav_snapshots (snap_date, account_id, value, source) VALUES (?, ?, ?, ?)
    ON CONFLICT(snap_date, account_id) DO UPDATE SET value = excluded.value, source = excluded.source
  `).bind(snap.snap_date, snap.account_id ?? '', snap.value, source).run()
}

// ---------- Holding marks (user-set current prices) ----------

export async function getHoldingMarks(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT holding_key, price FROM holding_marks').all<{
    holding_key: string; price: number;
  }>()
  const map: Record<string, number> = {}
  for (const r of results) map[r.holding_key] = r.price
  return map
}

export async function upsertHoldingMark(db: D1Database, holdingKey: string, price: number): Promise<void> {
  await db.prepare(`
    INSERT INTO holding_marks (holding_key, price, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(holding_key) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at
  `).bind(holdingKey, price).run()
}

export async function deleteHoldingMark(db: D1Database, holdingKey: string): Promise<void> {
  await db.prepare('DELETE FROM holding_marks WHERE holding_key = ?').bind(holdingKey).run()
}
