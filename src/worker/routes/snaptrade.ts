import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../types'
import { createSnapClient } from '../lib/snaptrade'
import type { SnapUser } from '../lib/snaptrade'

const app = new Hono<{ Bindings: Env }>()

// ── Helpers ────────────────────────────────────────────────────

function client(env: Env) {
  return createSnapClient(env.SNAPTRADE_CLIENT_ID, env.SNAPTRADE_CONSUMER_KEY)
}

async function getStoredUser(db: D1Database): Promise<SnapUser | null> {
  const row = await db
    .prepare('SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = ?')
    .bind('singleton')
    .first<{ snaptrade_user_id: string; user_secret: string }>()
  if (!row) return null
  return { userId: row.snaptrade_user_id, userSecret: row.user_secret }
}

async function requireUser(db: D1Database): Promise<SnapUser> {
  const u = await getStoredUser(db)
  if (!u) throw new Error('Not registered with SnapTrade')
  return u
}

// ── Debug: test signing against /brokerages (GET, no body) ────

app.get('/debug-auth-old', async (c) => {
  const clientId    = c.env.SNAPTRADE_CLIENT_ID?.trim()
  const consumerKey = c.env.SNAPTRADE_CONSUMER_KEY?.trim()
  const timestamp   = Math.floor(Date.now() / 1000)
  const enc         = new TextEncoder()

  async function hmac(key: string | Uint8Array, msg: string): Promise<string> {
    const keyBytes = typeof key === 'string' ? enc.encode(key) : key
    const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const s = await crypto.subtle.sign('HMAC', k, enc.encode(msg))
    const b = new Uint8Array(s)
    let bin = ''; for (let i = 0; i < b.byteLength; i++) bin += String.fromCharCode(b[i])
    return btoa(bin)
  }

  // Attempt: base64-decode the consumer key first (some APIs provide key in b64)
  let keyDecoded: Uint8Array | null = null
  try {
    const padded = consumerKey + '='.repeat((4 - consumerKey.length % 4) % 4)
    keyDecoded = Uint8Array.from(atob(padded), ch => ch.charCodeAt(0))
  } catch { keyDecoded = null }

  const testBody = { userId: 'debug_test_user_abc123' }
  const bodyStr  = JSON.stringify(testBody)

  const variants = [
    { name: 'ts_only_strkey',             msg: String(timestamp),                        key: consumerKey },
    { name: 'ts+body_strkey',             msg: String(timestamp) + bodyStr,               key: consumerKey },
    { name: 'ts+nl+body_strkey',          msg: String(timestamp) + '\n' + bodyStr,        key: consumerKey },
    { name: 'ts_only_b64key',             msg: String(timestamp),                        key: keyDecoded ?? enc.encode(consumerKey) },
    { name: 'ts+body_b64key',             msg: String(timestamp) + bodyStr,               key: keyDecoded ?? enc.encode(consumerKey) },
  ]

  const results: Record<string, unknown>[] = []

  for (const v of variants) {
    const sig = await hmac(v.key, v.msg)
    const qs  = new URLSearchParams({ clientId, timestamp: String(timestamp) })
    const res = await fetch(`https://api.snaptrade.com/api/v1/snapTrade/registerUser?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Signature': sig },
      body: bodyStr,
    })
    const text = await res.text()
    results.push({ variant: v.name, status: res.status, snippet: text.slice(0, 120) })
    // Stop on first success
    if (res.status !== 401) break
  }

  // Also test if /brokerages validates signatures (wrong sig → should 401 if protected)
  const wrongSig  = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  const brokQs    = new URLSearchParams({ clientId, timestamp: String(timestamp) })
  const brokRes   = await fetch(`https://api.snaptrade.com/api/v1/brokerages?${brokQs}`, {
    headers: { 'Content-Type': 'application/json', 'Signature': wrongSig },
  })

  return c.json({
    keyLength: consumerKey?.length,
    keyDecodedLength: keyDecoded?.length ?? null,
    brokeragesWithWrongSig: brokRes.status,  // if 200 → endpoint is public, our earlier test was useless
    variants: results,
  })
})

// ── Brokerages (public, no user auth) ─────────────────────────

app.get('/brokerages', async (c) => {
  try {
    const all = await client(c.env).listBrokerages()
    return c.json(all.filter(b => b.enabled && !b.maintenance_mode))
  } catch (e) {
    console.error('SnapTrade brokerages error:', e)
    return c.json({ error: String(e) }, 500)
  }
})

// ── Status ─────────────────────────────────────────────────────

