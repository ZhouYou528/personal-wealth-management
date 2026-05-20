import { Hono } from 'hono'
import type { Env } from '../types'
import * as q from '../db/queries'
import { computeHoldings } from '../lib/positions'

const app = new Hono<{ Bindings: Env }>()

// GET /api/nav?days=365&accountId=acc_rrsp
app.get('/', async (c) => {
  const days = Number(c.req.query('days') ?? 365)
  const accountId = c.req.query('accountId') ?? undefined
  const snapshots = await q.getNavSnapshots(c.env.DB, days, accountId)
  return c.json(snapshots)
})

// POST /api/nav/backfill — compute cost-basis snapshots for each transaction date
// Called after bulk CSV import to populate historical chart data.
app.post('/backfill', async (c) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => ({}))
  const { accountId } = body

  async function backfillAccount(filterById: string | undefined, storeId: string) {
    const txs = await q.getAllTransactionsForHoldings(c.env.DB, filterById)
    // Wipe-and-rebuild so deleted transactions don't leave stale snapshots behind
    await c.env.DB.prepare('DELETE FROM nav_snapshots WHERE account_id = ?').bind(storeId).run()
    const dates = [...new Set(txs.map(t => t.tx_date.slice(0, 10)))].sort()
    for (const date of dates) {
      const upTo = txs.filter(t => t.tx_date.slice(0, 10) <= date)
      const holdings = computeHoldings(upTo)
      const value = holdings.reduce((sum, h) => {
        if (h.symbol === 'CASH') return sum + h.qty
        return sum + h.qty * h.cost * (h.multiplier ?? 1)
      }, 0)
      await q.upsertNavSnapshot(c.env.DB, { snap_date: date, account_id: storeId, value })
    }
    return dates.length
  }

  if (accountId) await backfillAccount(accountId, accountId)
  const total = await backfillAccount(undefined, '')

  return c.json({ ok: true, dates: total })
})

export default app
