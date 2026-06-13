// GET /api/sentiment — VIX (via Finnhub) + CNN Fear & Greed Index.
// Cached in KV for 15 minutes since both sources update slowly intraday.
//
// CNN F&G endpoint is unofficial but stable; requires a real User-Agent.

import { Hono } from 'hono'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()

const CACHE_KEY = 'sentiment:current'
const CACHE_TTL_S = 900  // 15 min

interface Sentiment {
  vix: { value: number; change: number; label: string } | null
  fearGreed: { value: number; change: number; label: string } | null
  fetchedAt: string
}

function vixLabel(v: number): string {
  if (v < 15) return 'Calm'
  if (v < 20) return 'Normal'
  if (v < 30) return 'Elevated'
  return 'High Fear'
}

function fgLabel(v: number): string {
  if (v < 25) return 'Extreme Fear'
  if (v < 45) return 'Fear'
  if (v < 55) return 'Neutral'
  if (v < 75) return 'Greed'
  return 'Extreme Greed'
}

async function fetchVix(_env: Env): Promise<Sentiment['vix']> {
  // Yahoo Finance unauthenticated chart endpoint — works for indices like ^VIX
  // (Finnhub's free tier doesn't include indices).
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!res.ok) return null
    const d = await res.json() as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }> }
    }
    const meta = d?.chart?.result?.[0]?.meta
    const value = meta?.regularMarketPrice
    const prev  = meta?.chartPreviousClose ?? meta?.previousClose
    if (value == null) return null
    const change = prev != null ? value - prev : 0
    return { value, change, label: vixLabel(value) }
  } catch {
    return null
  }
}

async function fetchFearGreed(): Promise<Sentiment['fearGreed']> {
  try {
    const res = await fetch(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      {
        headers: {
          // CNN returns 418/403 without a real-looking UA
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!res.ok) return null
    const d = await res.json() as {
      fear_and_greed?: { score?: number; rating?: string; previous_close?: number }
    }
    const fg = d?.fear_and_greed
    if (fg?.score == null) return null
    const value = Math.round(fg.score)
    const prev = fg.previous_close != null ? Math.round(fg.previous_close) : value
    return { value, change: value - prev, label: fgLabel(value) }
  } catch {
    return null
  }
}

app.get('/', async (c) => {
  // KV cache first
  try {
    const cached = await c.env.PRICE_CACHE.get(CACHE_KEY, 'json') as Sentiment | null
    if (cached) return c.json(cached)
  } catch {}

  const [vix, fearGreed] = await Promise.all([fetchVix(c.env), fetchFearGreed()])
  const payload: Sentiment = { vix, fearGreed, fetchedAt: new Date().toISOString() }

  // Cache even if one side failed — we'll still serve the half-result rather
  // than re-hammer the dead source for the next 15 min.
  c.env.PRICE_CACHE.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: CACHE_TTL_S })
    .catch(e => console.error('KV sentiment write:', e))

  return c.json(payload)
})

export default app
