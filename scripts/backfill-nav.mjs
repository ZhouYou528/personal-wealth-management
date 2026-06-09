import { createHmac } from 'crypto'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'

const CLIENT_ID     = 'PERS-X6S5QBU4D2D93R977042'
const CONSUMER_KEY  = 'Wh4BkUAgTxUylFZMVg98o1Y6HgcQwnbhAoE7VWTied0b3NGjNP'
const USER_ID       = 'pwm536df1e7fdeb42d88e3a'
const USER_SECRET   = 'bf75d08a-8550-4b25-bee5-e58419d531b9'
const PWD           = '/Users/yzhou/personal-wealth-management'

// SnapTrade-linked accounts
const ACCOUNTS = [
  { d1Id: 'acc_74cfe730', snapId: 'a144a70d-ded7-4564-b342-d8a35c3233bc', name: 'Fidelity 401k' },
  { d1Id: 'acc_2f5c5857', snapId: 'aefa624b-d6c0-46f1-968d-349cb27c1cfb', name: 'IBKR TFSA' },
  { d1Id: 'acc_25e3c6bb', snapId: 'e390f227-6a43-4ba2-87f2-8b3e720e6535', name: 'Robinhood Crypto' },
  { d1Id: 'acc_5b5652ba', snapId: '30280a68-5256-4665-82f2-46c55ad078fe', name: 'Robinhood Individual' },
]

// Non-SnapTrade accounts that use a performance-proxy from Yahoo Finance.
// currentValue: total cash invested / cost basis (our best known value).
// proxyTicker: Yahoo Finance ticker whose daily returns are used to estimate history.
const PROXY_ACCOUNTS = [
  {
    d1Id: 'acc_b9c8f7d0',
    name: 'Canada Life',
    currentValue: 66547.49,        // $65,791.61 transfer-in + $755.88 contribution
    proxyTicker: 'LIZKX',          // BlackRock LifePath Index 2060 Fund Class K — direct match for Canada Life's BLKLP2060
  },
]

// Mutual/segregated funds with a known Yahoo Finance proxy ticker
// Key: uppercase description from SnapTrade; value: Yahoo Finance symbol
const FUND_OVERRIDES = {
  'VANGUARD TARGET 2060': 'VTIVX',
}

const DAYS   = 1825  // 5 years
const nowTs  = Math.floor(Date.now() / 1000)
const fromTs = nowTs - DAYS * 86400

// ── SnapTrade signed fetch ────────────────────────────────────
async function snapFetch(path) {
  const ts  = Math.floor(Date.now() / 1000)
  const qs  = `clientId=${CLIENT_ID}&timestamp=${ts}&userId=${USER_ID}&userSecret=${USER_SECRET}`
  const msg = JSON.stringify({ content: null, path: `/api/v1${path}`, query: qs })
  const sig = createHmac('sha256', CONSUMER_KEY).update(msg).digest('base64')
  const res = await fetch(`https://api.snaptrade.com/api/v1${path}?${qs}`, { headers: { Signature: sig } })
  if (!res.ok) throw new Error(`SnapTrade ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── Yahoo Finance daily adjusted closes → { "YYYY-MM-DD": price } ───
const YH_HEADERS = { 'User-Agent': 'Mozilla/5.0' }
async function yahooCandles(sym, kind) {
  const ySym = kind === 'crypto' ? sym.toUpperCase() + '-USD'
             : sym.endsWith('.TO') ? sym
             : sym.replace(/\./g, '-')
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&period1=${fromTs}&period2=${nowTs}`
    const res = await fetch(url, { headers: YH_HEADERS })
    if (!res.ok) return {}
    const d = await res.json()
    const result = d.chart?.result?.[0]
    if (!result) return {}
    const ts     = result.timestamp ?? []
    const closes = result.indicators?.adjclose?.[0]?.adjclose
                ?? result.indicators?.quote?.[0]?.close ?? []
    const out = {}
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue
      out[new Date(ts[i] * 1000).toISOString().slice(0, 10)] = closes[i]
    }
    return out
  } catch { return {} }
}

// ── USD/CAD rate ──────────────────────────────────────────────
const fxData     = await (await fetch('https://api.frankfurter.app/latest?base=USD&symbols=CAD')).json()
const usdCadRate = fxData.rates?.CAD ?? 1.37
console.log(`FX: 1 USD = ${usdCadRate} CAD\n`)

const sqlLines = []

