import { Hono } from 'hono'
import type { Env } from '../types'
import * as q from '../db/queries'
import { computeHoldings } from '../lib/positions'
import { isCrypto, COINGECKO_ID } from '../lib/market'
import { createSnapClient } from '../lib/snaptrade'

const app = new Hono<{ Bindings: Env }>()

// GET /api/nav?days=365&accountId=acc_rrsp
app.get('/', async (c) => {
  const days = Number(c.req.query('days') ?? 365)
  const accountId = c.req.query('accountId') ?? undefined
  const snapshots = await q.getNavSnapshots(c.env.DB, days, accountId)
  return c.json(snapshots)
})

// POST /api/nav/backfill — compute cost-basis snapshots for each transaction date
// Called after bulk CSV import to populate historical chart data.
app.post('/backfill', async (c) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => ({} as { accountId?: string }))
  const accountId = body.accountId

  async function backfillAccount(filterById: string | undefined, storeId: string) {
    const txs = await q.getAllTransactionsForHoldings(c.env.DB, filterById)
    // Only wipe cost-basis rows. Daily-cron market-value rows persist across backfills.
    await c.env.DB.prepare(
      "DELETE FROM nav_snapshots WHERE account_id = ? AND source = 'cost'"
    ).bind(storeId).run()
    const dates = [...new Set(txs.map(t => t.tx_date.slice(0, 10)))].sort()
    if (dates.length === 0) return 0
    const earliest = dates[0]

    // For chart history only: pretend any transfer_in (shares brought in from another broker)
    // was held from day-1. Otherwise the chart shows an artificial cost-basis spike on the
    // transfer date even though the user owned the shares earlier elsewhere.
    const virtualTxs = txs
      .map(t => t.type === 'transfer_in' ? { ...t, tx_date: earliest } : t)
      .sort((a, b) => a.tx_date.localeCompare(b.tx_date) || a.created_at.localeCompare(b.created_at))

    for (const date of dates) {
      const upTo = virtualTxs.filter(t => t.tx_date.slice(0, 10) <= date)
      const holdings = computeHoldings(upTo)
      const value = holdings.reduce((sum, h) => {
        if (h.symbol === 'CASH') return sum + h.qty
        return sum + h.qty * h.cost * (h.multiplier ?? 1)
      }, 0)
      // ON CONFLICT: skip dates that already have a market-value (cron) snapshot
      const existing = await c.env.DB
        .prepare("SELECT source FROM nav_snapshots WHERE snap_date = ? AND account_id = ?")
        .bind(date, storeId).first<{ source: string }>()
      if (existing?.source === 'market') continue
      await q.upsertNavSnapshot(c.env.DB, { snap_date: date, account_id: storeId, value, source: 'cost' })
    }
    return dates.length
  }

  if (accountId) await backfillAccount(accountId, accountId)
  const total = await backfillAccount(undefined, '')

  return c.json({ ok: true, dates: total })
})

