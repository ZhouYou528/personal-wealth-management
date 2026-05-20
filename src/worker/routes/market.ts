import { Hono } from 'hono'
import type { Env } from '../types'
import { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote, STATIC_TICKERS } from '../lib/market'
import type { Quote } from '@shared/types'

const app = new Hono<{ Bindings: Env }>()

// GET /api/market/quotes?symbols=AAPL,BTC,VEQT.TO
// Batch price lookup — up to 12 symbols per call (Finnhub free-tier: 60 req/min)
app.get('/quotes', async (c) => {
  const symbolsParam = c.req.query('symbols') ?? ''
  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12)

  const quotes: Record<string, Quote> = {}

  await Promise.all(
    symbols.map(async (symbol) => {
      const cacheKey = `quote:${symbol}`
      const cached = await c.env.PRICE_CACHE.get(cacheKey, 'json') as Quote | null
      if (cached) { quotes[symbol] = cached; return }

      const quote = isCrypto(symbol)
        ? await fetchCoinGeckoQuote(symbol, c.env.COINGECKO_KEY)
        : await fetchFinnhubQuote(symbol, c.env.FINNHUB_KEY)

      if (quote) {
        await c.env.PRICE_CACHE.put(cacheKey, JSON.stringify(quote), { expirationTtl: 60 })
        quotes[symbol] = quote
      }
    })
  )

  return c.json({ quotes })
})

// GET /api/market/search?q=apple
app.get('/search', (c) => {
  const q = (c.req.query('q') ?? '').toLowerCase().trim()
  if (!q) return c.json({ results: [] })

  const results = STATIC_TICKERS
    .filter(t =>
      t.symbol.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q)
    )
    .slice(0, 8)

  return c.json({ results })
})

export default app
