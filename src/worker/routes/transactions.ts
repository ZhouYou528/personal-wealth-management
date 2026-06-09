import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import type { Transaction, TxType, AssetKind } from '@shared/types'
import { createSnapClient } from '../lib/snaptrade'
import type { SnapActivity } from '../lib/snaptrade'

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
import * as q from '../db/queries'

// ── SnapTrade activity helpers ────────────────────────────────

const SNAP_TX: Record<string, TxType> = {
  BUY: 'buy', SELL: 'sell',
  DIVIDEND: 'dividend', DIV: 'dividend', DIVIDENDS: 'dividend',
  REINVEST_DIVIDEND: 'buy', REINVEST: 'buy',
  INTEREST: 'interest',
  DEPOSIT: 'deposit', CONTRIBUTION: 'deposit',
  WITHDRAWAL: 'withdraw', WITHDRAW: 'withdraw',
  TRANSFER: 'transfer', TRANSFER_IN: 'transfer_in', TRANSFER_OUT: 'transfer_out',
  FEE: 'deposit',
}

function actToTxType(type: string): TxType {
  return SNAP_TX[type.toUpperCase()] ?? 'deposit'
}

function actToKind(a: SnapActivity): AssetKind | undefined {
  if (!a.symbol) return undefined
  const t = (a.symbol.type?.description ?? '').toLowerCase()
  if (t.includes('etf')) return 'etf'
  if (t.includes('crypto')) return 'crypto'
  if (t.includes('mutual')) return 'mutual_fund'
  if (t.includes('option')) return 'option'
  return 'stock'
}

function actMatchKey(date: string, symbol: string | null, qty: number) {
  return `${date}|${(symbol ?? '').toUpperCase()}|${Math.round(qty * 1000)}`
}

const TxSchema = z.object({
  tx_date:      z.string(),
  account_id:   z.string(),
  type:         z.enum(['buy','sell','buy_option','sell_option','buy_crypto','sell_crypto',
                        'deposit','withdraw','transfer','transfer_in','transfer_out',
                        'dividend','interest','recurring','split']),
  symbol:       z.string().optional(),
  kind:         z.enum(['stock','etf','mutual_fund','option','crypto','cash']).optional(),
  qty:          z.number().nonnegative().optional(),
  price:        z.number().nonnegative().optional(),
  total:        z.number(),
  note:         z.string().optional(),
  to_account:   z.string().optional(),
  from_account: z.string().optional(),
  option_type:  z.enum(['call','put']).optional(),
  strike:       z.number().positive().optional(),
  expiry:       z.string().optional(),
  underlying:   z.string().optional(),
})

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const accountId = c.req.query('accountId')
  const symbol    = c.req.query('symbol')
  const limit     = Number(c.req.query('limit') ?? 200)
  const offset    = Number(c.req.query('offset') ?? 0)
  const days      = c.req.query('days')
  const since     = days ? new Date(Date.now() - Number(days) * 86400000).toISOString().slice(0, 10) : undefined

  // Which accounts are SnapTrade-linked?
  const { results: linked = [] } = await c.env.DB
    .prepare('SELECT id, snaptrade_account_id FROM accounts WHERE snaptrade_account_id IS NOT NULL')
    .all<{ id: string; snaptrade_account_id: string }>()

  const relevant = accountId
    ? linked.filter(a => a.id === accountId)
    : linked

  // If no linked accounts involved, fast path
  if (relevant.length === 0) {
    return c.json(await q.getTransactions(c.env.DB, { accountId, symbol, limit, offset, since }))
  }

  // Fetch all D1 transactions (without pagination — we'll paginate after merge)
  const d1Txs = await q.getTransactions(c.env.DB, { accountId, symbol, limit: 10000, offset: 0, since })

  // Build dedup set from D1 entries
  const d1Keys = new Set(d1Txs.map(tx =>
    actMatchKey(tx.tx_date, tx.symbol ?? null, Math.abs(tx.qty ?? 0))
  ))

  // Fetch SnapTrade user credentials
  const snapUser = await c.env.DB
    .prepare('SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = ?')
    .bind('singleton')
    .first<{ snaptrade_user_id: string; user_secret: string }>()

  const snapTxs: Transaction[] = []

  if (snapUser) {
    const snap     = createSnapClient(c.env.SNAPTRADE_CLIENT_ID, c.env.SNAPTRADE_CONSUMER_KEY)
    const userAuth = { userId: snapUser.snaptrade_user_id, userSecret: snapUser.user_secret }
    const startDate = since  // undefined = no lower bound; SnapTrade returns max available history
    const endDate   = new Date().toISOString().slice(0, 10)

    for (const acct of relevant) {
      try {
        let activities: SnapActivity[]
        try {
          activities = await snap.getAccountActivities(userAuth, acct.snaptrade_account_id, startDate, endDate)
        } catch {
          const all = await snap.getActivities(userAuth, startDate, endDate, acct.snaptrade_account_id)
          activities = all.filter(a => a.account.id === acct.snaptrade_account_id)
        }

        for (const a of activities) {
          const date = (a.trade_date ?? a.settlement_date ?? '').slice(0, 10)
          if (!date) continue

          // Option trades have option_symbol populated; equity trades use symbol
          const optSym = a.option_symbol ?? null
          const sym = optSym
            ? (optSym.underlying_symbol?.symbol ?? a.symbol?.symbol ?? null)
            : (a.symbol?.symbol ?? null)

          if (symbol && sym !== symbol) continue
          const qty = Math.abs(a.units)
          if (d1Keys.has(actMatchKey(date, sym, qty))) continue  // already in D1

          snapTxs.push({
            id:           `snap_${a.id}`,
            tx_date:      date,
            account_id:   acct.id,
            type:         actToTxType(a.type),
            symbol:       sym ?? undefined,
            kind:         optSym ? 'option' : actToKind(a),
            qty:          qty || undefined,
            price:        a.price || undefined,
            total:        Math.abs(a.amount),
            note:         a.description || undefined,
            created_at:   date,
            // Option contract details — enables matching to holding in HoldingDetail
            ...(optSym && {
              option_type: (optSym.option_type ?? '').toLowerCase() === 'put' ? 'put' as const : 'call' as const,
              strike:      Number(optSym.strike_price) || undefined,
              expiry:      (optSym.expiration_date ?? '').slice(0, 10) || undefined,
              underlying:  optSym.underlying_symbol?.symbol ?? undefined,
            }),
          })
        }
      } catch (e) {
        console.error(`SnapTrade tx fetch failed for ${acct.snaptrade_account_id}:`, e)
      }
    }
  }

  const merged = [...d1Txs, ...snapTxs].sort((a, b) => b.tx_date.localeCompare(a.tx_date))
  return c.json(merged.slice(offset, offset + limit))
})