// ── SnapTrade accounts ────────────────────────────────────────
for (const acct of ACCOUNTS) {
  console.log(`── ${acct.name} ──`)

  const [posData, balData] = await Promise.all([
    snapFetch(`/accounts/${acct.snapId}/positions/all`),
    snapFetch(`/accounts/${acct.snapId}/balances`),
  ])

  const positions = posData?.results ?? []
  const balances  = Array.isArray(balData) ? balData : []

  const cashUsd = balances.reduce((s, b) => {
    const amt = b.cash ?? 0
    return s + (b.currency?.code === 'CAD' ? amt / usdCadRate : amt)
  }, 0)
  console.log(`  cash $${cashUsd.toFixed(2)} USD`)

  const dateValue = {}

  for (const pos of positions) {
    const kind = (pos.instrument?.kind ?? '').toLowerCase()
    const desc = (pos.instrument?.description ?? '').toUpperCase().trim()
    const override = FUND_OVERRIDES[desc]

    if (kind === 'option') {
      console.log(`  skip ${pos.instrument?.symbol} (option)`)
      continue
    }
    if ((kind === 'other' || kind === 'mutualfund') && !override) {
      console.log(`  skip ${pos.instrument?.symbol} (${kind}) — no Yahoo Finance mapping`)
      continue
    }

    const qty = Number(pos.units) || 0
    const sym = override ?? pos.instrument?.symbol
    if (!sym || !qty) continue

    const isCAD = !override && (pos.currency ?? '').toUpperCase() === 'CAD'
    const dispSym = override ? `${pos.instrument?.symbol} → ${sym}` : sym
    process.stdout.write(`  ${dispSym} qty=${qty} ${isCAD ? 'CAD' : 'USD'} ... `)

    const candles = await yahooCandles(sym, override ? 'stock' : kind)
    const candleDates = Object.keys(candles).sort()
    console.log(`${candleDates.length} days`)

    if (override && candleDates.length > 0) {
      // Fund override: the proxy ticker has a different share-class NAV than the actual fund.
      // Use the proxy's *performance* (% change) scaled to the actual live value from SnapTrade,
      // so the chart anchors to the real current value rather than raw-price × qty.
      const liveValue = qty * (Number(pos.price) || Number(pos.cost_basis) || 0)
      const refPrice  = candles[candleDates.at(-1)]
      process.stdout.write(`  (live $${liveValue.toFixed(2)}, proxy ref $${refPrice.toFixed(2)}) `)
      for (const [date, price] of Object.entries(candles)) {
        dateValue[date] = (dateValue[date] ?? 0) + liveValue * (price / refPrice)
      }
    } else {
      for (const [date, price] of Object.entries(candles)) {
        const priceUsd = isCAD ? price / usdCadRate : price
        dateValue[date] = (dateValue[date] ?? 0) + qty * priceUsd
      }
    }
  }

  for (const date of Object.keys(dateValue)) dateValue[date] += cashUsd

  const ndates = Object.keys(dateValue).length
  console.log(`  → ${ndates} snapshots\n`)

  for (const [date, value] of Object.entries(dateValue)) {
    sqlLines.push(
      `INSERT OR REPLACE INTO nav_snapshots (snap_date,snap_hour,account_id,value,source) ` +
      `VALUES ('${date}',23,'${acct.d1Id}',${value.toFixed(4)},'market');`
    )
  }
}

// ── Non-SnapTrade proxy accounts ─────────────────────────────
// For funds with no live price feed, we use a proxy ETF/fund's historical
// *performance* (not its absolute price) to estimate historical account values.
// Formula: value[date] = currentValue × (proxy[date] / proxy[latestDate])
for (const acct of PROXY_ACCOUNTS) {
  console.log(`── ${acct.name} (proxy: ${acct.proxyTicker}) ──`)

  const candles = await yahooCandles(acct.proxyTicker, 'stock')
  const dates   = Object.keys(candles).sort()
  if (dates.length === 0) {
    console.log(`  WARNING: no Yahoo Finance data for ${acct.proxyTicker}, skipping\n`)
    continue
  }

  const refDate  = dates.at(-1)
  const refPrice = candles[refDate]
  console.log(`  reference ${refDate}: $${refPrice.toFixed(2)}, known value: $${acct.currentValue.toFixed(2)}`)

  let count = 0
  for (const [date, price] of Object.entries(candles)) {
    const value = acct.currentValue * (price / refPrice)
    sqlLines.push(
      `INSERT OR REPLACE INTO nav_snapshots (snap_date,snap_hour,account_id,value,source) ` +
      `VALUES ('${date}',23,'${acct.d1Id}',${value.toFixed(4)},'market');`
    )
    count++
  }
  console.log(`  → ${count} snapshots\n`)
}

// ── Recompute portfolio aggregate ─────────────────────────────
// Scope to the 5 known accounts (4 SnapTrade + Canada Life proxy).
// Pick latest snap_hour per account per date to avoid cron double-counting.
// Require ≥4 distinct accounts: excludes weekends (BTC only) and most holidays.
const allIds = [...ACCOUNTS.map(a => a.d1Id), ...PROXY_ACCOUNTS.map(a => a.d1Id)]
const idList = allIds.map(id => `'${id}'`).join(',')
sqlLines.push(
  `DELETE FROM nav_snapshots WHERE account_id='' AND source='market';`,
  `INSERT INTO nav_snapshots (snap_date,snap_hour,account_id,value,source) ` +
  `SELECT snap_date,23,'',SUM(value),'market' FROM (` +
  `SELECT account_id,snap_date,value FROM nav_snapshots n ` +
  `WHERE account_id IN (${idList}) AND source='market' ` +
  `AND snap_hour=(SELECT MAX(snap_hour) FROM nav_snapshots ` +
  `WHERE snap_date=n.snap_date AND account_id=n.account_id AND source='market')` +
  `) GROUP BY snap_date HAVING COUNT(DISTINCT account_id)>=4 ` +
  `ON CONFLICT(snap_date,snap_hour,account_id) DO UPDATE SET value=excluded.value,source=excluded.source;`
)

console.log(`Total SQL statements: ${sqlLines.length}`)
const sqlPath = '/tmp/nav_backfill.sql'
writeFileSync(sqlPath, sqlLines.join('\n'))

console.log('Writing to D1 (remote)…')
execSync(`cd ${PWD} && npx wrangler d1 execute pwm_db --remote --file ${sqlPath}`, { stdio: 'inherit' })
console.log('\nDone ✓')
