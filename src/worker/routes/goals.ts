import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)
import * as q from '../db/queries'

const GoalSchema = z.object({
  name:     z.string().min(1),
  target:   z.number().positive(),
  current:  z.number().default(0),
  deadline: z.string(),
  color:    z.string().default('#10B981'),
  icon:     z.string().default('🎯'),
})

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const goals = await q.getGoals(c.env.DB)
  return c.json(goals)
})

app.post('/', zValidator('json', GoalSchema), async (c) => {
  const body = c.req.valid('json')
  const goal = { ...body, id: `goal_${uid()}` }
  await q.insertGoal(c.env.DB, goal)
  return c.json(goal, 201)
})

app.patch('/:id', zValidator('json', GoalSchema.partial()), async (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')
  await q.updateGoal(c.env.DB, id, body)
  return c.json({ id, ...body })
})

app.delete('/:id', async (c) => {
  await q.deleteGoal(c.env.DB, c.req.param('id'))
  return c.json({ ok: true })
})

export default app
