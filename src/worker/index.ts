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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // All /api/* routes go to Hono
    if (url.pathname.startsWith('/api/')) {
      const stripped = new Request(
        new URL(url.pathname.replace('/api', ''), request.url).toString(),
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

  // Nightly cron trigger — refresh nav snapshots
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const { computeHoldings } = await import('./lib/positions')
    const { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } = await import('./lib/market')

    const transactions = await q.getAllTransactionsForHoldings(env.DB)
    const holdings = computeHoldings(transactions)

    let totalValue = 0
    for (const h of holdings) {
      if (h.symbol === 'CASH') { totalValue += h.qty; continue }
      let px = h.cost
      const cached = await env.PRICE_CACHE.get(`quote:${h.symbol}`, 'json') as { price: number } | null
      if (cached) { px = cached.price }
      else {
        const quote = isCrypto(h.symbol)
          ? await fetchCoinGeckoQuote(h.symbol, env.COINGECKO_KEY)
          : await fetchFinnhubQuote(h.symbol, env.FINNHUB_KEY)
        if (quote) px = quote.price
      }
      const mult = h.multiplier ?? 1
      totalValue += h.qty * px * mult
    }

    const today = new Date().toISOString().split('T')[0]
    await q.upsertNavSnapshot(env.DB, { date: today, value: totalValue })
  },
}
