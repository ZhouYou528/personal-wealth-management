// Unified SnapTrade → D1 sync.
//
// Responsibilities:
//   - syncActivities  → insert new transactions (dedup by source+external_id)
//   - syncPositions   → upsert broker_positions, cull stale rows
//   - syncBalances    → upsert broker_balances
//   - syncAccount     → all three, used by the admin/refresh endpoint
//   - REFRESH_DEBOUNCE_S enforced via accounts.last_synced_at
//
// Cost characteristics: each per-account sync makes at most 3 SnapTrade calls
// (activities + positions/all + balances) and writes only changed rows.

import type { TxType, AssetKind } from '@shared/types'
import { createSnapClient, type SnapActivity, type SnapUser, type SnapUnifiedPosition, type SnapBalance } from './snaptrade'
import { isEtfSymbol, isMutualFundSymbol } from '../../shared/etf-list'

export const REFRESH_DEBOUNCE_S = 60

const SNAP_TX_TYPE: Record<string, TxType> = {
  BUY: 'buy', SELL: 'sell',
  DIVIDEND: 'dividend', DIV: 'dividend', DIVIDENDS: 'dividend',
  REINVEST_DIVIDEND: 'buy', REINVEST: 'buy',
  INTEREST: 'interest',
  DEPOSIT: 'deposit', CONTRIBUTION: 'deposit',
  WITHDRAWAL: 'withdraw', WITHDRAW: 'withdraw',
  TRANSFER: 'transfer', TRANSFER_IN: 'transfer_in', TRANSFER_OUT: 'transfer_out',
  FEE: 'deposit',
}

function activityToTxType(type: string): TxType {
  return SNAP_TX_TYPE[type.toUpperCase()] ?? 'deposit'
}

function activityToKind(a: SnapActivity): AssetKind | undefined {
  if (a.option_symbol) return 'option'
  if (!a.symbol) return undefined
  const t = (a.symbol.type?.description ?? a.symbol.type?.code ?? '').toLowerCase()
  if (t.includes('etf')) return 'etf'
  if (t.includes('crypto')) return 'crypto'
  if (t.includes('mutual')) return 'mutual_fund'
  if (t.includes('option')) return 'option'
  return 'stock'
}

function instrumentKindToAssetKind(kind: string | undefined): AssetKind {
  switch ((kind ?? '').toLowerCase()) {
    case 'option':     return 'option'
    case 'crypto':     return 'crypto'
    case 'etf':        return 'etf'
    case 'mutualfund': return 'mutual_fund'
    case 'stock':
    case 'adr':
    case 'cef':
    default:           return 'stock'
  }
}

export interface SyncResult {
  activities_inserted: number
  positions_upserted:  number
  positions_culled:    number
  balances_upserted:   number
  errors:              string[]
}

