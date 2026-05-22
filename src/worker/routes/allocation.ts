import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import type { AllocationPlan } from '@shared/types'

const app = new Hono<{ Bindings: Env }>()
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

type PlanRow = Omit<AllocationPlan, 'targets' | 'scope_account_ids'> & {
  targets: string
  scope_account_ids: string | null
}

function parsePlan(row: PlanRow): AllocationPlan {
  let scope: string[] | undefined
  let targets: AllocationPlan['targets'] = {}
  if (row.scope_account_ids) {
    try { scope = JSON.parse(row.scope_account_ids) } catch {}
  }
  try { targets = JSON.parse(row.targets) } catch {}
  return { ...row, scope_account_ids: scope, targets }
}

const PlanBody = z.object({
  name:              z.string().min(1),
  scope_account_ids: z.array(z.string()).optional(),
  targets:           z.record(z.number().min(0).max(100)),
  drift_threshold:   z.number().min(0).max(100).default(5),
  active:            z.number().int().min(0).max(1).optional(),
})

app.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM allocation_plans ORDER BY active DESC, created_at DESC')
    .all<PlanRow>()
  return c.json(results.map(parsePlan))
})

app.post('/', zValidator('json', PlanBody), async (c) => {
  const body = c.req.valid('json')
  const id = `alloc_${uid()}`
  await c.env.DB.prepare(`
    INSERT INTO allocation_plans (id, name, scope_account_ids, targets, drift_threshold, active)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id, body.name,
    body.scope_account_ids && body.scope_account_ids.length > 0 ? JSON.stringify(body.scope_account_ids) : null,
    JSON.stringify(body.targets),
    body.drift_threshold,
    body.active ?? 1,
  ).run()
  return c.json({ ok: true, id }, 201)
})

app.patch('/:id', zValidator('json', PlanBody.partial()), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const fields = Object.keys(body) as (keyof typeof body)[]
  if (fields.length === 0) return c.json({ ok: true })
  const set = fields.map(f => `${f} = ?`).join(', ')
  const values = fields.map(f => {
    const v = body[f]
    if (f === 'scope_account_ids') return Array.isArray(v) && v.length > 0 ? JSON.stringify(v) : null
    if (f === 'targets') return JSON.stringify(v)
    return v ?? null
  })
  await c.env.DB.prepare(`UPDATE allocation_plans SET ${set} WHERE id = ?`)
    .bind(...values, id).run()
  return c.json({ ok: true })
})

app.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM allocation_plans WHERE id = ?')
    .bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

export default app
