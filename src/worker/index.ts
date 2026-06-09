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
import creditCardsRoutes  from './routes/creditcards'
import snaptradeRoutes    from './routes/snaptrade'
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
  .route('/credit-cards', creditCardsRoutes)
  .route('/snaptrade',    snaptradeRoutes)

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
// For SnapTrade-linked accounts, equity/cash positions come from SnapTrade; D1 is options-only.
async function fetchPortfolioValues(env: Env): Promise<{
  byAccount: Record<string, number>
  aggregate: number
}> {
  const { computeHoldings } = await import('./lib/positions')
  const { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } = await import('./lib/market')

  // Determine which D1 accounts are SnapTrade-linked
  const allAccounts = await env.DB
    .prepare('SELECT id, snaptrade_account_id FROM accounts')
    .all<{ id: string; snaptrade_account_id: string | null }>()
  const reverseMap = new Map<string, string>() // snap_account_id → d1_id
  const linkedD1Ids = new Set<string>()
  for (const a of allAccounts.results ?? []) {
    if (a.snaptrade_account_id) {
      reverseMap.set(a.snaptrade_account_id, a.id)
      linkedD1Ids.add(a.id)
    }
  }

  const [transactions, marks] = await Promise.all([
    q.getAllTransactionsForHoldings(env.DB),
    q.getHoldingMarks(env.DB),
  ])

  // Live accounts are 100% SnapTrade — exclude all their D1 holdings from NAV
  const d1Holdings = computeHoldings(transactions).filter(h => !linkedD1Ids.has(h.account_id))

  const symbolsToFetch = new Set<string>()
  for (const h of d1Holdings) {
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

  function priceFor(h: ReturnType<typeof computeHoldings>[number]): number {
    if (h.symbol === 'CASH') return 1
    if (marks[h.id] != null) return marks[h.id]
    return priceMap[h.symbol] ?? h.cost
  }

  const byAccount: Record<string, number> = {}
  let aggregate = 0
  for (const h of d1Holdings) {
    const v = h.qty * priceFor(h) * (h.multiplier ?? 1)
    byAccount[h.account_id] = (byAccount[h.account_id] ?? 0) + v
    aggregate += v
  }

  // ── SnapTrade live account positions ──────────────────────────
  if (reverseMap.size > 0) {
    const snapUser = await env.DB
      .prepare('SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = ?')
      .bind('singleton')
      .first<{ snaptrade_user_id: string; user_secret: string }>()

    if (snapUser) {
      const { createSnapClient } = await import('./lib/snaptrade')
      const snap = createSnapClient(env.SNAPTRADE_CLIENT_ID, env.SNAPTRADE_CONSUMER_KEY)
      const userAuth = { userId: snapUser.snaptrade_user_id, userSecret: snapUser.user_secret }

      for (const [snapAccId, d1Id] of reverseMap) {
        try {
          const [unified, balances] = await Promise.all([
            snap.getAccountAllPositions(userAuth, snapAccId),
            snap.getAccountBalances(userAuth, snapAccId),
          ])

          let snapValue = 0
          for (const pos of unified) {
            const instrKind = (pos.instrument?.kind ?? '').toLowerCase()
            if (instrKind === 'option') continue  // already counted from D1
            const qty = Number(pos.units) || 0
            const sym = pos.instrument?.symbol
            if (!sym || !qty) continue
            // Prefer broker's live price; fall back to KV cache then Finnhub
            let price: number | null = pos.price != null ? Number(pos.price) : null
            if (price == null) {
              const cached = await env.PRICE_CACHE.get(`quote:${sym}`, 'json') as { price: number } | null
              price = cached?.price ?? null
              if (price == null) {
                const fetched = isCrypto(sym)
                  ? await fetchCoinGeckoQuote(sym, env.COINGECKO_KEY)
                  : await fetchFinnhubQuote(sym, env.FINNHUB_KEY)
                price = fetched?.price ?? null
              }
            }
            if (price != null) snapValue += qty * price
          }
          for (const bal of balances) {
            if ((bal.cash ?? 0) > 0) snapValue += bal.cash
          }

          byAccount[d1Id] = (byAccount[d1Id] ?? 0) + snapValue
          aggregate += snapValue
        } catch (e) {
          console.error(`SnapTrade NAV fetch failed for ${snapAccId}:`, e)
        }
      }
    }
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
