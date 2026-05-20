import { Hono } from 'hono'
import type { Env } from '../types'
import * as q from '../db/queries'
import { computeHoldings } from '../lib/positions'
import { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } from '../lib/market'
import type { Holding } from '@shared/types'

const SYMBOL_NAMES: Record<string, string> = {
  CASH: 'Cash', BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana',
  BNB: 'BNB', XRP: 'XRP', ADA: 'Cardano', AVAX: 'Avalanche', DOGE: 'Dogecoin',
}

async function resolvePrice(
  symbol: string,
  fallback: number,
  env: Env
): Promise<number> {
  if (symbol === 'CASH') return 1
  const cacheKey = `quote:${symbol}`
  const cached = await env.PRICE_CACHE.get(cacheKey, 'json') as { price: number } | null
  if (cached) return cached.price

  const quote = isCrypto(symbol)
    ? await fetchCoinGeckoQuote(symbol, env.COINGECKO_KEY)
    : await fetchFinnhubQuote(symbol, env.FINNHUB_KEY)

  if (quote) {
    await env.PRICE_CACHE.put(cacheKey, JSON.stringify(quote), { expirationTtl: 60 })
    return quote.price
  }
  return fallback
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const accountId = c.req.query('accountId') ?? undefined
  const withPrices = c.req.query('prices') !== 'false'

  const transactions = await q.getAllTransactionsForHoldings(c.env.DB, accountId)
  const raw = computeHoldings(transactions)

  let holdings: Holding[]

  if (withPrices) {
    holdings = await Promise.all(
      raw.map(async (h) => ({
        ...h,
        name: SYMBOL_NAMES[h.symbol] ?? h.symbol,
        px: await resolvePrice(h.symbol, h.cost, c.env),
      }))
    )
  } else {
    holdings = raw.map((h) => ({
      ...h,
      name: SYMBOL_NAMES[h.symbol] ?? h.symbol,
      px: h.cost,
    }))
  }

  return c.json(holdings)
})

export default app
