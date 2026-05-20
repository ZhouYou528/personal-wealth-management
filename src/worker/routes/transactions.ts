import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
import * as q from '../db/queries'

const TxSchema = z.object({
  tx_date:      z.string(),
  account_id:   z.string(),
  type:         z.enum(['buy','sell','buy_option','sell_option','buy_crypto','sell_crypto',
                        'deposit','withdraw','transfer','dividend','interest','recurring','split']),
  symbol:       z.string().optional(),
  kind:         z.enum(['stock','etf','option','crypto','cash']).optional(),
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
  const txs = await q.getTransactions(c.env.DB, { accountId, symbol, limit, offset, since })
  return c.json(txs)
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
  return c.json(tx, 201)
})

app.patch('/:id', zValidator('json', TxSchema.partial()), async (c) => {
  const id = c.req.param('id')
  const existing = await q.getTransaction(c.env.DB, id)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const body = c.req.valid('json')
  await q.updateTransaction(c.env.DB, id, body)
  return c.json({ ...existing, ...body })
})

app.delete('/:id', async (c) => {
  await q.deleteTransaction(c.env.DB, c.req.param('id'))
  return c.json({ ok: true })
})

export default app
