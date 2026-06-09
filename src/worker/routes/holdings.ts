import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import * as q from '../db/queries'
import { computeHoldings } from '../lib/positions'
import { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } from '../lib/market'
import { createSnapClient } from '../lib/snaptrade'
import type { SnapUnifiedPosition, SnapBalance } from '../lib/snaptrade'
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
const SNAP_STALE_MS  = () => isMarketHours() ? 3 * 60_000   : 15 * 60_000
const QUOTE_STALE_MS = (sym: string) => isCrypto(sym)
  ? (isMarketHours() ? 3 * 60_000 : 5 * 60_000)
  : (isMarketHours() ? 5 * 60_000 : 30 * 60_000)

// ── Batched KV: all snap positions in ONE key ────────────────────
// Free tier allows 1,000 writes/day — one key for all accounts vs N keys saves quota.
interface SnapPosEntry { unified: SnapUnifiedPosition[]; balances: SnapBalance[]; refreshAfter: number }
type SnapBatch = Record<string, SnapPosEntry>

async function readSnapBatch(env: Env): Promise<SnapBatch> {
  try {
    return (await env.PRICE_CACHE.get('snap:all', 'json') as SnapBatch | null) ?? {}
  } catch { return {} }
}

async function writeSnapBatch(env: Env, batch: SnapBatch): Promise<void> {
  await env.PRICE_CACHE.put('snap:all', JSON.stringify(batch), { expirationTtl: 86_400 })
    .catch((e) => console.error('KV snap:all write failed:', e))
}

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

