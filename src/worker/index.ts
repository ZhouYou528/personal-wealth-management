import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './types'
import accountsRoutes     from './routes/accounts'
import transactionsRoutes from './routes/transactions'
import holdingsRoutes     from './routes/holdings'
import watchlistRoutes    from './routes/watchlist'
import goalsRoutes        from './routes/goals'
import marketRoutes       from './routes/market'
import navRoutes          from './routes/nav'
import fxRoutes           from './routes/fx'
import recurringRoutes    from './routes/recurring'
import allocationRoutes   from './routes/allocation'
import * as q             from './db/queries'

const api = new Hono<{ Bindings: Env }>()
  .use('*', cors())
  .route('/accounts',     accountsRoutes)
  .route('/transactions', transactionsRoutes)
  .route('/holdings',     holdingsRoutes)
  .route('/watchlist',    watchlistRoutes)
  .route('/goals',        goalsRoutes)
  .route('/market',       marketRoutes)
  .route('/nav',          navRoutes)
  .route('/fx',           fxRoutes)
  .route('/recurring',    recurringRoutes)
  .route('/allocation',   allocationRoutes)

// GET /api/events — upcoming calendar events
api.get('/events', async (c) => {
  const events = await q.getEvents(c.env.DB)
  return c.json(events)
})

// POST /api/admin/run-snapshot — manually invoke the daily snapshot job
api.post('/admin/run-snapshot', async (c) => {
  await runDailySnapshot(c.env)
  return c.json({ ok: true })
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // All /api/* routes go to Hono
    if (url.pathname.startsWith('/api/')) {
      const stripped = new Request(
        new URL(url.pathname.replace('/api', '') + url.search, request.url).toString(),
        request
      )
      return api.fetch(stripped, env, ctx)
    }

    // Everything else: serve static asset or fall back to index.html for SPA routing
    const assetRes = await env.ASSETS.fetch(request)
    if (assetRes.status === 404) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString()))
    }
    return assetRes
  },

  // Cron dispatcher: daily (22:00 UTC) fires recurring + end-of-day snapshot;
  // intraday (14-20 UTC Mon-Fri) fires snapshot only.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 22 * * *') {
      ctx.waitUntil(runDailySnapshot(env))
    } else {
      ctx.waitUntil(
        runIntradaySnapshot(env).catch(e => console.error('intraday snapshot failed:', e))
      )
    }
  },
}

// Shared: fetch all prices and compute per-account values.
async function fetchPortfolioValues(env: Env): Promise<{
  byAccount: Record<string, number>
  aggregate: number
}> {
  const { computeHoldings } = await import('./lib/positions')
  const { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } = await import('./lib/market')

  const [transactions, marks] = await Promise.all([
    q.getAllTransactionsForHoldings(env.DB),
    q.getHoldingMarks(env.DB),
  ])
  const holdings = computeHoldings(transactions)

  const symbolsToFetch = new Set<string>()
  for (const h of holdings) {
    if (h.symbol === 'CASH' || h.kind === 'option') continue
    if (marks[h.id] != null) continue
    symbolsToFetch.add(h.symbol)
  }

  const priceMap: Record<string, number> = {}
  await Promise.all([...symbolsToFetch].map(async (sym) => {
    const cached = await env.PRICE_CACHE.get(`quote:${sym}`, 'json') as { price: number } | null
    if (cached) { priceMap[sym] = cached.price; return }
    const quote = isCrypto(sym)
      ? await fetchCoinGeckoQuote(sym, env.COINGECKO_KEY)
      : await fetchFinnhubQuote(sym, env.FINNHUB_KEY)
    if (quote) {
      priceMap[sym] = quote.price
      await env.PRICE_CACHE.put(`quote:${sym}`, JSON.stringify(quote), { expirationTtl: 60 })
    }
  }))

  function priceFor(h: typeof holdings[number]): number {
    if (h.symbol === 'CASH') return 1
    if (marks[h.id] != null) return marks[h.id]
    return priceMap[h.symbol] ?? h.cost
  }

  const byAccount: Record<string, number> = {}
  let aggregate = 0
  for (const h of holdings) {
    const v = h.qty * priceFor(h) * (h.multiplier ?? 1)
    byAccount[h.account_id] = (byAccount[h.account_id] ?? 0) + v
    aggregate += v
  }
  return { byAccount, aggregate }
}

// Daily 22:00 UTC — fire recurring transactions then write end-of-day snapshot (snap_hour=23).
async function runDailySnapshot(env: Env): Promise<void> {
  try {
    const { fireAllRules } = await import('./lib/recurring')
    await fireAllRules(env.DB)
  } catch (e) {
    console.error('fireAllRules failed:', e)
  }

  const { byAccount, aggregate } = await fetchPortfolioValues(env)
  const today = new Date().toISOString().split('T')[0]
  await Promise.all([
    q.upsertNavSnapshot(env.DB, { snap_date: today, snap_hour: 23, account_id: '', value: aggregate, source: 'market' }),
    ...Object.entries(byAccount).map(([account_id, value]) =>
      q.upsertNavSnapshot(env.DB, { snap_date: today, snap_hour: 23, account_id, value, source: 'market' })),
  ])
}

// Intraday every 30 min during market hours (14-20 UTC Mon-Fri) — snapshot only, no recurring.
async function runIntradaySnapshot(env: Env): Promise<void> {
  const { byAccount, aggregate } = await fetchPortfolioValues(env)
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const snap_hour = now.getUTCHours()
  await Promise.all([
    q.upsertNavSnapshot(env.DB, { snap_date: today, snap_hour, account_id: '', value: aggregate, source: 'market' }),
    ...Object.entries(byAccount).map(([account_id, value]) =>
      q.upsertNavSnapshot(env.DB, { snap_date: today, snap_hour, account_id, value, source: 'market' })),
  ])
}
