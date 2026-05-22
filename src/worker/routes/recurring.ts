import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import type { RecurringRule } from '@shared/types'
import { fireRule, fireAllRules, nextFireDate } from '../lib/recurring'

const app = new Hono<{ Bindings: Env }>()

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

const RuleSchema = z.object({
  account_id: z.string(),
  tx_type:    z.enum(['buy','sell','buy_option','sell_option','buy_crypto','sell_crypto',
                      'deposit','withdraw','transfer','transfer_in','transfer_out',
                      'dividend','interest','recurring','split']),
  symbol:     z.string().optional(),
  kind:       z.enum(['stock','etf','mutual_fund','option','crypto','cash']).optional(),
  qty:        z.number().nonnegative().optional(),
  price:      z.number().nonnegative().optional(),
  total:      z.number(),
  frequency:  z.enum(['biweekly','monthly','quarterly']),
  start_date: z.string(),
  end_date:   z.string().optional(),
  active:     z.number().int().min(0).max(1).optional(),
  note:       z.string().optional(),
})

app.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM recurring_rules ORDER BY active DESC, start_date ASC')
    .all<RecurringRule>()
  // Decorate with next_due for the UI
  const decorated = results.map(r => ({
    ...r,
    next_due: r.active
      ? (r.last_fired ? nextFireDate(r.last_fired, r.frequency) : r.start_date)
      : null,
  }))
  return c.json(decorated)
})

app.post('/', zValidator('json', RuleSchema), async (c) => {
  const body = c.req.valid('json')
  const id = `rec_${uid()}`
  await c.env.DB.prepare(`
    INSERT INTO recurring_rules
      (id, account_id, tx_type, symbol, kind, qty, price, total,
       frequency, start_date, end_date, active, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, body.account_id, body.tx_type,
    body.symbol ?? null, body.kind ?? null,
    body.qty ?? null, body.price ?? null, body.total,
    body.frequency, body.start_date, body.end_date ?? null,
    body.active ?? 1, body.note ?? null,
  ).run()
  return c.json({ ok: true, id }, 201)
})

app.patch('/:id', zValidator('json', RuleSchema.partial()), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const fields = Object.keys(body) as (keyof typeof body)[]
  if (fields.length === 0) return c.json({ ok: true })
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => body[f] ?? null)
  await c.env.DB.prepare(`UPDATE recurring_rules SET ${set} WHERE id = ?`)
    .bind(...values, id).run()
  return c.json({ ok: true })
})

app.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM recurring_rules WHERE id = ?')
    .bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// Fire ONE rule on demand (testing / catch-up)
app.post('/:id/run', async (c) => {
  const rule = await c.env.DB
    .prepare('SELECT * FROM recurring_rules WHERE id = ?')
    .bind(c.req.param('id'))
    .first<RecurringRule>()
  if (!rule) return c.json({ error: 'Not found' }, 404)
  const fired = await fireRule(c.env.DB, rule)
  return c.json({ ok: true, fired })
})

// Fire ALL active rules on demand (the daily cron also does this)
app.post('/run-all', async (c) => {
  const result = await fireAllRules(c.env.DB)
  return c.json({ ok: true, result })
})

export default app
