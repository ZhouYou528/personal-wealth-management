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
import ibkrFlexRoutes     from './routes/ibkrflex'
import sentimentRoutes    from './routes/sentiment'
import * as q             from './db/queries'

// Constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Clients send SHA-256(password) so the plaintext never travels over the network.
// The worker derives the expected token the same way from APP_SECRET.
async function hashSecret(secret: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const api = new Hono<{ Bindings: Env }>()
  .use('*', cors())
  // Auth guard — if APP_SECRET is set, every /api/* request must include
  // Authorization: Bearer <APP_SECRET>. If unset (local dev), the guard is bypassed.
  .use('*', async (c, next) => {
    const secret = c.env.APP_SECRET
    if (!secret) return next()
    const auth = c.req.header('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
    const expectedToken = await hashSecret(secret)
    if (!timingSafeEqual(auth.slice(7), expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return next()
  })
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
  .route('/ibkr-flex',    ibkrFlexRoutes)
  .route('/sentiment',    sentimentRoutes)

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

  // "Broker-managed" accounts: their holdings come from the persisted
  // broker_positions/broker_balances tables (sourced by either SnapTrade
  // cron or IBKR Flex). D1-computed holdings are skipped for these accounts.
  const [allAccounts, brokerManagedRows] = await Promise.all([
    env.DB.prepare('SELECT id, snaptrade_account_id FROM accounts')
      .all<{ id: string; snaptrade_account_id: string | null }>(),
    // Union both tables — a cash-only account has no positions but its
    // broker_balances row still qualifies it as broker-managed.
    env.DB.prepare(
      `SELECT account_id FROM broker_positions
       UNION
       SELECT account_id FROM broker_balances`
    ).all<{ account_id: string }>(),
  ])
  const linkedD1Ids = new Set<string>(
    (brokerManagedRows.results ?? []).map(r => r.account_id)
  )
  for (const a of allAccounts.results ?? []) {
    if (a.snaptrade_account_id) linkedD1Ids.add(a.id)
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

  // ── SnapTrade positions/balances: read from persisted snapshot ─
  // Cron keeps broker_positions/balances fresh; no SnapTrade roundtrip here.
  if (linkedD1Ids.size > 0) {
    const persistedPositions = await env.DB
      .prepare(`SELECT account_id, symbol, qty, market_price, kind, multiplier
                FROM broker_positions
                WHERE kind != 'option'`)  // options already counted from D1
      .all<{ account_id: string; symbol: string; qty: number; market_price: number | null; kind: string; multiplier: number }>()

    for (const p of persistedPositions.results ?? []) {
      if (!linkedD1Ids.has(p.account_id)) continue
      let price = p.market_price ?? null
      if (price == null) {
        const cached = await env.PRICE_CACHE.get(`quote:${p.symbol}`, 'json') as { price: number } | null
        price = cached?.price ?? null
        if (price == null) {
          const fetched = isCrypto(p.symbol)
            ? await fetchCoinGeckoQuote(p.symbol, env.COINGECKO_KEY)
            : await fetchFinnhubQuote(p.symbol, env.FINNHUB_KEY)
          price = fetched?.price ?? null
        }
      }
      if (price == null) continue
      const v = p.qty * price * (p.multiplier ?? 1)
      byAccount[p.account_id] = (byAccount[p.account_id] ?? 0) + v
      aggregate += v
    }

    const persistedBalances = await env.DB
      .prepare('SELECT account_id, cash FROM broker_balances')
      .all<{ account_id: string; cash: number }>()
    for (const b of persistedBalances.results ?? []) {
      if (!linkedD1Ids.has(b.account_id) || b.cash <= 0) continue
      byAccount[b.account_id] = (byAccount[b.account_id] ?? 0) + b.cash
      aggregate += b.cash
    }
  }

  return { byAccount, aggregate }
}

// Daily 22:00 UTC — fire recurring transactions, sync SnapTrade activities,
// then write end-of-day snapshot (snap_hour=23).
async function runDailySnapshot(env: Env): Promise<void> {
  try {
    const { fireAllRules } = await import('./lib/recurring')
    await fireAllRules(env.DB)
  } catch (e) {
    console.error('fireAllRules failed:', e)
  }

  try {
    const { syncAllLinkedAccounts } = await import('./lib/sync')
    const r = await syncAllLinkedAccounts(env, 'activities')
    console.log('daily activities sync:', r)
  } catch (e) {
    console.error('syncAllLinkedAccounts(activities) failed:', e)
  }

  // IBKR Flex pull — full trades/cash/positions for both IBKR accounts
  if (env.IBKR_FLEX_TOKEN && env.IBKR_FLEX_QUERY_ID) {
    try {
      const { syncIbkrFlex } = await import('./lib/ibkr-flex')
      const r = await syncIbkrFlex(env.DB, {
        token: env.IBKR_FLEX_TOKEN,
        queryId: env.IBKR_FLEX_QUERY_ID,
      })
      console.log('daily IBKR Flex sync:', r)
    } catch (e) {
      console.error('IBKR Flex sync failed:', e)
    }
  }

  const { byAccount, aggregate } = await fetchPortfolioValues(env)
  const today = new Date().toISOString().split('T')[0]
  await Promise.all([
    q.upsertNavSnapshot(env.DB, { snap_date: today, snap_hour: 23, account_id: '', value: aggregate, source: 'market' }),
    ...Object.entries(byAccount).map(([account_id, value]) =>
      q.upsertNavSnapshot(env.DB, { snap_date: today, snap_hour: 23, account_id, value, source: 'market' })),
  ])
}

// Intraday every 30 min during market hours (14-20 UTC Mon-Fri) —
// sync positions+balances from SnapTrade, then write snapshot.
async function runIntradaySnapshot(env: Env): Promise<void> {
  try {
    const { syncAllLinkedAccounts } = await import('./lib/sync')
    await syncAllLinkedAccounts(env, 'positions-balances')
  } catch (e) {
    console.error('syncAllLinkedAccounts(positions-balances) failed:', e)
  }

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
