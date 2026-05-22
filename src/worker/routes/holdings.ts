import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import * as q from '../db/queries'
import { computeHoldings } from '../lib/positions'
import { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } from '../lib/market'
import type { Holding, Quote } from '@shared/types'

const SYMBOL_NAMES: Record<string, string> = {
  CASH: 'Cash', BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana',
  BNB: 'BNB', XRP: 'XRP', ADA: 'Cardano', AVAX: 'Avalanche', DOGE: 'Dogecoin',
}

type ResolvedQuote = { price: number; change?: number; changePct?: number }

async function resolveQuote(
  symbol: string,
  kind: string,
  fallback: number,
  env: Env
): Promise<ResolvedQuote> {
  if (symbol === 'CASH') return { price: 1 }
  // No free quote feed for options or proprietary mutual funds; fall back to cost
  // basis until the user marks-to-market via the holding detail page.
  if (kind === 'option' || kind === 'mutual_fund') return { price: fallback }
  // Store the full Quote shape so both /api/holdings and /api/market/quotes can share
  // the cache without one truncating the other.
  const cacheKey = `quote:${symbol}`
  const cached = await env.PRICE_CACHE.get(cacheKey, 'json') as Quote | null
  if (cached) return { price: cached.price, change: cached.change, changePct: cached.changePct }

  const quote = isCrypto(symbol)
    ? await fetchCoinGeckoQuote(symbol, env.COINGECKO_KEY)
    : await fetchFinnhubQuote(symbol, env.FINNHUB_KEY)

  if (quote) {
    await env.PRICE_CACHE.put(cacheKey, JSON.stringify(quote), { expirationTtl: 60 })
    return { price: quote.price, change: quote.change, changePct: quote.changePct }
  }
  return { price: fallback }
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const accountId = c.req.query('accountId') ?? undefined
  const withPrices = c.req.query('prices') !== 'false'

  const [transactions, marks] = await Promise.all([
    q.getAllTransactionsForHoldings(c.env.DB, accountId),
    q.getHoldingMarks(c.env.DB),
  ])
  const raw = computeHoldings(transactions)

  async function quoteFor(h: typeof raw[number]): Promise<ResolvedQuote> {
    // User mark always wins — but we still want change data if available from cache
    if (marks[h.id] != null) return { price: marks[h.id] }
    if (!withPrices) return { price: h.cost }
    return resolveQuote(h.symbol, h.kind, h.cost, c.env)
  }

  const holdings: Holding[] = await Promise.all(
    raw.map(async (h) => {
      const q = await quoteFor(h)
      return {
        ...h,
        name: SYMBOL_NAMES[h.symbol] ?? h.symbol,
        px: q.price,
        change: q.change,
        changePct: q.changePct,
        marked: marks[h.id] != null,
      }
    })
  )

  return c.json(holdings)
})

app.put('/marks', zValidator('json', z.object({
  id:    z.string().min(1),
  price: z.number().nonnegative(),
})), async (c) => {
  const { id, price } = c.req.valid('json')
  await q.upsertHoldingMark(c.env.DB, id, price)
  return c.json({ ok: true })
})

app.delete('/marks/:id', async (c) => {
  await q.deleteHoldingMark(c.env.DB, decodeURIComponent(c.req.param('id')))
  return c.json({ ok: true })
})

export default app
