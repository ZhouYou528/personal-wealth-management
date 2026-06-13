import { Hono } from 'hono'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()

// POST /api/ibkr-flex/sync — sync all IBKR accounts via Flex Web Service.
// Subject to a 60s debounce shared across the two IBKR accounts since one
// Flex call always covers both.
app.post('/sync', async (c) => {
  const { syncIbkrFlex } = await import('../lib/ibkr-flex')

  if (!c.env.IBKR_FLEX_TOKEN || !c.env.IBKR_FLEX_QUERY_ID) {
    return c.json({ error: 'IBKR Flex not configured' }, 400)
  }

  // Debounce: check the most-recently-synced IBKR account
  const lastSync = await c.env.DB
    .prepare("SELECT MAX(last_synced_at) as m FROM accounts WHERE institution = 'Interactive Brokers'")
    .first<{ m: string | null }>()
  if (lastSync?.m) {
    const elapsed = (Date.now() - new Date(lastSync.m).getTime()) / 1000
    if (elapsed < 60) {
      return c.json({ error: 'rate-limited', retry_after: Math.ceil(60 - elapsed) }, 429)
    }
  }

  try {
    const result = await syncIbkrFlex(c.env.DB, {
      token: c.env.IBKR_FLEX_TOKEN,
      queryId: c.env.IBKR_FLEX_QUERY_ID,
    })
    return c.json(result)
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export default app
