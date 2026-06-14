# Meridian

Single-user personal wealth dashboard. Runs entirely on Cloudflare Workers + D1 with React on the client.

Tracks holdings across multiple brokers (Interactive Brokers, Robinhood, Fidelity, manual accounts), computes realized P&L / allocation / drift / dividend / option premium analytics, and renders a NAV history chart with intraday refresh during market hours.

---

## Stack

| Layer | Tech |
|---|---|
| Edge runtime | Cloudflare Workers (Hono v4 router) |
| Database | Cloudflare D1 (SQLite) |
| Cache | Cloudflare KV (`PRICE_CACHE` binding) |
| Frontend | React 18 + Vite, Tailwind, TanStack Query, Recharts, Radix UI primitives |
| Auth | Cloudflare Access at the perimeter + a SHA-256 access-key (`APP_SECRET`) in the worker |
| Schedulers | Cloudflare cron triggers (`wrangler.toml` `[triggers]`) |
| Charts | Recharts AreaChart + PieChart |
| State | Zustand with localStorage persistence (display currency, dark mode, privacy toggle) |
| Quotes | Finnhub (stocks), CoinGecko (crypto), Yahoo Finance (VIX), Frankfurter (FX) |

---

## High-level architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser (React SPA)                                                 │
│   pages → fetch('/api/…') with Bearer <APP_SECRET hash>             │
└─────────────────────────────────────────────────────────────────────┘
                          │ HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (src/worker)                                      │
