#!/usr/bin/env node
/**
 * One-time NAV backfill for SnapTrade-linked accounts.
 *
 * Usage:
 *   FINNHUB_KEY=xxx COINGECKO_KEY=yyy node scripts/backfill-nav.mjs [--days 365]
 */

import { execFileSync } from 'child_process'
import { createHmac } from 'crypto'
import { writeFileSync, unlinkSync } from 'fs'
import { argv } from 'process'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Config ────────────────────────────────────────────────────

const FINNHUB_KEY   = process.env.FINNHUB_KEY    || ''
const COINGECKO_KEY = process.env.COINGECKO_KEY  || ''
const CLIENT_ID     = 'PERS-X6S5QBU4D2D93R977042'
const CONSUMER_KEY  = 'Wh4BkUAgTxUylFZMVg98o1Y6HgcQwnbhAoE7VWTied0b3NGjNP'
const SNAP_BASE     = 'https://api.snaptrade.com/api/v1'
const DB            = 'pwm_db'

const daysArg = argv.indexOf('--days')
const DAYS    = daysArg !== -1 ? parseInt(argv[daysArg + 1], 10) : 365

if (!FINNHUB_KEY)   { console.error('Missing FINNHUB_KEY'); process.exit(1) }
if (!COINGECKO_KEY) { console.error('Missing COINGECKO_KEY'); process.exit(1) }

// ── CoinGecko map ─────────────────────────────────────────────

const COINGECKO_ID = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  XRP: 'ripple', ADA: 'cardano', AVAX: 'avalanche-2', DOGE: 'dogecoin',
  DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink',
  UNI: 'uniswap', ATOM: 'cosmos', USDC: 'usd-coin', USDT: 'tether',
  LTC: 'litecoin', BCH: 'bitcoin-cash', SHIB: 'shiba-inu', TON: 'the-open-network',
}
const CRYPTO = new Set(Object.keys(COINGECKO_ID))
const isCrypto = sym => CRYPTO.has(sym.toUpperCase())

// ── SnapTrade auth (mirrors worker/lib/snaptrade.ts) ──────────

function sortedJSON(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return JSON.stringify(val)
  const sorted = {}
  for (const k of Object.keys(val).sort()) sorted[k] = val[k]
  return JSON.stringify(sorted)
}

