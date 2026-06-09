import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)
import * as q from '../db/queries'

const AccountSchema = z.object({
  name:        z.string().min(1),
  type:        z.enum(['Brokerage','Roth IRA','Traditional IRA','401k','HSA',
                       'RRSP','TFSA','FHSA','RESP','Crypto']),
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
  const id = c.req.param('id')
  const db = c.env.DB

  // Cascade deletes for all account-scoped tables, plus wipe aggregate so it can be cleanly recomputed
  await db.batch([
    db.prepare('DELETE FROM transactions    WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM recurring_rules WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM nav_snapshots   WHERE account_id = ?').bind(id),
    db.prepare("DELETE FROM holding_marks   WHERE holding_key LIKE ? || ':%'").bind(id),
    db.prepare("DELETE FROM nav_snapshots   WHERE account_id = ''"),  // wipe aggregate
    db.prepare('DELETE FROM accounts        WHERE id = ?').bind(id),
  ])

  // Remove deleted account from goals' account_ids JSON arrays
  const { results: goals = [] } = await db
    .prepare('SELECT id, account_ids FROM goals WHERE account_ids IS NOT NULL')
    .all<{ id: string; account_ids: string }>()
  for (const goal of goals) {
    const ids: string[] = JSON.parse(goal.account_ids ?? '[]')
    if (!ids.includes(id)) continue
    const updated = ids.filter(x => x !== id)
    await db.prepare('UPDATE goals SET account_ids = ? WHERE id = ?')
      .bind(JSON.stringify(updated), goal.id).run()
  }

  // Remove deleted account from allocation_plans' scope_account_ids JSON arrays
  const { results: plans = [] } = await db
    .prepare('SELECT id, scope_account_ids FROM allocation_plans WHERE scope_account_ids IS NOT NULL')
    .all<{ id: string; scope_account_ids: string }>()
  for (const plan of plans) {
    const ids: string[] = JSON.parse(plan.scope_account_ids ?? '[]')
    if (!ids.includes(id)) continue
    const updated = ids.filter(x => x !== id)
    await db.prepare('UPDATE allocation_plans SET scope_account_ids = ? WHERE id = ?')
      .bind(JSON.stringify(updated), plan.id).run()
  }

  // Recompute the aggregate nav snapshot (account_id='') to exclude deleted account's rows
  await db.prepare(`
    INSERT INTO nav_snapshots (snap_date, snap_hour, account_id, value, source)
    SELECT snap_date, 23, '', SUM(value), 'market'
    FROM nav_snapshots WHERE account_id != '' AND source = 'market'
    GROUP BY snap_date
    ON CONFLICT(snap_date, snap_hour, account_id) DO UPDATE SET value = excluded.value, source = excluded.source
  `).run()

  return c.json({ ok: true })
})

export default app
