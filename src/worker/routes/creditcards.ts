import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

const CardSchema = z.object({
  name:                z.string().min(1),
  issuer:              z.string().min(1),
  network:             z.enum(['Visa', 'Mastercard', 'Amex']).default('Visa'),
  market:              z.enum(['US', 'CA']).default('US'),
  status:              z.enum(['active', 'cancelled']).default('active'),
  open_date:           z.string(),
  cancel_date:         z.string().nullable().optional(),
  annual_fee:          z.number().min(0).default(0),
  first_year_free:     z.number().int().min(0).max(1).default(0),
  bureau:              z.enum(['Experian', 'Equifax', 'TransUnion']).default('Experian'),
  hard_pull:           z.number().int().min(0).max(1).default(1),
  bonus:               z.number().int().min(0).default(0),
  currency:            z.enum(['MR', 'UR', 'C1', 'TYP', 'Aeroplan', 'Avion', 'ScenePlus', 'Cash']).default('UR'),
  bonus_met:           z.number().int().min(0).max(1).default(0),
  bonus_met_date:      z.string().nullable().optional(),
  min_spend_req:       z.number().min(0).default(0),
  min_spend_deadline:  z.string().nullable().optional(),
  min_spend_current:   z.number().min(0).default(0),
  points_balance:      z.number().int().min(0).default(0),
  note:                z.string().nullable().optional(),
  c1:                  z.string().default('#1d6b4a'),
  c2:                  z.string().default('#0f4530'),
})

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM credit_cards ORDER BY open_date DESC')
    .all()
  return c.json(results)
})

app.get('/:id', async (c) => {
  const card = await c.env.DB
    .prepare('SELECT * FROM credit_cards WHERE id = ?')
    .bind(c.req.param('id'))
    .first()
  if (!card) return c.json({ error: 'Not found' }, 404)
  return c.json(card)
})

app.post('/', zValidator('json', CardSchema), async (c) => {
  const body = c.req.valid('json')
  const id = `cc_${uid()}`
  await c.env.DB.prepare(`
    INSERT INTO credit_cards
      (id, name, issuer, network, market, status, open_date, cancel_date,
       annual_fee, first_year_free, bureau, hard_pull,
       bonus, currency, bonus_met, bonus_met_date,
       min_spend_req, min_spend_deadline, min_spend_current,
       points_balance, note, c1, c2)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, body.name, body.issuer, body.network, body.market, body.status,
    body.open_date, body.cancel_date ?? null,
    body.annual_fee, body.first_year_free, body.bureau, body.hard_pull,
    body.bonus, body.currency, body.bonus_met, body.bonus_met_date ?? null,
    body.min_spend_req, body.min_spend_deadline ?? null, body.min_spend_current,
    body.points_balance, body.note ?? null, body.c1, body.c2,
  ).run()
  return c.json({ ok: true, id }, 201)
})

app.patch('/:id', zValidator('json', CardSchema.partial()), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const fields = Object.keys(body) as (keyof typeof body)[]
  if (fields.length === 0) return c.json({ ok: true })
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => body[f] ?? null)
  await c.env.DB.prepare(`UPDATE credit_cards SET ${set} WHERE id = ?`)
    .bind(...values, id).run()
  return c.json({ ok: true })
})

app.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM credit_cards WHERE id = ?')
    .bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

export default app