function unifiedKind(kind: string): AssetKind {
  switch (kind) {
    case 'etf': return 'etf'; case 'crypto': return 'crypto'; case 'mutualfund': return 'mutual_fund'
    case 'option': return 'option'; case 'cef': return 'etf'; case 'other': return 'mutual_fund'
    case 'adr': case 'stock': default: return 'stock'
  }
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
    const [allAccountsResult, marks, transactions] = await Promise.all([
      c.env.DB.prepare('SELECT id, snaptrade_account_id FROM accounts').all<{ id: string; snaptrade_account_id: string | null }>(),
      q.getHoldingMarks(c.env.DB),
      q.getAllTransactionsForHoldings(c.env.DB, accountId),
    ])
    const tD1 = Date.now() - t0

    const linkedMap  = new Map<string, string>()
    const reverseMap = new Map<string, string>()
    for (const a of allAccountsResult.results ?? []) {
      if (a.snaptrade_account_id) {
        linkedMap.set(a.id, a.snaptrade_account_id)
        reverseMap.set(a.snaptrade_account_id, a.id)
      }
    }

    const isLinked = accountId ? linkedMap.has(accountId) : false
    const raw = computeHoldings(transactions).filter(h => !linkedMap.has(h.account_id))

    const d1Holdings: Holding[] = await Promise.all(
      raw.map(async (h) => {
        const qt = marks[h.id] != null ? { price: marks[h.id] }
          : !withPrices ? { price: h.cost }
          : await resolveQuote(h.symbol, h.kind, h.cost, c.env)
        return { ...h, name: SYMBOL_NAMES[h.symbol] ?? h.symbol, px: qt.price, change: qt.change, changePct: qt.changePct, marked: marks[h.id] != null }
      })
    )

    // ── SnapTrade holdings ───────────────────────────────────────
    const snapHoldings: Holding[] = []
    let snapCacheStatus = 'N/A'
    let snapHits = 0, snapMisses = 0

    if (linkedMap.size > 0 && (!accountId || isLinked)) {
      const [usdCadRate, snapUser, snapBatch] = await Promise.all([
        getUsdCadRate(c.env),
        c.env.DB.prepare('SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = ?').bind('singleton')
          .first<{ snaptrade_user_id: string; user_secret: string }>(),
        readSnapBatch(c.env),
      ])

      if (snapUser) {
        const snap = createSnapClient(c.env.SNAPTRADE_CLIENT_ID, c.env.SNAPTRADE_CONSUMER_KEY)
        const userAuth = { userId: snapUser.snaptrade_user_id, userSecret: snapUser.user_secret }
        const snapAccountIds = accountId
          ? (linkedMap.get(accountId) ? [linkedMap.get(accountId)!] : [])
          : [...reverseMap.keys()]

        const staleSnapAccIds: string[] = []
        const tSnapStart = Date.now()

        // Collect which accounts need synchronous fetching (cold misses)
        const coldMissIds = snapAccountIds.filter(id => {
          const entry = snapBatch[id]
          if (entry) {
            snapHits++
            if (Date.now() > entry.refreshAfter) staleSnapAccIds.push(id)
            return false
          }
          snapMisses++
          return true
        })

        // Fetch cold misses synchronously, update batch in-memory
        if (coldMissIds.length > 0) {
          await Promise.allSettled(coldMissIds.map(async (snapAccId) => {
            const [unifiedRes, balancesRes] = await Promise.allSettled([
              snap.getAccountAllPositions(userAuth, snapAccId),
              snap.getAccountBalances(userAuth, snapAccId),
            ])
            snapBatch[snapAccId] = {
              unified:  unifiedRes.status  === 'fulfilled' ? unifiedRes.value  : [],
              balances: balancesRes.status === 'fulfilled' ? balancesRes.value : [],
              refreshAfter: Date.now() + SNAP_STALE_MS(),
            }
          }))
          // One KV write for all updated accounts
          await writeSnapBatch(c.env, snapBatch)
        }

        const tSnap = Date.now() - tSnapStart
        snapCacheStatus = `${snapHits}hit/${snapMisses}miss ${tSnap}ms`

        // Background refresh stale accounts (one KV read + write after response)
        if (staleSnapAccIds.length > 0) {
          c.executionCtx.waitUntil((async () => {
            const current = await readSnapBatch(c.env)
            await Promise.allSettled(staleSnapAccIds.map(async (snapAccId) => {
              const [unifiedRes, balancesRes] = await Promise.allSettled([
                snap.getAccountAllPositions(userAuth, snapAccId),
                snap.getAccountBalances(userAuth, snapAccId),
              ])
              current[snapAccId] = {
                unified:  unifiedRes.status  === 'fulfilled' ? unifiedRes.value  : current[snapAccId]?.unified  ?? [],
                balances: balancesRes.status === 'fulfilled' ? balancesRes.value : current[snapAccId]?.balances ?? [],
                refreshAfter: Date.now() + SNAP_STALE_MS(),
              }
            }))
            await writeSnapBatch(c.env, current)
          })())
        }

        // ── Quote SWR: all quotes in one key ──────────────────────
        const symbolsToFetch = new Map<string, AssetKind>()
        for (const id of snapAccountIds) {
          const entry = snapBatch[id]
          if (!entry) continue
          const d1Id = reverseMap.get(id)
          if (!d1Id) continue
          for (const pos of entry.unified ?? []) {
            const instrKind = (pos.instrument?.kind ?? '').toLowerCase()
            if (instrKind === 'option') continue
            const sym = pos.instrument?.symbol
            if (!sym || marks[`${d1Id}:${sym}`] != null) continue
            if ((pos.currency ?? 'USD').toUpperCase() === 'CAD') continue
            if (withPrices) symbolsToFetch.set(sym, unifiedKind(instrKind))
          }
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

        // Fetch cold-miss quotes synchronously
        if (missedSymbols.size > 0) {
          await Promise.allSettled([...missedSymbols.entries()].map(async ([sym]) => {
            const raw = await fetchRawQuote(sym, c.env)
            if (raw) {
              quoteMap.set(sym, raw)
              quoteBatch[sym] = { ...raw, refreshAfter: Date.now() + QUOTE_STALE_MS(sym) }
            }
          }))
          // One KV write for all new quote entries
          await writeQuoteBatch(c.env, quoteBatch)
        }

        const tQuotes = Date.now() - tQuoteStart

        // Background refresh stale quotes (one KV read + write after response)
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

        // Assemble snap holdings
        for (const snapAccId of snapAccountIds) {
          const entry = snapBatch[snapAccId]
          if (!entry) continue
          const d1Id = reverseMap.get(snapAccId)
          if (!d1Id) continue
          const { unified, balances } = entry

          for (const pos of (Array.isArray(unified) ? unified : [])) {
            try {
              const instrKind = (pos.instrument?.kind ?? '').toLowerCase()
              const qty = Number(pos.units) || 0
              const cost = Number(pos.cost_basis) || 0
              const livePrice = pos.price != null ? Number(pos.price) : undefined

              if (instrKind === 'option') {
                const inst = pos.instrument
                const underlying = inst.underlying?.symbol ?? 'UNKNOWN'
                const optType = (inst.option_type ?? '').toLowerCase() === 'put' ? 'put' : 'call'
                const strike = Number(inst.strike_price) || 0
                const expiry = (inst.expiration_date ?? '').slice(0, 10)
                const holdingId = `${d1Id}:${underlying}:${optType}:${strike}:${expiry}`
                const multiplier = inst.is_mini_option ? 10 : (inst.multiplier ?? 100)
                const costPerShare = (Number(pos.cost_basis) || 0) / multiplier
                const px = marks[holdingId] != null ? marks[holdingId] : (livePrice ?? costPerShare)
                snapHoldings.push({ id: holdingId, account_id: d1Id, symbol: underlying, name: `${underlying} ${optType === 'put' ? 'P' : 'C'}${strike} ${expiry.slice(5).replace('-', '/')}`, kind: 'option', qty, cost: costPerShare, px, marked: marks[holdingId] != null, option_type: optType, strike, expiry, underlying, multiplier })
                continue
              }

              const sym = pos.instrument?.symbol ?? 'UNKNOWN'
              const kind = unifiedKind(instrKind)
              const holdingId = `${d1Id}:${sym}`
              const isCAD = (pos.currency ?? 'USD').toUpperCase() === 'CAD'
              const toUsd = (n: number) => isCAD ? n / usdCadRate : n

              let qt: ResolvedQuote
              if (marks[holdingId] != null) qt = { price: marks[holdingId] }
              else if (isCAD)              qt = { price: toUsd(livePrice ?? cost) }
              else if (!withPrices)        qt = { price: livePrice ?? cost }
              else {
                const fetched = quoteMap.get(sym) ?? { price: livePrice ?? cost }
                qt = { price: livePrice ?? fetched.price, change: fetched.change, changePct: fetched.changePct }
              }

              snapHoldings.push({ id: holdingId, account_id: d1Id, symbol: sym, name: pos.instrument?.description ?? SYMBOL_NAMES[sym] ?? sym, kind, qty, cost: toUsd(cost), px: qt.price, change: qt.change, changePct: qt.changePct, marked: marks[holdingId] != null })
            } catch (posErr) { console.error(`pos error ${snapAccId}:`, posErr) }
          }

          for (const bal of (Array.isArray(balances) ? balances : [])) {
            if ((bal.cash ?? 0) <= 0) continue
            const currCode = bal.currency?.code ?? 'USD'
            const cashUsd = currCode === 'CAD' ? bal.cash / usdCadRate : bal.cash
            snapHoldings.push({ id: `${d1Id}:CASH:${currCode}`, account_id: d1Id, symbol: 'CASH', name: `Cash (${currCode})`, kind: 'cash', qty: cashUsd, cost: 1, px: 1, marked: false })
          }
        }

        const tTotal = Date.now() - t0
        return c.json([...d1Holdings, ...snapHoldings], 200, {
          'X-Timing-D1-Ms':       String(tD1),
          'X-Timing-Snap-Ms':     String(tSnap),
          'X-Timing-Quotes-Ms':   String(tQuotes),
          'X-Timing-Total-Ms':    String(tTotal),
          'X-Snap-Cache':         snapCacheStatus,
          'X-Quotes-Cache':       `${quoteMap.size - missedSymbols.size}hit/${missedSymbols.size}miss/${staleQuoteSymbols.size}stale`,
        })
      }
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
