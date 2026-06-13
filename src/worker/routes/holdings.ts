import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import * as q from '../db/queries'
import { computeHoldings } from '../lib/positions'
import { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } from '../lib/market'
import type { Holding, Quote, AssetKind } from '@shared/types'

const SYMBOL_NAMES: Record<string, string> = {
  CASH: 'Cash', BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana',
  BNB: 'BNB', XRP: 'XRP', ADA: 'Cardano', AVAX: 'Avalanche', DOGE: 'Dogecoin',
}

type ResolvedQuote = { price: number; change?: number; changePct?: number }

// ── Market hours ─────────────────────────────────────────────────
function isMarketHours(): boolean {
  const now = new Date()
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  return utcMin >= 13 * 60 + 30 && utcMin < 21 * 60
}

// ── Stale times ──────────────────────────────────────────────────
const QUOTE_STALE_MS = (sym: string) => isCrypto(sym)
  ? (isMarketHours() ? 3 * 60_000 : 5 * 60_000)
  : (isMarketHours() ? 5 * 60_000 : 30 * 60_000)

// ── Batched KV: all quotes in ONE key ────────────────────────────
interface QuoteEntry { price: number; change?: number; changePct?: number; refreshAfter: number }
type QuoteBatch = Record<string, QuoteEntry>

async function readQuoteBatch(env: Env): Promise<QuoteBatch> {
  try {
    return (await env.PRICE_CACHE.get('quotes:all', 'json') as QuoteBatch | null) ?? {}
  } catch { return {} }
}

async function writeQuoteBatch(env: Env, batch: QuoteBatch): Promise<void> {
  await env.PRICE_CACHE.put('quotes:all', JSON.stringify(batch), { expirationTtl: 7200 })
    .catch((e) => console.error('KV quotes:all write failed:', e))
}

async function fetchRawQuote(sym: string, env: Env): Promise<{ price: number; change?: number; changePct?: number } | null> {
  try {
    const raw: Quote | null = isCrypto(sym)
      ? await fetchCoinGeckoQuote(sym, env.COINGECKO_KEY)
      : await fetchFinnhubQuote(sym, env.FINNHUB_KEY)
    if (!raw) return null
    return { price: raw.price, change: raw.change, changePct: raw.changePct }
  } catch { return null }
}

async function getUsdCadRate(env: Env): Promise<number> {
  try {
    const cached = await env.PRICE_CACHE.get('fx:USD', 'json') as { rates?: Record<string, number> } | null
    if (cached?.rates?.CAD) return cached.rates.CAD
    const res = await fetch('https://api.frankfurter.app/latest?base=USD&symbols=CAD', { signal: AbortSignal.timeout(3000) })
    if (res.ok) { const d = await res.json() as { rates: { CAD: number } }; return d.rates.CAD }
  } catch {}
  return 1.37
}

