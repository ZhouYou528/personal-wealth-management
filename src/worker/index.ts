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

  // Daily cron — write a market-value snapshot per account + aggregate.
  // Parallelizes quote fetches to stay under Workers Free 10ms CPU when possible.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailySnapshot(env))
  },
}

async function runDailySnapshot(env: Env): Promise<void> {
  const { computeHoldings } = await import('./lib/positions')
  const { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } = await import('./lib/market')

  const [transactions, marks] = await Promise.all([
    q.getAllTransactionsForHoldings(env.DB),
    q.getHoldingMarks(env.DB),
  ])
  const holdings = computeHoldings(transactions)

  // Collect symbols that need a live quote (skip CASH, options, anything already user-marked)
  const symbolsToFetch = new Set<string>()
  for (const h of holdings) {
    if (h.symbol === 'CASH' || h.kind === 'option') continue
    if (marks[h.id] != null) continue
    symbolsToFetch.add(h.symbol)
  }

  // Fetch all quotes in parallel — KV cache first, fall back to provider
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

  // Resolve price per holding with precedence: mark > live quote > cost basis
  function priceFor(h: typeof holdings[number]): number {
    if (h.symbol === 'CASH') return 1
    if (marks[h.id] != null) return marks[h.id]
    return priceMap[h.symbol] ?? h.cost
  }

  // Sum per account, plus aggregate
  const byAccount: Record<string, number> = {}
  let aggregate = 0
  for (const h of holdings) {
    const v = h.qty * priceFor(h) * (h.multiplier ?? 1)
    byAccount[h.account_id] = (byAccount[h.account_id] ?? 0) + v
    aggregate += v
  }

  const today = new Date().toISOString().split('T')[0]
  await Promise.all([
    q.upsertNavSnapshot(env.DB, { snap_date: today, account_id: '', value: aggregate }),
    ...Object.entries(byAccount).map(([account_id, value]) =>
      q.upsertNavSnapshot(env.DB, { snap_date: today, account_id, value })),
  ])
}