async function snapFetch(path, userId, userSecret, { method = 'GET', body = null } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  const qs = new URLSearchParams({
    clientId: CLIENT_ID,
    timestamp: String(timestamp),
    userId,
    userSecret,
  })

  const sigObj = {
    content: body,
    path: `/api/v1${path}`,
    query: qs.toString(),
  }
  const sigMessage = sortedJSON(sigObj)
  const signature = createHmac('sha256', CONSUMER_KEY)
    .update(sigMessage)
    .digest('base64')

  const res = await fetch(`${SNAP_BASE}${path}?${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Signature': signature },
    body: body != null ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`SnapTrade ${path} → ${res.status}: ${err}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// ── D1 helpers ────────────────────────────────────────────────

// SELECT: use --command with args array (no shell escaping issues)
function d1Select(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  const raw = execFileSync(
    'npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', oneLine],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const jsonStart = raw.indexOf('[')
  const jsonEnd   = raw.lastIndexOf(']') + 1
  if (jsonStart === -1) return []
  return JSON.parse(raw.slice(jsonStart, jsonEnd))[0]?.results ?? []
}

// Write: use --file (no result rows needed, avoids shell escaping of large SQL)
function d1Write(sql) {
  const tmp = join(tmpdir(), `pwm_d1_${Date.now()}.sql`)
  try {
    writeFileSync(tmp, sql, 'utf8')
    execFileSync(
      'npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--file', tmp],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

async function d1InsertNavRows(rows) {
  const CHUNK = 50
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const values = chunk.map(r =>
      `('${r.snap_date}', 23, '${r.account_id}', ${r.value}, 'market')`
    ).join(',\n')
    d1Write(`
      INSERT INTO nav_snapshots (snap_date, snap_hour, account_id, value, source)
      VALUES ${values}
      ON CONFLICT(snap_date, snap_hour, account_id) DO UPDATE SET value = excluded.value, source = excluded.source;
    `)
    process.stdout.write('.')
  }
}

// ── Price fetchers ────────────────────────────────────────────

const nowTs  = Math.floor(Date.now() / 1000)
const fromTs = nowTs - DAYS * 86400

async function yahooCandles(sym) {
  // Yahoo Finance: handles US stocks, ETFs, and Canadian .TO symbols
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${fromTs}&period2=${nowTs}&interval=1d`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return {}
    const d = await res.json()
    const timestamps = d?.chart?.result?.[0]?.timestamp
    const closes     = d?.chart?.result?.[0]?.indicators?.quote?.[0]?.close
    if (!timestamps || !closes) return {}
    const out = {}
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue
      out[new Date(timestamps[i] * 1000).toISOString().slice(0, 10)] = closes[i]
    }
    return out
  } catch { return {} }
}

async function finnhubCandles(sym) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${fromTs}&to=${nowTs}&token=${FINNHUB_KEY}`
    const res = await fetch(url)
    if (!res.ok) return {}
    const d = await res.json()
    if (d.s !== 'ok' || !d.t || !d.c) return {}
    const out = {}
    for (let i = 0; i < d.t.length; i++) {
      out[new Date(d.t[i] * 1000).toISOString().slice(0, 10)] = d.c[i]
    }
    return out
  } catch { return {} }
}

async function coinGeckoCandles(sym) {
  const id = COINGECKO_ID[sym.toUpperCase()]
  if (!id) return {}
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${DAYS}`
    const res = await fetch(url, { headers: { 'x-cg-demo-api-key': COINGECKO_KEY } })
    if (!res.ok) return {}
    const d = await res.json()
    const byDate = {}
    for (const [tsMs, price] of d.prices) {
      byDate[new Date(tsMs).toISOString().slice(0, 10)] = price
    }
    return byDate
  } catch { return {} }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`Backfilling ${DAYS} days of NAV for SnapTrade-linked accounts...\n`)

  const accounts = d1Select('SELECT id, snaptrade_account_id FROM accounts WHERE snaptrade_account_id IS NOT NULL')
  console.log(`Found ${accounts.length} linked account(s):`, accounts.map(a => a.id))

  const [snapUser] = d1Select("SELECT snaptrade_user_id, user_secret FROM snaptrade_users WHERE id = 'singleton'")
  if (!snapUser) { console.error('No SnapTrade user'); process.exit(1) }
  const { snaptrade_user_id: userId, user_secret: userSecret } = snapUser

  for (const acc of accounts) {
    const { id: d1Id, snaptrade_account_id: snapAccId } = acc
    console.log(`\nProcessing ${d1Id} (snap: ${snapAccId})`)

    let positions, balances
    try {
      const [posRes, balRes] = await Promise.all([
        snapFetch(`/accounts/${snapAccId}/positions/all`, userId, userSecret),
        snapFetch(`/accounts/${snapAccId}/balances`, userId, userSecret),
      ])
      positions = posRes?.results ?? posRes ?? []
      balances  = balRes ?? []
    } catch (e) {
      console.error(`  Failed: ${e.message}`)
      continue
    }

    const cashTotal = balances.reduce((s, b) => s + (b.cash ?? 0), 0)
    console.log(`  ${positions.length} positions, cash $${cashTotal.toFixed(2)}`)

    const dateValue = {}

    for (const pos of positions) {
      const instrKind = (pos.instrument?.kind ?? '').toLowerCase()
      if (instrKind === 'option') continue  // no historical option prices
      const qty = Number(pos.units) || 0
      const sym = pos.instrument?.symbol
      if (!sym || !qty) continue

      console.log(`  Fetching ${sym} (qty=${qty})...`)
      let candles = isCrypto(sym) ? await coinGeckoCandles(sym) : await yahooCandles(sym)
      // Fallback to Finnhub if Yahoo returns nothing
      if (Object.keys(candles).length === 0 && !isCrypto(sym)) candles = await finnhubCandles(sym)
      const n = Object.keys(candles).length
      console.log(`    ${n} trading days`)
      for (const [date, price] of Object.entries(candles)) {
        dateValue[date] = (dateValue[date] ?? 0) + qty * price
      }
    }

    for (const date of Object.keys(dateValue)) dateValue[date] += cashTotal

    const rows = Object.entries(dateValue).map(([snap_date, value]) => ({ snap_date, account_id: d1Id, value }))
    if (rows.length === 0) { console.log('  No price data — skipping'); continue }

    console.log(`  Writing ${rows.length} rows...`)
    d1Write(`DELETE FROM nav_snapshots WHERE account_id = '${d1Id}' AND source = 'market';`)
    await d1InsertNavRows(rows)
    console.log('\n  Done.')
  }

  // Recompute aggregate from market-only per-account rows
  console.log('\nRecomputing aggregate...')
  d1Write("DELETE FROM nav_snapshots WHERE account_id = '';")
  d1Write(`
    INSERT INTO nav_snapshots (snap_date, snap_hour, account_id, value, source)
    SELECT snap_date, 23, '', SUM(value), 'market'
    FROM nav_snapshots
    WHERE account_id != '' AND source = 'market'
    GROUP BY snap_date
    ON CONFLICT(snap_date, snap_hour, account_id) DO UPDATE SET value = excluded.value, source = excluded.source;
  `)

  const summary = d1Select(
    "SELECT account_id, COUNT(*) as cnt, MIN(snap_date) as earliest, MAX(snap_date) as latest FROM nav_snapshots WHERE source = 'market' GROUP BY account_id ORDER BY account_id"
  )
  console.log('\n── Result ───────────────────────────────────')
  for (const row of summary) {
    console.log(`  ${row.account_id || '(aggregate)'}: ${row.cnt} rows  ${row.earliest} → ${row.latest}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