app.get('/status', async (c) => {
  const user = await getStoredUser(c.env.DB)
  if (!user) return c.json({ registered: false })

  // Check how many accounts are linked
  const linked = await c.env.DB
    .prepare('SELECT COUNT(*) as n FROM accounts WHERE snaptrade_account_id IS NOT NULL')
    .first<{ n: number }>()

  return c.json({ registered: true, linkedAccounts: linked?.n ?? 0 })
})

// ── Register ───────────────────────────────────────────────────

app.post('/register', async (c) => {
  try {
    const existing = await getStoredUser(c.env.DB)
    if (existing) return c.json({ ok: true, already: true })

    const userId = `pwm${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const snap = await client(c.env).registerUser(userId)

    await c.env.DB
      .prepare('INSERT INTO snaptrade_users (id, snaptrade_user_id, user_secret) VALUES (?, ?, ?)')
      .bind('singleton', snap.userId, snap.userSecret)
      .run()

    return c.json({ ok: true })
  } catch (e) {
    console.error('SnapTrade register error:', e)
    return c.json({ error: String(e) }, 500)
  }
})

// ── Delete / reset ─────────────────────────────────────────────

app.delete('/register', async (c) => {
  const user = await getStoredUser(c.env.DB)
  if (user) {
    await client(c.env).deleteUser(user).catch(() => {})
    await c.env.DB.prepare('DELETE FROM snaptrade_users WHERE id = ?').bind('singleton').run()
    await c.env.DB
      .prepare('UPDATE accounts SET snaptrade_account_id = NULL')
      .run()
  }
  return c.json({ ok: true })
})

// ── Connect: get broker OAuth URL ─────────────────────────────

app.post(
  '/connect',
  zValidator('json', z.object({
    broker: z.string().optional(),
    redirectUri: z.string().optional(),
  })),
  async (c) => {
    try {
      const user = await requireUser(c.env.DB)
      const { broker, redirectUri } = c.req.valid('json')
      const result = await client(c.env).getLoginUrl(user, { broker, redirectUri })
      return c.json({ url: result.redirectURI })
    } catch (e) {
      console.error('SnapTrade connect error:', e)
      return c.json({ error: String(e) }, 500)
    }
  },
)

// ── List broker accounts (after OAuth) ────────────────────────

app.get('/broker-accounts', async (c) => {
  try {
    const user = await requireUser(c.env.DB)
    const snapAccounts = await client(c.env).listAccounts(user)

    const linked = await c.env.DB
      .prepare('SELECT id, name, snaptrade_account_id FROM accounts WHERE snaptrade_account_id IS NOT NULL')
      .all<{ id: string; name: string; snaptrade_account_id: string }>()
    const linkedMap = Object.fromEntries((linked.results ?? []).map(r => [r.snaptrade_account_id, r]))

    return c.json(snapAccounts.map(sa => ({
      id: sa.id,
      name: sa.name,
      institution: sa.institution_name,
      number: sa.meta?.account_number ?? '',
      type: sa.meta?.type ?? '',
      linkedTo: linkedMap[sa.id] ?? null,
    })))
  } catch (e) {
    console.error('SnapTrade broker-accounts error:', e)
    return c.json({ error: String(e) }, 500)
  }
})

// ── Import accounts after OAuth ───────────────────────────────

const ACCOUNT_TYPE_MAP: Record<string, string> = {
  RRSP: 'RRSP', TFSA: 'TFSA', FHSA: 'FHSA', RESP: 'RESP',
  'ROTH IRA': 'Roth IRA', 'TRADITIONAL IRA': 'Traditional IRA',
  TRAD_IRA: 'Traditional IRA', ROTH_IRA: 'Roth IRA',
  '401K': '401k', HSA: 'HSA', CRYPTO: 'Crypto',
}

function mapAccountType(snapType?: string): string {
  if (!snapType) return 'Brokerage'
  const t = snapType.toUpperCase()
  for (const [key, val] of Object.entries(ACCOUNT_TYPE_MAP)) {
    if (t.includes(key)) return val
  }
  return 'Brokerage'
}

const BROKER_COLORS: Record<string, string> = {
  IBKR: '#e60000', ROBINHOOD: '#00c805', TD: '#2c5e3a', RBC: '#005daa',
  BMO: '#0079c1', CIBC: '#8b0000', SCOTIA: '#e31837', WEALTHSIMPLE: '#000000',
  QUESTRADE: '#E6A817', FIDELITY: '#4f8c32', SCHWAB: '#0035b5',
}

function brokerColor(institution: string): string {
  const slug = institution.toUpperCase()
  for (const [key, color] of Object.entries(BROKER_COLORS)) {
    if (slug.includes(key)) return color
  }
  return '#10B981'
}

const uid = () => `acc_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`

app.post(
  '/import-accounts',
  zValidator('json', z.object({
    accounts: z.array(z.object({
      snapAccountId: z.string(),
      action: z.enum(['create', 'skip']),
      name: z.string().optional(),          // for 'create'
      institution: z.string().optional(),
      accountType: z.string().optional(),
    })),
  })),
  async (c) => {
    try {
      const user = await requireUser(c.env.DB)
      const { accounts } = c.req.valid('json')

      const snapAccounts = await client(c.env).listAccounts(user)
      const snapById = Object.fromEntries(snapAccounts.map(a => [a.id, a]))

      const results: { snapAccountId: string; d1AccountId: string; action: string }[] = []

      for (const item of accounts) {
        if (item.action === 'skip') continue
        const snapAcc = snapById[item.snapAccountId]
        if (!snapAcc) continue

        if (item.action === 'create') {
          const institution = item.institution ?? snapAcc.institution_name ?? ''
          const name = item.name ?? snapAcc.name ?? institution
          const accountType = item.accountType ?? mapAccountType(snapAcc.meta?.type)
          const color = brokerColor(institution)
          const number = snapAcc.meta?.account_number ?? ''
          const newId = uid()

          await c.env.DB
            .prepare('INSERT INTO accounts (id, name, type, institution, color, number, snaptrade_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(newId, name, accountType, institution, color, number, item.snapAccountId)
            .run()
          results.push({ snapAccountId: item.snapAccountId, d1AccountId: newId, action: 'created' })
        }
      }

      return c.json({ ok: true, results })
    } catch (e) {
      console.error('SnapTrade import-accounts error:', e)
      return c.json({ error: String(e) }, 500)
    }
  },
)

// ── Holdings (raw, for merging on the holdings route) ─────────

app.get('/holdings', async (c) => {
  const user = await requireUser(c.env.DB)
  const data = await client(c.env).getHoldings(user)
  return c.json(data)
})

// ── Activities ────────────────────────────────────────────────

app.get('/activities', async (c) => {
  const user = await requireUser(c.env.DB)
  const startDate = c.req.query('startDate')
  const endDate   = c.req.query('endDate')
  const data = await client(c.env).getActivities(user, startDate, endDate)
  return c.json(data)
})

// ── Debug: dump raw SnapTrade activities for an account ───────
app.get('/debug-positions', async (c) => {
  const d1AccountId = c.req.query('accountId')
  if (!d1AccountId) return c.json({ error: 'accountId required' }, 400)

  const acct = await c.env.DB
    .prepare('SELECT snaptrade_account_id FROM accounts WHERE id = ?')
    .bind(d1AccountId)
    .first<{ snaptrade_account_id: string | null }>()

  if (!acct?.snaptrade_account_id)
    return c.json({ error: 'Account not linked to SnapTrade' }, 400)

  const snapUser = await getStoredUser(c.env.DB)
  if (!snapUser) return c.json({ error: 'No SnapTrade user' }, 400)

  const snap = client(c.env)
  try {
    const positions = await snap.getAccountAllPositions(snapUser, acct.snaptrade_account_id)
    return c.json({ snapAccountId: acct.snaptrade_account_id, count: positions.length, positions })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

app.get('/debug-activities', async (c) => {
  const d1AccountId = c.req.query('accountId')
  if (!d1AccountId) return c.json({ error: 'accountId required' }, 400)

  const acct = await c.env.DB
    .prepare('SELECT snaptrade_account_id FROM accounts WHERE id = ?')
    .bind(d1AccountId)
    .first<{ snaptrade_account_id: string | null }>()

  if (!acct?.snaptrade_account_id)
    return c.json({ error: 'Account not linked to SnapTrade' }, 400)

  const snapUser = await getStoredUser(c.env.DB)
  if (!snapUser) return c.json({ error: 'No SnapTrade user' }, 400)

  const snap = client(c.env)
  const startDate = c.req.query('startDate') ?? new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10)
  const endDate   = c.req.query('endDate')   ?? new Date().toISOString().slice(0, 10)

  try {
    const activities = await snap.getAccountActivities(snapUser, acct.snaptrade_account_id, startDate, endDate)
    return c.json({
      snapAccountId: acct.snaptrade_account_id,
      startDate,
      endDate,
      count: activities.length,
      // Show all activity types with their raw symbol field
      symbolSummary: activities.map(a => ({
        id: a.id,
        type: a.type,
        trade_date: a.trade_date,
        rawSymbol: a.symbol,
        resolvedTicker: (a.symbol as any)?.symbol?.symbol ?? (a.symbol as any)?.symbol ?? null,
      })),
      sample: activities.slice(0, 2),
    })
  } catch (e) {
    return c.json({ error: String(e), snapAccountId: acct.snaptrade_account_id, startDate, endDate }, 500)
  }
})

// ── Unified sync: persisted SnapTrade data in D1 ─────────────────
// POST /api/snaptrade/sync/:accountId
//   ?full=1               → no startDate (fetch full available history)
//   ?since=YYYY-MM-DD     → fetch activities from this date forward
//   ?skipActivities=1     → only positions + balances
//   Returns { activities_inserted, positions_upserted, positions_culled,
//             balances_upserted, errors, retry_after? }

app.post('/sync/:accountId', async (c) => {
  const { syncAccount, tryClaimSync } = await import('../lib/sync')

  const d1AccountId = c.req.param('accountId')
  const acct = await c.env.DB
    .prepare('SELECT snaptrade_account_id FROM accounts WHERE id = ?')
    .bind(d1AccountId)
    .first<{ snaptrade_account_id: string | null }>()

  if (!acct?.snaptrade_account_id)
    return c.json({ error: 'Account not linked to SnapTrade' }, 400)

  const claim = await tryClaimSync(c.env.DB, d1AccountId)
  if (!claim.allowed) {
    return c.json({ error: 'rate-limited', retry_after: claim.retryAfter }, 429)
  }

  const snapUser = await getStoredUser(c.env.DB)
  if (!snapUser) return c.json({ error: 'No SnapTrade user' }, 400)

  const snap = client(c.env)
  const full = c.req.query('full') === '1'
  const since = c.req.query('since')
  const skipActivities = c.req.query('skipActivities') === '1'

  const result = await syncAccount(
    c.env.DB, snap, snapUser, d1AccountId, acct.snaptrade_account_id,
    { activitiesStartDate: full ? undefined : (since ?? new Date(Date.now() - 365*86400_000).toISOString().slice(0, 10)), skipActivities }
  )
  return c.json(result)
})

// ── Verification: persisted vs. live activities ──────────────────
// GET /api/snaptrade/sync-verify/:accountId
//   Hits SnapTrade live for activities + compares to what's persisted in D1.
//   Reports counts and any external_ids missing on either side. Used to
//   validate the sync before flipping the read path off the live merge.

app.get('/sync-verify/:accountId', async (c) => {
  const d1AccountId = c.req.param('accountId')
  const startDate = c.req.query('startDate') ?? new Date(Date.now() - 365*86400_000).toISOString().slice(0, 10)
  const endDate   = c.req.query('endDate') ?? new Date().toISOString().slice(0, 10)

  const acct = await c.env.DB
    .prepare('SELECT snaptrade_account_id FROM accounts WHERE id = ?')
    .bind(d1AccountId)
    .first<{ snaptrade_account_id: string | null }>()
  if (!acct?.snaptrade_account_id) return c.json({ error: 'Account not linked' }, 400)

  const snapUser = await getStoredUser(c.env.DB)
  if (!snapUser) return c.json({ error: 'No SnapTrade user' }, 400)

  const snap = client(c.env)
  const live = await snap.getAccountActivities(snapUser, acct.snaptrade_account_id, startDate, endDate)
  const liveIds = new Set(live.map(a => a.id))

  const persisted = await c.env.DB
    .prepare(`SELECT external_id FROM transactions
              WHERE account_id = ? AND source = 'snaptrade'
                AND tx_date >= ? AND tx_date <= ?`)
    .bind(d1AccountId, startDate, endDate)
    .all<{ external_id: string }>()
  const persistedIds = new Set((persisted.results ?? []).map(r => r.external_id))

  const missingInD1   = [...liveIds].filter(id => !persistedIds.has(id))
  const extraInD1     = [...persistedIds].filter(id => !liveIds.has(id))

  return c.json({
    live_count:       live.length,
    persisted_count:  persistedIds.size,
    missing_in_d1:    missingInD1.slice(0, 20),
    missing_in_d1_n:  missingInD1.length,
    extra_in_d1:      extraInD1.slice(0, 20),
    extra_in_d1_n:    extraInD1.length,
  })
})

export default app
