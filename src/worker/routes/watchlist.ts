import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)
import * as q from '../db/queries'

const WatchSchema = z.object({
  symbol: z.string().min(1).toUpperCase(),
  name:   z.string().min(1),
  kind:   z.enum(['stock','etf','crypto','cash']).default('stock'),
})

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const items = await q.getWatchlist(c.env.DB)
  return c.json(items)
})

app.post('/', zValidator('json', WatchSchema), async (c) => {
  const body = c.req.valid('json')
  const item = { ...body, id: `watch_${uid()}` }
  await q.insertWatchlistItem(c.env.DB, item)
  return c.json(item, 201)
})

app.delete('/:id', async (c) => {
  await q.deleteWatchlistItem(c.env.DB, c.req.param('id'))
  return c.json({ ok: true })
})

export default app
