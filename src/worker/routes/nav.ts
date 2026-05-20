import { Hono } from 'hono'
import type { Env } from '../types'
import * as q from '../db/queries'

const app = new Hono<{ Bindings: Env }>()

// GET /api/nav?days=365&accountId=acc_rrsp
app.get('/', async (c) => {
  const days = Number(c.req.query('days') ?? 365)
  const accountId = c.req.query('accountId') ?? undefined
  const snapshots = await q.getNavSnapshots(c.env.DB, days, accountId)
  return c.json(snapshots)
})

export default app