app.get('/:id', async (c) => {
  const tx = await q.getTransaction(c.env.DB, c.req.param('id'))
  if (!tx) return c.json({ error: 'Not found' }, 404)
  return c.json(tx)
})

app.post('/', zValidator('json', TxSchema), async (c) => {
  const body = c.req.valid('json')
  const tx = { ...body, id: `tx_${uid()}` }
  await q.insertTransaction(c.env.DB, tx)

  // Auto-create companion cash transaction for option premiums
  if ((tx.type === 'sell_option' || tx.type === 'buy_option') && tx.total !== 0) {
    const companion = {
      id: `otc${uid()}`,
      tx_date: tx.tx_date,
      account_id: tx.account_id,
      type: (tx.type === 'sell_option' ? 'deposit' : 'withdraw') as 'deposit' | 'withdraw',
      symbol: 'CASH' as const,
      kind: 'cash' as const,
      total: tx.total,
      note: `[opt-cash:${tx.id}] Option premium · ${tx.symbol ?? ''}`,
    }
    await q.insertTransaction(c.env.DB, companion)
  }

  return c.json(tx, 201)
})

app.patch('/:id', zValidator('json', TxSchema.partial()), async (c) => {
  const id = c.req.param('id')
  const existing = await q.getTransaction(c.env.DB, id)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const body = c.req.valid('json')
  await q.updateTransaction(c.env.DB, id, body)

  // Sync companion cash tx if the option premium total changed
  if (body.total !== undefined && (existing.type === 'sell_option' || existing.type === 'buy_option')) {
    await c.env.DB.prepare(
      `UPDATE transactions SET total = ? WHERE note LIKE '[opt-cash:' || ? || ']%'`
    ).bind(body.total, id).run()
  }

  return c.json({ ...existing, ...body })
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await q.deleteTransaction(c.env.DB, id)
  // Cascade delete companion cash transaction if this was an option tx
  await c.env.DB.prepare(
    `DELETE FROM transactions WHERE note LIKE '[opt-cash:' || ? || ']%'`
  ).bind(id).run()
  return c.json({ ok: true })
})

// Bulk re-classify all transactions for a symbol (optionally scoped to one account)
app.patch('/by-symbol/:symbol', zValidator('json', z.object({
  kind: z.enum(['stock','etf','mutual_fund','option','crypto','cash']).optional(),
  accountId: z.string().optional(),
})), async (c) => {
  const symbol = c.req.param('symbol')
  const { kind, accountId } = c.req.valid('json')
  const patch: { kind?: 'stock'|'etf'|'mutual_fund'|'option'|'crypto'|'cash' } = {}
  if (kind) patch.kind = kind
  const changed = await q.updateTransactionsBySymbol(c.env.DB, symbol, patch, accountId)
  return c.json({ ok: true, changed })
})

export default app