// ── Activities ────────────────────────────────────────────────────
// Append-only: insert new SnapTrade activities as transactions rows.
// Dedup by (source='snaptrade', external_id=snap_activity_id).
export async function syncActivities(
  db: D1Database,
  snap: ReturnType<typeof createSnapClient>,
  userAuth: SnapUser,
  d1AccountId: string,
  snapAccountId: string,
  startDate?: string,  // ISO YYYY-MM-DD; default = no lower bound (full history)
): Promise<{ inserted: number; errors: string[] }> {
  const errors: string[] = []
  const endDate = new Date().toISOString().slice(0, 10)
  const nowISO  = new Date().toISOString()

  let activities: SnapActivity[]
  try {
    activities = await snap.getAccountActivities(userAuth, snapAccountId, startDate, endDate)
  } catch (e) {
    errors.push(`getAccountActivities: ${String(e)}`)
    try {
      const all = await snap.getActivities(userAuth, startDate, endDate, snapAccountId)
      activities = all.filter(a => a.account.id === snapAccountId)
    } catch (e2) {
      errors.push(`getActivities fallback: ${String(e2)}`)
      return { inserted: 0, errors }
    }
  }

  if (activities.length === 0) return { inserted: 0, errors }

  // INSERT OR IGNORE relies on the unique index (source, external_id).
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (
      id, tx_date, account_id, type, symbol, kind, qty, price, total, note,
      option_type, strike, expiry, underlying,
      source, external_id, synced_at, created_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'snaptrade',?,?,?)
  `)

  const batch: D1PreparedStatement[] = []
  for (const a of activities) {
    const date = (a.trade_date ?? a.settlement_date ?? '').slice(0, 10)
    if (!date) continue
    const optSym = a.option_symbol ?? null
    const sym = optSym
      ? (optSym.underlying_symbol?.symbol ?? a.symbol?.symbol ?? null)
      : (a.symbol?.symbol ?? null)
    const qty = Math.abs(a.units)
    const txId = `snap_${a.id}`

    batch.push(stmt.bind(
      txId,
      date,
      d1AccountId,
      activityToTxType(a.type),
      sym ?? null,
      activityToKind(a) ?? null,
      qty || null,
      a.price || null,
      Math.abs(a.amount),
      a.description || null,
      optSym ? ((optSym.option_type ?? '').toLowerCase() === 'put' ? 'put' : 'call') : null,
      optSym ? (Number(optSym.strike_price) || null) : null,
      optSym ? ((optSym.expiration_date ?? '').slice(0, 10) || null) : null,
      optSym ? (optSym.underlying_symbol?.symbol ?? null) : null,
      a.id,         // external_id
      nowISO,       // synced_at
      date,         // created_at (fall back to tx date — we don't have the create time)
    ))
  }

  if (batch.length === 0) return { inserted: 0, errors }

  const results = await db.batch(batch)
  const inserted = results.reduce((s, r) => s + (r.meta?.changes ?? 0), 0)
  return { inserted, errors }
}

// ── Positions ─────────────────────────────────────────────────────
// Upsert all current positions, then cull rows that weren't touched
// (their synced_at is < this run's marker → position was closed).
export async function syncPositions(
  db: D1Database,
  snap: ReturnType<typeof createSnapClient>,
  userAuth: SnapUser,
  d1AccountId: string,
  snapAccountId: string,
): Promise<{ upserted: number; culled: number; errors: string[] }> {
  const errors: string[] = []
  const nowISO = new Date().toISOString()

  let positions: SnapUnifiedPosition[]
  try {
    positions = await snap.getAccountAllPositions(userAuth, snapAccountId)
  } catch (e) {
    errors.push(`getAccountAllPositions: ${String(e)}`)
    return { upserted: 0, culled: 0, errors }
  }

  const upsert = db.prepare(`
    INSERT INTO broker_positions (
      account_id, symbol, option_type, strike, expiry, kind, qty, avg_cost,
      market_price, currency, underlying, multiplier, synced_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id, symbol, option_type, strike, expiry) DO UPDATE SET
      kind         = excluded.kind,
      qty          = excluded.qty,
      avg_cost     = excluded.avg_cost,
      market_price = excluded.market_price,
      currency     = excluded.currency,
      underlying   = excluded.underlying,
      multiplier   = excluded.multiplier,
      synced_at    = excluded.synced_at
  `)

  const batch: D1PreparedStatement[] = []
  for (const p of positions) {
    let kind = instrumentKindToAssetKind(p.instrument?.kind)
    const isOption = kind === 'option'
    const sym = isOption
      ? (p.instrument?.underlying?.symbol ?? p.instrument?.symbol ?? null)
      : (p.instrument?.symbol ?? p.instrument?.raw_symbol ?? null)
    if (!sym) continue
    // Symbol-based overrides for cases where SnapTrade reports the wrong
    // instrument kind (e.g. 401k target-date funds reported as "stock").
    if (kind === 'stock') {
      if (isMutualFundSymbol(sym)) kind = 'mutual_fund'
      else if (isEtfSymbol(sym))   kind = 'etf'
    }

    const optType = isOption
      ? ((p.instrument?.option_type ?? '').toLowerCase() === 'put' ? 'put' : 'call')
      : ''
    const strike = isOption ? (Number(p.instrument?.strike_price) || 0) : 0
    const expiry = isOption ? ((p.instrument?.expiration_date ?? '').slice(0, 10)) : ''

    const currency = typeof p.instrument?.currency === 'string'
      ? p.instrument.currency
      : (p.instrument?.currency?.code ?? p.currency ?? 'USD')

    batch.push(upsert.bind(
      d1AccountId,
      sym,
      optType,
      strike,
      expiry,
      kind,
      Number(p.units) || 0,
      p.cost_basis != null ? Number(p.cost_basis) || null : null,
      p.price      != null ? Number(p.price)      || null : null,
      currency,
      isOption ? (p.instrument?.underlying?.symbol ?? null) : null,
      Number(p.instrument?.multiplier) || (isOption ? 100 : 1),
      nowISO,
    ))
  }

  let upserted = 0
  if (batch.length > 0) {
    const results = await db.batch(batch)
    upserted = results.length
  }

  // Cull anything not touched this run (closed positions).
  const culled = await db
    .prepare('DELETE FROM broker_positions WHERE account_id = ? AND synced_at < ?')
    .bind(d1AccountId, nowISO)
    .run()

  return { upserted, culled: culled.meta.changes ?? 0, errors }
}

// ── Balances ──────────────────────────────────────────────────────
export async function syncBalances(
  db: D1Database,
  snap: ReturnType<typeof createSnapClient>,
  userAuth: SnapUser,
  d1AccountId: string,
  snapAccountId: string,
): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = []
  const nowISO = new Date().toISOString()

  let balances: SnapBalance[]
  try {
    balances = await snap.getAccountBalances(userAuth, snapAccountId)
  } catch (e) {
    errors.push(`getAccountBalances: ${String(e)}`)
    return { upserted: 0, errors }
  }

  const upsert = db.prepare(`
    INSERT INTO broker_balances (account_id, currency, cash, buying_power, synced_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(account_id, currency) DO UPDATE SET
      cash         = excluded.cash,
      buying_power = excluded.buying_power,
      synced_at    = excluded.synced_at
  `)

  const batch: D1PreparedStatement[] = []
  for (const b of balances) {
    const currency = b.currency?.code ?? 'USD'
    batch.push(upsert.bind(d1AccountId, currency, b.cash ?? 0, null, nowISO))
  }

  let upserted = 0
  if (batch.length > 0) {
    const results = await db.batch(batch)
    upserted = results.length
  }
  return { upserted, errors }
}

// ── Per-account refresh debounce ──────────────────────────────────
// Returns true if a sync is allowed (and stamps last_synced_at to now).
// Returns false (and the seconds-until-allowed) when within the debounce window.
export async function tryClaimSync(
  db: D1Database,
  d1AccountId: string,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const row = await db
    .prepare('SELECT last_synced_at FROM accounts WHERE id = ?')
    .bind(d1AccountId)
    .first<{ last_synced_at: string | null }>()

  if (row?.last_synced_at) {
    const elapsed = (Date.now() - new Date(row.last_synced_at).getTime()) / 1000
    if (elapsed < REFRESH_DEBOUNCE_S) {
      return { allowed: false, retryAfter: Math.ceil(REFRESH_DEBOUNCE_S - elapsed) }
    }
  }

  await db
    .prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), d1AccountId)
    .run()
  return { allowed: true }
}

// ── Cron-driven sync: iterate every linked account ───────────────
// `mode` controls which endpoints are hit:
//   'activities'        → daily cron: activities only, 7-day overlap window
//   'positions-balances'→ intraday cron: positions + balances only
//   'all'               → full sync (used by manual refresh)
export async function syncAllLinkedAccounts(
  env: { DB: D1Database; SNAPTRADE_CLIENT_ID: string; SNAPTRADE_CONSUMER_KEY: string },
  mode: 'activities' | 'positions-balances' | 'all',
): Promise<Record<string, SyncResult>> {
  // IBKR accounts are handled by the dedicated Flex Web Service path
  // (lib/ibkr-flex.ts) — SnapTrade returns empty activities for IBKR anyway.
  const linked = await env.DB
    .prepare(`SELECT id, snaptrade_account_id FROM accounts
              WHERE snaptrade_account_id IS NOT NULL
                AND institution != 'Interactive Brokers'`)
    .all<{ id: string; snaptrade_account_id: string }>()
  const accounts = linked.results ?? []
  if (accounts.length === 0) return {}

  const snapUserRow = await env.DB
    .prepare('SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = ?')
    .bind('singleton')
    .first<{ snaptrade_user_id: string; user_secret: string }>()
  if (!snapUserRow) return {}

  const userAuth: SnapUser = { userId: snapUserRow.snaptrade_user_id, userSecret: snapUserRow.user_secret }
  const snap = createSnapClient(env.SNAPTRADE_CLIENT_ID, env.SNAPTRADE_CONSUMER_KEY)
  const results: Record<string, SyncResult> = {}

  // 7-day overlap absorbs late-posted activities (dividends, settlements) on
  // the cheap, without re-fetching multi-year history every night.
  const overlapStart = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)

  for (const acct of accounts) {
    if (mode === 'activities') {
      const r = await syncActivities(env.DB, snap, userAuth, acct.id, acct.snaptrade_account_id, overlapStart)
      results[acct.id] = {
        activities_inserted: r.inserted,
        positions_upserted: 0, positions_culled: 0, balances_upserted: 0,
        errors: r.errors,
      }
    } else if (mode === 'positions-balances') {
      const [pos, bal] = await Promise.all([
        syncPositions(env.DB, snap, userAuth, acct.id, acct.snaptrade_account_id),
        syncBalances(env.DB, snap, userAuth, acct.id, acct.snaptrade_account_id),
      ])
      results[acct.id] = {
        activities_inserted: 0,
        positions_upserted: pos.upserted, positions_culled: pos.culled,
        balances_upserted: bal.upserted,
        errors: [...pos.errors, ...bal.errors],
      }
    } else {
      results[acct.id] = await syncAccount(
        env.DB, snap, userAuth, acct.id, acct.snaptrade_account_id,
        { activitiesStartDate: overlapStart },
      )
    }
    await env.DB
      .prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), acct.id).run()
  }
  return results
}

// ── Combined per-account sync (manual refresh button + cron use this) ─
export async function syncAccount(
  db: D1Database,
  snap: ReturnType<typeof createSnapClient>,
  userAuth: SnapUser,
  d1AccountId: string,
  snapAccountId: string,
  opts: { activitiesStartDate?: string; skipActivities?: boolean } = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    activities_inserted: 0,
    positions_upserted: 0,
    positions_culled: 0,
    balances_upserted: 0,
    errors: [],
  }

  // Positions + balances run in parallel; activities sequenced after to avoid
  // hammering SnapTrade's 10-req/min-per-account ceiling.
  const [pos, bal] = await Promise.all([
    syncPositions(db, snap, userAuth, d1AccountId, snapAccountId),
    syncBalances(db, snap, userAuth, d1AccountId, snapAccountId),
  ])
  result.positions_upserted = pos.upserted
  result.positions_culled   = pos.culled
  result.balances_upserted  = bal.upserted
  result.errors.push(...pos.errors, ...bal.errors)

  if (!opts.skipActivities) {
    const act = await syncActivities(db, snap, userAuth, d1AccountId, snapAccountId, opts.activitiesStartDate)
    result.activities_inserted = act.inserted
    result.errors.push(...act.errors)
  }

  return result
}
