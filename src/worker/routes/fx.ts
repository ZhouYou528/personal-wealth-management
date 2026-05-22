import { Hono } from 'hono'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()

// GET /api/fx?base=USD
// Returns { base, date, rates: { USD: 1, CAD: 1.34, ... } }
// Data source: Frankfurter (free, no key, ECB daily reference rates).
// Cached in KV for 60 minutes — FX doesn't move enough intraday to need fresher data,
// and free providers rate-limit aggressively.
app.get('/', async (c) => {
  const base = (c.req.query('base') ?? 'USD').toUpperCase()
  // Pairs we actually use today — extend the symbols list if more are needed.
  const symbols = 'USD,CAD,EUR,GBP,HKD,JPY'

  const cacheKey = `fx:${base}`
  const cached = await c.env.PRICE_CACHE.get(cacheKey, 'json') as
    | { base: string; date: string; rates: Record<string, number> }
    | null
  if (cached) return c.json(cached)

  try {
    const url = `https://api.frankfurter.app/latest?base=${encodeURIComponent(base)}&symbols=${symbols}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`fx ${res.status}`)
    const d = await res.json() as { base: string; date: string; rates: Record<string, number> }
    // Frankfurter returns rates excluding base itself; add it as 1.0 for downstream simplicity.
    d.rates[base] = 1
    await c.env.PRICE_CACHE.put(cacheKey, JSON.stringify(d), { expirationTtl: 3600 })
    return c.json(d)
  } catch (e) {
    // Soft fallback so the UI never breaks when FX is down
    return c.json({
      base,
      date: new Date().toISOString().slice(0, 10),
      rates: { [base]: 1, USD: 1, CAD: 1.37 },  // last-known approximate
      stale: true,
    })
  }
})

export default app