│   /api/* → Hono router                                              │
│   Static assets → /dist served by Cloudflare's edge CDN             │
│                                                                     │
│   Hot paths read from D1 + KV directly.                             │
│   Sync paths talk to broker APIs and write back to D1.              │
└─────────────────────────────────────────────────────────────────────┘
        │                          │                          │
        ▼                          ▼                          ▼
┌────────────────┐         ┌────────────────┐         ┌────────────────┐
│ D1 (SQLite)    │         │ KV PRICE_CACHE │         │ External APIs  │
│  accounts      │         │  quotes:all    │         │  SnapTrade     │
│  transactions  │         │  fx:USD        │         │  IBKR Flex     │
│  broker_*      │         │  sentiment     │         │  Finnhub       │
│  nav_snapshots │         │                │         │  CoinGecko     │
│  …             │         │                │         │  CNN F&G       │
└────────────────┘         └────────────────┘         └────────────────┘
                                                              ▲
                                                              │
                                                     ┌────────┴────────┐
                                                     │ Cron triggers   │
                                                     │  22:00 UTC daily│
                                                     │  hourly 14-20   │
                                                     │  Mon-Fri intra  │
                                                     └─────────────────┘
```

Single source of truth is **D1**. Hot read paths (Dashboard, Holdings, Insights, Allocation) read from D1 + KV only. Broker APIs are only touched by the sync layer (cron and the manual refresh button).

---

## Database schema

| Table | Purpose |
|---|---|
| `accounts` | One row per account (manual or broker-linked). `snaptrade_account_id` links to SnapTrade; `institution = 'Interactive Brokers'` + `number = U…` links to IBKR Flex |
| `transactions` | Every trade, deposit, dividend, fee, etc. Source attribution via `source` (`'manual' \| 'snaptrade' \| 'ibkr_flex' \| 'recurring'`) and `external_id` (broker's tx ID, used for dedup) |
| `broker_positions` | Position snapshot from any broker (SnapTrade or IBKR Flex). Upserted on each sync; rows with stale `synced_at` are culled |
| `broker_balances` | Cash balance per account per currency, from any broker. Same upsert/cull pattern |
| `nav_snapshots` | Daily + intraday total portfolio value. PK `(snap_date, account_id)` with empty `account_id` for the aggregate |
| `holding_marks` | Manual price overrides for positions without a live quote (e.g. private investments) |
| `watchlist` | Tickers the user wants to track without owning |
| `goals` | Savings goals with optional account linkage for auto-progress |
| `allocation_plans` | Target asset allocation percentages + drift threshold, optional scope to specific accounts |
| `recurring_rules` | Bi-weekly/monthly/quarterly auto-deposit rules; the daily cron fires them |
| `credit_cards` | Credit card SUB/min-spend tracker (separate from investment accounts) |
| `events` | Generic future events feed (earnings, expirations) |
| `snaptrade_users` | Singleton row storing the SnapTrade user secret |

### Migration trail

| File | Change |
|---|---|
| `0001_schema.sql` | Initial schema |
| `0002_option_cash.sql` | Companion cash transactions for option premium tracking |
| `0002_snaptrade.sql` | SnapTrade user + account linkage |
| `0003_intraday_nav.sql` | Added `snap_hour` column for intraday snapshots |
| `0004_unified_sync.sql` | Added `source`/`external_id`/`synced_at`/`locked` columns + the two snapshot tables |
| `0005_rename_broker_tables.sql` | Renamed `snaptrade_*` tables to `broker_*` (both SnapTrade and IBKR Flex write to them) |

Apply remote: `npm run migrate:prod` (and the per-migration scripts in `package.json`).

---

## Connecting real broker accounts

There are three account modes, each with a different ingestion path:

### 1. Manual (no broker)
Pick "Add Account → Manual" in the UI. Transactions are entered through the **Add Transaction** modal. The `accounts` row has no `snaptrade_account_id` and not the IBKR institution flag.

### 2. SnapTrade-connected (Robinhood, Fidelity, Wealthsimple, etc.)

```
User clicks "Add Account → Connect broker"
   └─→ POST /api/snaptrade/register  (creates SnapTrade user, singleton)
   └─→ POST /api/snaptrade/connect   (gets OAuth URL)
   └─→ user authorizes in popup → SnapTrade callback posts back
   └─→ GET  /api/snaptrade/broker-accounts  (lists newly authorized accounts)
   └─→ POST /api/snaptrade/import-accounts  (creates D1 accounts.snaptrade_account_id)
```

Cron + manual refresh then sync via `lib/sync.ts`:
- `syncActivities()` → INSERT OR IGNORE into `transactions` with `source='snaptrade'` and `external_id` = SnapTrade activity ID
- `syncPositions()` → upsert `broker_positions`, cull rows with stale `synced_at`
- `syncBalances()` → upsert `broker_balances`, cull rows with stale `synced_at`

### 3. IBKR Flex Web Service (Interactive Brokers only)

IBKR's SnapTrade integration returns positions but **0 activity history** (a documented IBKR/SnapTrade limitation). We bypass it with IBKR's native Flex Web Service:

```
User creates an Activity Flex Query in IBKR Client Portal with sections:
   Trades, Cash Transactions, Open Positions, Option EAE, Cash Report
   → IBKR generates a Query ID (e.g. 1541531)
   → Same dashboard exposes a Flex Web Service Token

Operator stores both as wrangler secrets:
   wrangler secret put IBKR_FLEX_TOKEN
   wrangler secret put IBKR_FLEX_QUERY_ID

Sync flow (cron + manual refresh):
   POST /api/ibkr-flex/sync
     1. POST SendRequest?t=TOKEN&q=QUERYID&v=3       → ReferenceCode
     2. Poll GetStatement?t=TOKEN&q=REFCODE&v=3      (retries on 1019)
     3. Parse XML (fast-xml-parser)
     4. Match Flex's accountId="U..." to accounts.number
     5. Upsert positions, balances, INSERT OR IGNORE trades + cash txns
```

IBKR-side considerations:
- Activity Flex Queries refresh **once daily** at IBKR's end-of-business (~02:00 ET). Polling more often is wasted.
- IBKR's `assetCategory = STK` covers both stocks and ETFs. The parser consults `shared/etf-list.ts` to distinguish them. Same module has `MUTUAL_FUND_SYMBOLS` for 401k aliases (`O24K`, `BLKLP2060`).
- IBKR's `CASH` asset category means **forex** (e.g. `USD.CAD`), not crypto. The parser tags these `kind='cash'` and Insights' Trading Activity excludes them.
- IBKR Flex also reports per-currency cash balances in the Cash Report section → `broker_balances`.

---

## Sync scheduling and cadence

Defined in `wrangler.toml`:

```toml
[triggers]
crons = ["0 22 * * *", "0 14,15,16,17,18,19,20 * * 1-5"]
```

| Cron | When | What it runs (`src/worker/index.ts:scheduled`) |
|---|---|---|
| `0 22 * * *` | 22:00 UTC daily | `fireAllRules` (recurring transactions) → `syncAllLinkedAccounts('activities')` (7-day overlap window) → `syncIbkrFlex` → end-of-day NAV snapshot |
| `0 14,15,16,17,18,19,20 * * 1-5` | Hourly 14-20 UTC Mon-Fri | `syncAllLinkedAccounts('positions-balances')` → intraday NAV snapshot |

Cost characteristics (4 live broker accounts):

| Endpoint | Per market day |
|---|---|
| SnapTrade `/positions/all` | 3 accts × 7 ticks = 21 |
| SnapTrade `/balances` | 3 accts × 7 ticks = 21 |
| SnapTrade `/activities` | 3 accts × 1 = 3 |
| IBKR Flex submit/get | 1 cycle (covers both IBKR accounts) |
| **Total broker API calls** | **~50/day** |
| D1 writes | ~800/day (upserts only touch changed rows) |
| Cloudflare worker invocations | 8/day (cron) + page loads |

SnapTrade's free-plan ceiling is 10 req/min per account on the activity/position endpoints — we're orders of magnitude under it.

---

## Backfill (one-time initial population)

First-time setup runs the same sync paths with `?full=1` flag to lift the date floor:

```javascript
// Browser console, after connecting brokers
const auth = `Bearer ${JSON.parse(localStorage.getItem('meridian-ui')).state.apiSecret}`

// 1. Per-account SnapTrade backfill (full history available from broker)
for (const id of ['acc_xxx', 'acc_yyy']) {
  await fetch(`/api/snaptrade/sync/${id}?full=1`, { method: 'POST', headers: { Authorization: auth } })
  await new Promise(r => setTimeout(r, 65_000))  // respect 60s debounce
}

// 2. IBKR Flex one-shot (covers all linked IBKR accounts)
await fetch('/api/ibkr-flex/sync', { method: 'POST', headers: { Authorization: auth } })

// 3. NAV history (rebuilds from transactions + position snapshots)
await fetch('/api/admin/run-snapshot', { method: 'POST', headers: { Authorization: auth } })
```

There's also `scripts/backfill-nav.mjs` that walks 5 years of daily Yahoo Finance closes and reconstructs historical NAV snapshots — used once to bootstrap the NAV chart.

Dedup is automatic on re-runs: each row inserted via sync carries `external_id`, and the `(source, external_id)` unique index ensures `INSERT OR IGNORE` skips duplicates.

---

## Data classification (`kind` detection)

The `kind` field on transactions and positions controls quote lookup, Insights bucketing, and display badges. Detection priority:

1. **Hardcoded symbol whitelist** (`shared/etf-list.ts`):
   - `MUTUAL_FUND_SYMBOLS` → `kind = 'mutual_fund'` (target-date funds, 401k aliases like `O24K`, `BLKLP2060`)
   - `ETF_SYMBOLS` → `kind = 'etf'` (TSX + NYSE ETFs)
2. **Broker-reported asset category** (SnapTrade `instrument.kind`, IBKR `assetCategory`)
3. **Default** → `'stock'`

`kind` has downstream effects:
- `kind = 'option'` → 100× multiplier on totals; bucketed separately in Insights
- `kind = 'mutual_fund'` → skips Finnhub live-quote lookup (NAV is broker-reported only)
- `kind = 'cash'` → excluded from Trading Activity in Insights (forex isn't an "investment trade")
- `kind = 'crypto'` → CoinGecko quote source instead of Finnhub

---

## Currency conversion

Storage is **always USD**. Display can be toggled to CAD via the header pill.

### Live FX rate

`getUsdCadRate` (in `worker/routes/holdings.ts`) caches the rate in KV under `fx:USD`:

```
1. Check KV cache (set by /api/fx route on every fetch, TTL ~1 hour)
2. Fallback: fetch from Frankfurter (https://api.frankfurter.app)
3. Last-resort fallback: 1.37 (hardcoded)
```

The same `fx:USD` blob is what powers the client's `useMoney()` hook, so the rate is consistent between display and computation.

### Where conversion happens

| Layer | Conversion rule |
|---|---|
| **D1 storage** | All `total`, `price`, `cost` fields stored in **USD**. CAD positions converted at sync time. |
| **`broker_balances.cash`** | Stored in **native currency** (so a CAD balance row stores 100 CAD, not 73 USD). The holdings endpoint converts to USD when building the response. |
| **Holdings endpoint** | Reads `broker_positions.currency`. If `'CAD'`, divides `cash` and `cost` by `usdCadRate` to produce USD. Output `Holding.qty` and `Holding.cost` are always USD-equivalent. |
| **Client `useMoney()`** | Multiplies the USD-equivalent value by the user's selected display currency rate. `fmt(value)` returns the formatted string in the chosen currency. |

### Add Transaction modal

When entering a manual CAD transaction:
- User selects "CAD" in the currency dropdown
- Form values are converted to USD on submit using the live rate from `fxApi.rates`
- A note like `[CAD 500 @ rate 0.7263]` is appended for audit

### Forex trades (IBKR USD.CAD)

The IBKR Flex parser tags `assetCategory = CASH` trades as `kind = 'cash'` (not `crypto`). They appear in the Transactions list but are filtered out of:
- Insights Trading Activity counters
- Realized P&L FIFO matching (cash conversions aren't investment trades)

---

## Project structure

```
src/
├── client/              React SPA (built by Vite → dist/)
│   ├── App.tsx          Router + global providers
│   ├── components/      Reusable UI (Layout, AddTxModal, ChangePill, …)
│   ├── lib/             api.ts (Hono client), money.ts (currency hook),
│   │                    store.ts (Zustand), utils.ts
│   └── pages/           One file per route — Dashboard, Holdings,
│                        Transactions, Insights, Allocation, Accounts,
│                        Goals, Watchlist, CreditCards, Recurring,
│                        Import, HoldingDetail
│
├── shared/              Imported by both client and worker
│   ├── types.ts         Shared interface contracts (Account, Transaction, …)
│   ├── insights.ts      Pure FIFO/realized/dividend/contribution math
│   ├── insights.test.ts Vitest suite (22 tests covering the math)
│   └── etf-list.ts      ETF + mutual fund symbol whitelists
│
└── worker/              Cloudflare Worker
    ├── index.ts         Hono mount + cron dispatcher + NAV calculator
    ├── types.ts         Env binding interface
    ├── db/queries.ts    D1 query layer (parameterized, with cascade-delete)
    ├── lib/
    │   ├── market.ts    Finnhub + CoinGecko clients, static ticker list
    │   ├── snaptrade.ts SnapTrade SDK (HMAC signing, all endpoint wrappers)
    │   ├── sync.ts      Unified SnapTrade sync (activities / positions / balances)
    │   ├── ibkr-flex.ts IBKR Flex submit/fetch/parse/persist
    │   ├── positions.ts FIFO position computation from transactions
    │   └── recurring.ts Recurring rule firing + nextFireDate()
    └── routes/          One file per /api/* mount: accounts, transactions,
                         holdings, watchlist, goals, market, nav, fx,
                         recurring, allocation, creditcards, snaptrade,
                         ibkrflex, sentiment
```

---

## Local development

```bash
# Install
npm install

# One-time D1 setup
npm run migrate:local           # local D1 schema
npm run migrate:prod            # remote D1 schema (after wrangler login)

# Dev server (vite + wrangler in parallel)
npm run dev

# Build + deploy
npm run deploy                  # npm run build && wrangler deploy

# Unit tests (the math in shared/insights.ts)
npm test
```

Secrets required (set with `wrangler secret put NAME`):
- `APP_SECRET` — the access key the LoginGate hashes against
- `FINNHUB_KEY` — free tier from finnhub.io
- `COINGECKO_KEY` — Demo plan from coingecko.com
- `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` — from dashboard.snaptrade.com
- `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID` — from IBKR Client Portal

---

## Auth model

Two-layer:
1. **Cloudflare Access** at the perimeter — anyone hitting `meridian.zhousir.workers.dev` is bounced through Cloudflare's IdP first
2. **`APP_SECRET` access key** at the worker — every `/api/*` request must carry `Authorization: Bearer <sha256(APP_SECRET)>`. The client sends `sha256(password)` so the plaintext never traverses the wire; the worker re-derives the same hash from `APP_SECRET` and constant-time compares.

The LoginGate persists the hash to `localStorage` under `meridian-ui.state.apiSecret`.