// POST /api/nav/backfill-live
// Reconstructs historical NAV for SnapTrade-linked accounts using Finnhub/CoinGecko daily closes.
// Assumes current positions were held since the start of the period (buy-and-hold approximation).
app.post('/backfill-live', async (c) => {
  const body = await c.req.json<{ days?: number }>().catch(() => ({}))
  const days = Math.min(Number(body.days ?? 365), 3650)  // up to 10 years

  // Linked accounts
  const allAccounts = await c.env.DB
    .prepare('SELECT id, snaptrade_account_id FROM accounts')
    .all<{ id: string; snaptrade_account_id: string | null }>()
  const reverseMap = new Map<string, string>()
  for (const a of allAccounts.results ?? []) {
    if (a.snaptrade_account_id) reverseMap.set(a.snaptrade_account_id, a.id)
  }
  if (reverseMap.size === 0) return c.json({ ok: true, dates: 0, message: 'No live accounts to backfill' })

  const snapUser = await c.env.DB
    .prepare('SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = ?')
    .bind('singleton')
    .first<{ snaptrade_user_id: string; user_secret: string }>()
  if (!snapUser) return c.json({ ok: false, message: 'No SnapTrade user' }, 400)

  const snap = createSnapClient(c.env.SNAPTRADE_CLIENT_ID, c.env.SNAPTRADE_CONSUMER_KEY)
  const userAuth = { userId: snapUser.snaptrade_user_id, userSecret: snapUser.user_secret }

  const nowTs  = Math.floor(Date.now() / 1000)
  const fromTs = nowTs - days * 86400
  let totalDates = 0

  // Fetch USD/CAD rate once — CAD-priced positions must be converted to USD
  let usdCadRate = 1.37
  try {
    const cached = await c.env.PRICE_CACHE.get('fx:USD', 'json') as { rates?: Record<string, number> } | null
    if (cached?.rates?.CAD) {
      usdCadRate = cached.rates.CAD
    } else {
      const fxRes = await fetch('https://api.frankfurter.app/latest?base=USD&symbols=CAD', { signal: AbortSignal.timeout(3000) })
      if (fxRes.ok) {
        const fxData = await fxRes.json() as { rates: { CAD: number } }
        usdCadRate = fxData.rates.CAD
      }
    }
  } catch { /* use fallback */ }

  // Helper: fetch Finnhub daily closes → { "YYYY-MM-DD": price }
  async function finnhubCandles(sym: string): Promise<Record<string, number>> {
    if (!c.env.FINNHUB_KEY) return {}
    try {
      const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${fromTs}&to=${nowTs}&token=${c.env.FINNHUB_KEY}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return {}
      const d = await res.json() as { c?: number[]; t?: number[]; s: string }
      if (d.s !== 'ok' || !d.t || !d.c) return {}
      const out: Record<string, number> = {}
      for (let i = 0; i < d.t.length; i++) {
        out[new Date(d.t[i] * 1000).toISOString().slice(0, 10)] = d.c[i]
      }
      return out
    } catch { return {} }
  }

  // Helper: fetch CoinGecko daily closes → { "YYYY-MM-DD": price }
  async function coinGeckoCandles(sym: string): Promise<Record<string, number>> {
    const id = COINGECKO_ID[sym.toUpperCase()]
    if (!id || !c.env.COINGECKO_KEY) return {}
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`
      const res = await fetch(url, { headers: { 'x-cg-demo-api-key': c.env.COINGECKO_KEY }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) return {}
      const d = await res.json() as { prices: [number, number][] }
      const byDate: Record<string, number> = {}
      for (const [tsMs, price] of d.prices) {
        byDate[new Date(tsMs).toISOString().slice(0, 10)] = price
      }
      return byDate
    } catch { return {} }
  }

  for (const [snapAccId, d1Id] of reverseMap) {
    try {
      const [unified, balances] = await Promise.all([
        snap.getAccountAllPositions(userAuth, snapAccId),
        snap.getAccountBalances(userAuth, snapAccId),
      ])

      // Convert each currency's cash to USD
      const cashTotalUsd = balances.reduce((s, b) => {
        const amount = b.cash ?? 0
        return s + (b.currency?.code === 'CAD' ? amount / usdCadRate : amount)
      }, 0)

      // date → USD value accumulator
      const dateValue: Record<string, number> = {}

      for (const pos of unified) {
        const instrKind = (pos.instrument?.kind ?? '').toLowerCase()
        if (instrKind === 'option') continue  // skip options — no liquid historical option prices
        if (instrKind === 'other' || instrKind === 'mutualfund') continue  // mutual funds have no exchange price history
        const qty = Number(pos.units) || 0
        const sym = pos.instrument?.symbol
        if (!sym || !qty) continue

        const isCAD = (pos.currency ?? '').toUpperCase() === 'CAD'
        const candles = isCrypto(sym)
          ? await coinGeckoCandles(sym)
          : await finnhubCandles(sym)

        for (const [date, price] of Object.entries(candles)) {
          const priceUsd = isCAD ? price / usdCadRate : price
          dateValue[date] = (dateValue[date] ?? 0) + qty * priceUsd
        }
      }

      // Add cash to every date we have equity data for
      for (const date of Object.keys(dateValue)) {
        dateValue[date] += cashTotalUsd
      }

      // Write per-account snapshots
      for (const [date, value] of Object.entries(dateValue)) {
        await q.upsertNavSnapshot(c.env.DB, { snap_date: date, account_id: d1Id, value, source: 'market' })
        totalDates++
      }
    } catch (e) {
      console.error(`backfill-live failed for ${snapAccId}:`, e)
    }
  }

  // Recompute aggregate scoped to SnapTrade-linked accounts only (excludes manually-tracked
  // accounts whose cron snapshots would inflate counts on weekends/holidays).
  // Require ≥3 distinct linked accounts so crypto-only weekends are excluded.
  const linkedIds = [...reverseMap.values()]
  if (linkedIds.length > 0) {
    const placeholders = linkedIds.map(() => '?').join(',')
    const minAccounts = Math.min(3, linkedIds.length)
    await c.env.DB.prepare(`
      INSERT INTO nav_snapshots (snap_date, snap_hour, account_id, value, source)
      SELECT snap_date, 23, '', SUM(value), 'market'
      FROM (
        SELECT account_id, snap_date, value FROM nav_snapshots n
        WHERE account_id IN (${placeholders}) AND source = 'market'
          AND snap_hour = (
            SELECT MAX(snap_hour) FROM nav_snapshots
            WHERE snap_date = n.snap_date AND account_id = n.account_id AND source = 'market'
          )
      )
      GROUP BY snap_date
      HAVING COUNT(DISTINCT account_id) >= ${minAccounts}
      ON CONFLICT(snap_date, snap_hour, account_id) DO UPDATE SET value = excluded.value, source = excluded.source
    `).bind(...linkedIds).run()
  }

  return c.json({ ok: true, dates: totalDates })
})

export default app
