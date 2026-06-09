import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import * as q from '../db/queries'
import { computeHoldings } from '../lib/positions'
import { isCrypto, fetchFinnhubQuote, fetchCoinGeckoQuote } from '../lib/market'
import { createSnapClient } from '../lib/snaptrade'
import type { SnapUnifiedPosition } from '../lib/snaptrade'
import type { Holding, Quote, AssetKind } from '@shared/types'

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
  if (kind === 'option' || kind === 'mutual_fund') return { price: fallback }
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

function snapKind(typeName?: string): AssetKind {
  const t = (typeName ?? '').toLowerCase()
  if (t.includes('etf')) return 'etf'
  if (t.includes('crypto') || t.includes('digital')) return 'crypto'
  if (t.includes('option')) return 'option'
  if (t.includes('mutual') || t.includes('fund')) return 'mutual_fund'
  return 'stock'
}

// Maps instrument.kind from the unified /positions/all endpoint to AssetKind
function unifiedKind(kind: string): AssetKind {
  switch (kind) {
    case 'etf':         return 'etf'
    case 'crypto':      return 'crypto'
    case 'mutualfund':  return 'mutual_fund'
    case 'option':      return 'option'
    case 'cef':         return 'etf'
    case 'adr':
    case 'stock':
    default:            return 'stock'
  }
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const accountId = c.req.query('accountId') ?? undefined
  const withPrices = c.req.query('prices') !== 'false'

  // ── Determine which accounts are SnapTrade-linked ───────────
  const allAccounts = await c.env.DB
    .prepare('SELECT id, snaptrade_account_id FROM accounts')
    .all<{ id: string; snaptrade_account_id: string | null }>()

  const linkedMap = new Map<string, string>() // d1_account_id → snap_account_id
  const reverseMap = new Map<string, string>() // snap_account_id → d1_account_id
  for (const a of allAccounts.results ?? []) {
    if (a.snaptrade_account_id) {
      linkedMap.set(a.id, a.snaptrade_account_id)
      reverseMap.set(a.snaptrade_account_id, a.id)
    }
  }

  // If filtering by a specific account, check if it's linked
  const isLinked = accountId ? linkedMap.has(accountId) : false

  // ── Fetch D1-computed holdings ─────────────────────────────
  // For unlinked accounts: all kinds.
  // For linked accounts: options only (SnapTrade doesn't expose option positions).
  const marks = await q.getHoldingMarks(c.env.DB)
  let d1Holdings: Holding[] = []

  {
    const transactions = await q.getAllTransactionsForHoldings(c.env.DB, accountId)
    const raw = computeHoldings(transactions).filter(h =>
      linkedMap.has(h.account_id) ? h.kind === 'option' : true
    )

    d1Holdings = await Promise.all(
      raw.map(async (h) => {
        let qt: ResolvedQuote
        if (marks[h.id] != null) qt = { price: marks[h.id] }
        else if (!withPrices) qt = { price: h.cost }
        else qt = await resolveQuote(h.symbol, h.kind, h.cost, c.env)
        return {
          ...h,
          name: SYMBOL_NAMES[h.symbol] ?? h.symbol,
          px: qt.price,
          change: qt.change,
          changePct: qt.changePct,
          marked: marks[h.id] != null,
        }
      })
    )
  }

  // ── Fetch SnapTrade positions for linked accounts ───────────
  let snapHoldings: Holding[] = []
  const hasLinked = linkedMap.size > 0

  if (hasLinked && (!accountId || isLinked)) {
    const snapUser = await c.env.DB
      .prepare('SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = ?')
      .bind('singleton')
      .first<{ snaptrade_user_id: string; user_secret: string }>()

    if (snapUser) {
      const snap = createSnapClient(c.env.SNAPTRADE_CLIENT_ID, c.env.SNAPTRADE_CONSUMER_KEY)
      const userAuth = { userId: snapUser.snaptrade_user_id, userSecret: snapUser.user_secret }

      // Determine which snap account IDs to fetch
      const snapAccountIds = accountId
        ? (linkedMap.get(accountId) ? [linkedMap.get(accountId)!] : [])
        : [...reverseMap.keys()]

      for (const snapAccId of snapAccountIds) {
        const d1Id = reverseMap.get(snapAccId)
        if (!d1Id) continue

        let unified: SnapUnifiedPosition[] = []
        let balances: import('../lib/snaptrade').SnapBalance[] = []

        try {
          // Unified endpoint returns equities + options in one call
          [unified, balances] = await Promise.all([
            snap.getAccountAllPositions(userAuth, snapAccId),
            snap.getAccountBalances(userAuth, snapAccId),
          ])
        } catch (e) {
          console.error(`SnapTrade fetch failed for ${snapAccId}:`, e)
          continue
        }

        for (const pos of unified) {
          const instrKind = (pos.instrument?.kind ?? '').toLowerCase()
          const qty  = Number(pos.units) || 0
          const cost = Number(pos.cost_basis) || 0
          const livePrice = pos.price != null ? Number(pos.price) : undefined

          // ── Option position ───────────────────────────────────
          if (instrKind === 'option') {
            const inst = pos.instrument
            const underlying = inst.underlying?.symbol ?? 'UNKNOWN'
            const optType    = (inst.option_type ?? '').toLowerCase() === 'put' ? 'put' : 'call'
            const strike     = Number(inst.strike_price) || 0
            const expiry     = (inst.expiration_date ?? '').slice(0, 10)
            const holdingId  = `${d1Id}:${underlying}:${optType}:${strike}:${expiry}`
            const multiplier = inst.is_mini_option ? 10 : (inst.multiplier ?? 100)
            // cost_basis from SnapTrade is average cost per contract (per multiplier shares),
            // NOT the total position cost. Divide by multiplier only.
            const totalCost  = Number(pos.cost_basis) || 0
            const costPerShare = totalCost / multiplier
            const px         = marks[holdingId] != null ? marks[holdingId] : (livePrice ?? costPerShare)

            snapHoldings.push({
              id:          holdingId,
              account_id:  d1Id,
              symbol:      underlying,
              name:        `${underlying} ${optType === 'put' ? 'P' : 'C'}${strike} ${expiry.slice(5).replace('-', '/')}`,
              kind:        'option',
              qty,
              cost:        costPerShare,
              px,
              marked:      marks[holdingId] != null,
              option_type: optType,
              strike,
              expiry,
              underlying,
              multiplier,
            })
            continue
          }

          // ── Equity / ETF / crypto / mutual fund position ──────
          const sym  = pos.instrument?.symbol ?? 'UNKNOWN'
          const kind = unifiedKind(instrKind)
          const holdingId = `${d1Id}:${sym}`

          let qt: ResolvedQuote
          if (marks[holdingId] != null) qt = { price: marks[holdingId] }
          else if (livePrice != null) qt = { price: livePrice }
          else if (!withPrices) qt = { price: cost }
          else qt = await resolveQuote(sym, kind, cost, c.env)

          snapHoldings.push({
            id: holdingId,
            account_id: d1Id,
            symbol: sym,
            name: pos.instrument?.description ?? SYMBOL_NAMES[sym] ?? sym,
            kind,
            qty,
            cost,
            px: qt.price,
            change: qt.change,
            changePct: qt.changePct,
            marked: marks[holdingId] != null,
          })
        }

        // Map cash balances
        for (const bal of balances) {
          if ((bal.cash ?? 0) <= 0) continue
          const cashId = `${d1Id}:CASH`
          snapHoldings.push({
            id: cashId,
            account_id: d1Id,
            symbol: 'CASH',
            name: `Cash (${bal.currency?.code ?? 'USD'})`,
            kind: 'cash',
            qty: bal.cash,
            cost: 1,
            px: 1,
            marked: false,
          })
        }
      }
    }
  }

  return c.json([...d1Holdings, ...snapHoldings])
})

app.get('/quote/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  const kind = isCrypto(symbol) ? 'crypto' : 'stock'
  const qt = await resolveQuote(symbol, kind, 0, c.env)
  return c.json(qt)
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