// Single-symbol resolver for D1 holdings (/quote/:symbol and d1Holdings map)
async function resolveQuote(symbol: string, kind: string, fallback: number, env: Env): Promise<ResolvedQuote> {
  if (symbol === 'CASH') return { price: 1 }
  if (kind === 'option' || kind === 'mutual_fund') return { price: fallback }
  try {
    const batch = await readQuoteBatch(env)
    if (batch[symbol]) return { price: batch[symbol].price, change: batch[symbol].change, changePct: batch[symbol].changePct }
    const raw = await fetchRawQuote(symbol, env)
    if (raw) {
      batch[symbol] = { ...raw, refreshAfter: Date.now() + QUOTE_STALE_MS(symbol) }
      await writeQuoteBatch(env, batch)
      return raw
    }
  } catch {}
  return { price: fallback }
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const t0 = Date.now()
  try {
    const accountId  = c.req.query('accountId') ?? undefined
    const withPrices = c.req.query('prices') !== 'false'

    // ── D1 queries in parallel ───────────────────────────────────
    // "Broker-managed" = the account has positions persisted in
    // broker_positions (whether the source is SnapTrade or IBKR Flex).
    // We use that as the trigger to read positions from the snapshot rather
    // than computing from transactions.
    const [allAccountsResult, marks, transactions, brokerManagedRows] = await Promise.all([
      c.env.DB.prepare('SELECT id, snaptrade_account_id FROM accounts').all<{ id: string; snaptrade_account_id: string | null }>(),
      q.getHoldingMarks(c.env.DB),
      q.getAllTransactionsForHoldings(c.env.DB, accountId),
      // Accounts with rows in EITHER broker_positions or broker_balances are
      // broker-managed (e.g. a cash-only IBKR account has no positions but
      // has a balance row — it still needs to read from the snapshot path).
      c.env.DB.prepare(
        `SELECT account_id FROM broker_positions
         UNION
         SELECT account_id FROM broker_balances`
      ).all<{ account_id: string }>(),
    ])
    const tD1 = Date.now() - t0

    const brokerManagedIds = new Set<string>(
      (brokerManagedRows.results ?? []).map(r => r.account_id)
    )
    // Also treat any account with a SnapTrade link as broker-managed, even if
    // its positions table is empty (could be a fresh sync in flight).
    for (const a of allAccountsResult.results ?? []) {
      if (a.snaptrade_account_id) brokerManagedIds.add(a.id)
    }

    const isLinked = accountId ? brokerManagedIds.has(accountId) : false
    const raw = computeHoldings(transactions).filter(h => !brokerManagedIds.has(h.account_id))

    const d1Holdings: Holding[] = await Promise.all(
      raw.map(async (h) => {
        const qt = marks[h.id] != null ? { price: marks[h.id] }
          : !withPrices ? { price: h.cost }
          : await resolveQuote(h.symbol, h.kind, h.cost, c.env)
        return { ...h, name: SYMBOL_NAMES[h.symbol] ?? h.symbol, px: qt.price, change: qt.change, changePct: qt.changePct, marked: marks[h.id] != null }
      })
    )

    // ── SnapTrade holdings: read from persisted snapshot tables ──
    // Cron keeps broker_positions/balances fresh; no live SnapTrade calls
    // here. Quote freshness is handled by the existing KV quote cache.
    const snapHoldings: Holding[] = []

    if (brokerManagedIds.size > 0 && (!accountId || isLinked)) {
      const usdCadRate = await getUsdCadRate(c.env)
      const accountFilter = accountId && isLinked ? [accountId] : [...brokerManagedIds]

      const [persistedPos, persistedBal] = await Promise.all([
        c.env.DB.prepare(
          `SELECT account_id, symbol, option_type, strike, expiry, kind, qty,
                  avg_cost, market_price, currency, underlying, multiplier
           FROM broker_positions
           WHERE account_id IN (${accountFilter.map(() => '?').join(',')})`
        ).bind(...accountFilter).all<{
          account_id: string; symbol: string; option_type: string; strike: number;
          expiry: string; kind: string; qty: number; avg_cost: number | null;
          market_price: number | null; currency: string; underlying: string | null; multiplier: number;
        }>(),
        c.env.DB.prepare(
          `SELECT account_id, currency, cash FROM broker_balances
           WHERE account_id IN (${accountFilter.map(() => '?').join(',')})`
        ).bind(...accountFilter).all<{ account_id: string; currency: string; cash: number }>(),
      ])

      // Collect symbols that need a live quote (non-CAD, non-option, no mark)
      const symbolsToFetch = new Map<string, AssetKind>()
      for (const p of persistedPos.results ?? []) {
        if (p.kind === 'option') continue
        const holdingId = `${p.account_id}:${p.symbol}`
        if (marks[holdingId] != null) continue
        if ((p.currency ?? 'USD').toUpperCase() === 'CAD') continue
        if (withPrices) symbolsToFetch.set(p.symbol, p.kind as AssetKind)
      }

      const tQuoteStart = Date.now()
      const quoteBatch = await readQuoteBatch(c.env)
      const staleQuoteSymbols = new Map<string, AssetKind>()
      const missedSymbols     = new Map<string, AssetKind>()
      const quoteMap          = new Map<string, ResolvedQuote>()

      for (const [sym, kind] of symbolsToFetch) {
        const entry = quoteBatch[sym]
        if (entry) {
          quoteMap.set(sym, { price: entry.price, change: entry.change, changePct: entry.changePct })
          if (Date.now() > entry.refreshAfter) staleQuoteSymbols.set(sym, kind)
        } else {
          missedSymbols.set(sym, kind)
        }
      }
      if (missedSymbols.size > 0) {
        await Promise.allSettled([...missedSymbols.entries()].map(async ([sym]) => {
          const raw = await fetchRawQuote(sym, c.env)
          if (raw) {
            quoteMap.set(sym, raw)
            quoteBatch[sym] = { ...raw, refreshAfter: Date.now() + QUOTE_STALE_MS(sym) }
          }
        }))
        await writeQuoteBatch(c.env, quoteBatch)
      }
      const tQuotes = Date.now() - tQuoteStart

      if (staleQuoteSymbols.size > 0) {
        c.executionCtx.waitUntil((async () => {
          const current = await readQuoteBatch(c.env)
          await Promise.allSettled([...staleQuoteSymbols.entries()].map(async ([sym]) => {
            const raw = await fetchRawQuote(sym, c.env)
            if (raw) current[sym] = { ...raw, refreshAfter: Date.now() + QUOTE_STALE_MS(sym) }
          }))
          await writeQuoteBatch(c.env, current)
        })())
      }

      for (const p of persistedPos.results ?? []) {
        const isCAD = (p.currency ?? 'USD').toUpperCase() === 'CAD'
        const toUsd = (n: number) => isCAD ? n / usdCadRate : n
        const cost = p.avg_cost ?? 0

        if (p.kind === 'option') {
          const underlying = p.underlying ?? p.symbol
          const optType = p.option_type === 'put' ? 'put' : 'call'
          const holdingId = `${p.account_id}:${underlying}:${optType}:${p.strike}:${p.expiry}`
          const multiplier = p.multiplier || 100
          const costPerShare = cost / multiplier
          const px = marks[holdingId] != null
            ? marks[holdingId]
            : (p.market_price ?? costPerShare)
          snapHoldings.push({
            id: holdingId,
            account_id: p.account_id,
            symbol: underlying,
            name: `${underlying} ${optType === 'put' ? 'P' : 'C'}${p.strike} ${p.expiry.slice(5).replace('-', '/')}`,
            kind: 'option',
            qty: p.qty,
            cost: costPerShare,
            px,
            marked: marks[holdingId] != null,
            option_type: optType,
            strike: p.strike,
            expiry: p.expiry,
            underlying,
            multiplier,
          })
          continue
        }

        const holdingId = `${p.account_id}:${p.symbol}`
        let qt: ResolvedQuote
        if (marks[holdingId] != null) qt = { price: marks[holdingId] }
        else if (isCAD)              qt = { price: toUsd(p.market_price ?? cost) }
        else if (!withPrices)        qt = { price: p.market_price ?? cost }
        else {
          const fetched = quoteMap.get(p.symbol) ?? { price: p.market_price ?? cost }
          qt = {
            price: p.market_price ?? fetched.price,
            change: fetched.change,
            changePct: fetched.changePct,
          }
        }

        snapHoldings.push({
          id: holdingId,
          account_id: p.account_id,
          symbol: p.symbol,
          name: SYMBOL_NAMES[p.symbol] ?? p.symbol,
          kind: p.kind as AssetKind,
          qty: p.qty,
          cost: toUsd(cost),
          px: qt.price,
          change: qt.change,
          changePct: qt.changePct,
          marked: marks[holdingId] != null,
        })
      }

      for (const b of persistedBal.results ?? []) {
        if (b.cash <= 0) continue
        const cashUsd = b.currency === 'CAD' ? b.cash / usdCadRate : b.cash
        snapHoldings.push({
          id: `${b.account_id}:CASH:${b.currency}`,
          account_id: b.account_id,
          symbol: 'CASH',
          name: `Cash (${b.currency})`,
          kind: 'cash',
          qty: cashUsd,
          cost: 1,
          px: 1,
          marked: false,
        })
      }

      const tTotal = Date.now() - t0
      return c.json([...d1Holdings, ...snapHoldings], 200, {
        'X-Timing-D1-Ms':     String(tD1),
        'X-Timing-Quotes-Ms': String(tQuotes),
        'X-Timing-Total-Ms':  String(tTotal),
        'X-Snap-Source':      'd1-persisted',
      })
    }

    return c.json([...d1Holdings, ...snapHoldings], 200, {
      'X-Timing-D1-Ms':    String(tD1),
      'X-Timing-Total-Ms': String(Date.now() - t0),
    })
  } catch (e) {
    console.error('Holdings GET error:', e)
    return c.json({ error: String(e) }, 500)
  }
})

app.get('/quote/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  const kind = isCrypto(symbol) ? 'crypto' : 'stock'
  return c.json(await resolveQuote(symbol, kind, 0, c.env))
})

app.put('/marks', zValidator('json', z.object({ id: z.string().min(1), price: z.number().nonnegative() })), async (c) => {
  const { id, price } = c.req.valid('json')
  await q.upsertHoldingMark(c.env.DB, id, price)
  return c.json({ ok: true })
})

app.delete('/marks/:id', async (c) => {
  await q.deleteHoldingMark(c.env.DB, decodeURIComponent(c.req.param('id')))
  return c.json({ ok: true })
})

export default app
