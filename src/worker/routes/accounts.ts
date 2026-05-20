import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)
import * as q from '../db/queries'

const AccountSchema = z.object({
  name:        z.string().min(1),
  type:        z.enum(['RRSP','TFSA','FHSA','RESP','Margin','Cash','Crypto','Non-registered']),
  institution: z.string().default(''),
  color:       z.string().default('#10B981'),
  number:      z.string().default(''),
})

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const accounts = await q.getAccounts(c.env.DB)
  return c.json(accounts)
})

app.get('/:id', async (c) => {
  const account = await q.getAccount(c.env.DB, c.req.param('id'))
  if (!account) return c.json({ error: 'Not found' }, 404)
  return c.json(account)
})

app.post('/', zValidator('json', AccountSchema), async (c) => {
  const body = c.req.valid('json')
  const account = { ...body, id: `acc_${uid()}` }
  await q.insertAccount(c.env.DB, account)
  return c.json(account, 201)
})

app.patch('/:id', zValidator('json', AccountSchema.partial()), async (c) => {
  const id = c.req.param('id')
  const existing = await q.getAccount(c.env.DB, id)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const body = c.req.valid('json')
  await q.updateAccount(c.env.DB, id, body)
  return c.json({ ...existing, ...body })
})

app.delete('/:id', async (c) => {
  await q.deleteAccount(c.env.DB, c.req.param('id'))
  return c.json({ ok: true })
})

export default app
