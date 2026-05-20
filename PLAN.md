# Personal Wealth Management Web App — Project Plan

**Owner:** Frank
**Date:** 2026-05-11
**Status:** Draft v1 — awaiting review

---

## 1. Goals

A single-user web app that lets me:

1. **Track all financial assets I own** — stocks, ETFs, options, crypto, and cash/bank balances (with room to add bonds/real estate later).
2. **Log every financial operation** — buys, sells, deposits, withdrawals, dividends, interest, fees, transfers, option exercises/assignments, crypto staking rewards, etc.
3. **Pull the freshest free market data** to value the portfolio in near real-time.
4. **See a dashboard** with total net worth, asset-class composition (% pie), positions table, P&L (realized and unrealized), and historical net-worth chart.

Single user (just me), cloud-hosted on Cloudflare, gated by Cloudflare Access.

---

## 2. Tech Stack (confirmed)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **React + Vite + TypeScript** | Standard, fast HMR, fits Cloudflare's React template |
| UI kit | **Tailwind CSS + shadcn/ui** | Clean look without designing from scratch |
| Charts | **Recharts** | React-native, easy pie/line charts for the dashboard |
| Backend (API) | **Hono on Cloudflare Workers** | Tiny, fast, first-class Workers + D1 support, single TS codebase end-to-end |
| Database | **Cloudflare D1** (SQLite-compatible) | Free tier covers single-user usage by a wide margin |
| Auth | **Cloudflare Access** (Zero Trust Free plan, email OTP or Google SSO) | Free for ≤50 users; no auth code to write |
| Hosting | **Cloudflare Workers** with Workers Assets (combined SPA + API) | One deploy, one domain; no CORS headaches |
| Object storage | **Cloudflare R2** — *only if needed* later (e.g. attaching trade confirmations, monthly statements PDFs) | Skip in v1 |
| Validation | **Zod** | Type-safe request validation between React and Hono |
| Build/deploy | **wrangler + GitHub Actions** | One-command deploys |

D1 free tier headroom for our usage: 5M row reads/day, 100K row writes/day, 5GB storage. A power user logging 20 transactions a day uses ~600 writes/month — we're nowhere near the limits.

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Cloudflare Access                        │
│              (Email OTP or Google SSO gate)                  │
└───────────────────────────┬─────────────────────────────────┘
                            │
              ┌─────────────▼──────────────┐
              │  Cloudflare Worker (Hono)  │
              │  ┌──────────────────────┐  │
              │  │  React SPA (assets)  │  │
              │  └──────────────────────┘  │
              │  ┌──────────────────────┐  │
              │  │   /api/* routes       │  │
              │  │   (Hono + Zod)        │  │
              │  └──────────────────────┘  │
              └───┬──────────────┬─────────┘
                  │              │
        ┌─────────▼────┐  ┌──────▼───────────────┐
        │ Cloudflare D1│  │ Market Data Adapters │
        │  (SQLite)    │  │ Finnhub / CoinGecko  │
        └──────────────┘  │ / Alpha Vantage      │
                          └──────────────────────┘
                  ▲
                  │
        ┌─────────┴────────────┐
        │ Scheduled Worker     │
        │ (Cron Trigger)        │
        │ Refresh prices daily  │
        │ Snapshot net worth    │
        └──────────────────────┘
```

Key decisions:

- **Single Worker bundles SPA + API.** Simpler than splitting Pages + Workers. The Cloudflare React + Vite + Workers template (`npm create cloudflare@latest -- --framework=react`) gives us this out of the box.
- **Cron trigger Worker** runs nightly to (a) refresh closing prices for everything held and (b) write a daily net-worth snapshot row so the historical chart is cheap to render.
- **On-demand price fetch** for the dashboard, with a short in-memory + KV cache (60s) so opening the dashboard doesn't burn the API rate limit.

---

## 4. Data Model (D1 schema)

The model centers on **accounts → assets → transactions**, with prices stored separately.

```sql
-- An account holds positions. Brokerage, bank, exchange wallet, etc.
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,            -- "Schwab Brokerage", "Chase Checking"
  type          TEXT NOT NULL,            -- 'brokerage' | 'bank' | 'crypto_exchange' | 'wallet'
  currency      TEXT NOT NULL DEFAULT 'USD',
  institution   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master list of every instrument the user has touched.
CREATE TABLE assets (
  id            INTEGER PRIMARY KEY,
  symbol        TEXT NOT NULL,            -- 'AAPL', 'BTC', 'AAPL 240621C00200000' (OCC)
  name          TEXT,                     -- 'Apple Inc.'
  asset_class   TEXT NOT NULL,            -- 'stock' | 'etf' | 'option' | 'crypto' | 'cash' | 'bond'
  currency      TEXT NOT NULL DEFAULT 'USD',
  -- Option-specific (nullable for non-options)
  underlying    TEXT,                     -- 'AAPL'
  option_type   TEXT,                     -- 'call' | 'put'
  strike        REAL,
  expiry        TEXT,                     -- ISO date
  multiplier    INTEGER DEFAULT 100,
  UNIQUE(symbol, asset_class)
);

-- Every operation that changes a balance or position.
CREATE TABLE transactions (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  asset_id      INTEGER REFERENCES assets(id),    -- null for cash-only operations
  type          TEXT NOT NULL,            -- see allowed types below
  trade_date    TEXT NOT NULL,            -- ISO date
  settle_date   TEXT,
  quantity      REAL NOT NULL DEFAULT 0,  -- shares / contracts / coins
  price         REAL NOT NULL DEFAULT 0,  -- per unit
  fee           REAL NOT NULL DEFAULT 0,
  amount        REAL NOT NULL,            -- signed cash impact in account currency
  fx_rate       REAL,                     -- if currency != account currency
  notes         TEXT,
  external_ref  TEXT,                     -- broker confirmation id, tx hash, etc.
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Latest known prices (refreshed by cron and on-demand).
CREATE TABLE prices (
  asset_id      INTEGER PRIMARY KEY REFERENCES assets(id),
  price         REAL NOT NULL,
  currency      TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  source        TEXT NOT NULL
);

-- Optional historical prices for the per-asset chart and cost-basis backfill.
CREATE TABLE price_history (
  asset_id      INTEGER NOT NULL REFERENCES assets(id),
  date          TEXT NOT NULL,
  close         REAL NOT NULL,
  PRIMARY KEY (asset_id, date)
);

-- Daily net-worth snapshot for the trend chart.
CREATE TABLE nav_snapshots (
  date          TEXT PRIMARY KEY,         -- one row per day
  total_value   REAL NOT NULL,
  breakdown_json TEXT NOT NULL            -- {"stock": 12345, "crypto": 678, "cash": 9000, ...}
);

CREATE INDEX idx_tx_account_date ON transactions(account_id, trade_date);
CREATE INDEX idx_tx_asset       ON transactions(asset_id);
```

### Supported transaction types (the `type` column)

This is the "all types of transactions" enumeration. Each type has a defined effect on quantity and cash:

| Type | Asset | Qty Δ | Cash Δ | Notes |
|---|---|---|---|---|
| `buy` | stock/etf/option/crypto | +qty | −(qty·price + fee) | |
| `sell` | stock/etf/option/crypto | −qty | +(qty·price − fee) | Realized P&L computed against avg cost |
| `deposit` | cash | — | +amount | External money in |
| `withdrawal` | cash | — | −amount | External money out |
| `transfer_in` / `transfer_out` | any | ±qty | ±amount | Move between accounts (paired) |
| `dividend` | stock/etf | — | +amount | |
| `interest` | cash/bond | — | +amount | |
| `fee` | any | — | −amount | Account fees, wire fees |
| `tax` | any | — | −amount | Withholding |
| `split` | stock | ratio | 0 | Adjust quantity, no cash effect |
| `option_exercise` | option | −contracts | varies | Generates underlying buy/sell |
| `option_assignment` | option | −contracts | varies | Same |
| `option_expiry` | option | −contracts | 0 | Worthless expiry |
| `staking_reward` | crypto | +qty | 0 | |
| `airdrop` | crypto | +qty | 0 | |
| `gift_in` / `gift_out` | any | ±qty | 0 | |
| `adjustment` | any | ±qty/±amount | varies | Manual correction |

---

## 5. Market Data Strategy

The user request was "most fresh data you can get for free." There is no single free source that covers stocks + options + crypto with real-time data, so we use a router pattern with one provider per asset class. **All providers researched May 2026.**

| Asset class | Provider | Free tier | Freshness | Notes |
|---|---|---|---|---|
| US stocks / ETFs | **Finnhub** | 60 calls/min | Real-time US (free tier includes real-time quotes) | Best free real-time stock option |
| Stocks fallback | **Alpha Vantage** | 5 calls/min, 25/day | 15-min delayed | Backup + historical EOD |
| Stocks fallback 2 | **Yahoo Finance** (unofficial via `yfinance`-style endpoints) | unmetered but ToS gray-area | Real-time | Use only as last-resort fallback |
| Crypto | **CoinGecko Demo API** | 30 calls/min, 10K/month | Real-time aggregated | Free key, broad coverage |
| Options | **Finnhub options endpoint** (limited on free) + **MarketData.app** trial + manual entry | Limited | Real-time when available, manual otherwise | Free options data is the weakest area; user enters strike/expiry/premium at trade time, mark-to-market is best-effort |
| FX rates | **exchangerate.host** or Frankfurter | Free, unlimited | Daily | For non-USD positions |

### Implementation pattern

A `MarketDataAdapter` interface in the Worker:

```ts
interface MarketDataAdapter {
  getQuote(symbol: string): Promise<{ price: number; asOf: string }>;
  getHistorical(symbol: string, range: '1M'|'3M'|'1Y'|'5Y'): Promise<Candle[]>;
}
```

Routing: `stock|etf → FinnhubAdapter`, `crypto → CoinGeckoAdapter`, `option → OptionsAdapter (best effort)`. Adapters cache responses in Workers KV for 60 seconds.

### Why not WebSockets for live tick data

Possible via Durable Objects but adds significant complexity for marginal value in a personal tracker. End-of-day + on-demand quote refresh on dashboard load is sufficient for a portfolio app. Can add later.

---

## 6. Core Features (v1 scope)

### Pages

1. **Dashboard** — landing page
   - Top: total net worth (USD), 1D / 1W / 1M / YTD change
   - Pie chart: composition by asset class (% of total)
   - Pie chart: composition by individual position
   - Line chart: net-worth history (from `nav_snapshots`)
   - Top movers (biggest gainers / losers today)

2. **Positions** — table view
   - All open positions grouped by account
   - Columns: symbol, qty, avg cost, current price, market value, unrealized P&L, P&L %, asset class
   - Filter by account / asset class
   - Click a row → asset detail

3. **Transactions** — ledger view
   - Searchable, filterable table of every transaction
   - "Add transaction" button → form with type-aware fields
   - Edit / delete with confirmation
   - Bulk CSV import (Phase 2)

4. **Accounts** — CRUD for accounts (brokerage, bank, wallet)

5. **Asset detail** — clicked from positions or transactions
   - Price chart (historical)
   - Position history (all transactions in this asset)
   - Cost basis breakdown (avg / FIFO)

6. **Settings**
   - Default currency
   - API key management (user provides their own Finnhub / Alpha Vantage keys, stored in Worker Secrets)
   - Manual price-refresh button

### Cross-cutting

- **Add Transaction modal** with smart asset autocomplete (search Finnhub symbol lookup as you type)
- **Mobile-responsive** — dashboard needs to be usable on phone
- **CSV export** of transactions for tax season

---

## 7. Phased Delivery Plan

Each phase is a shippable increment. Estimates assume a few focused evenings per phase.

### Phase 0 — Scaffolding (½ day)
- Create CF Workers + React + Vite + Hono project from template
- Configure wrangler.toml for D1 binding
- Set up GitHub repo + Cloudflare Access on the workers.dev domain
- Tailwind + shadcn/ui installed
- "Hello world" SPA + `/api/health` route deployed and gated

### Phase 1 — Data layer (1 day)
- D1 schema (migrations via `wrangler d1 migrations`)
- Hono routes: CRUD for `accounts`, `assets`, `transactions`
- Zod schemas shared between client and server
- Seed script with a few accounts + sample transactions

### Phase 2 — Transactions UI (1–2 days)
- Accounts page (list, create, edit)
- Transactions list page with filtering
- Add Transaction modal with type-aware form
  - Buy/sell branch: symbol search, qty, price, fee
  - Cash branch: amount only
  - Option branch: underlying + strike + expiry + premium
- Edit / delete

### Phase 3 — Market data + positions (1–2 days)
- Implement `FinnhubAdapter`, `CoinGeckoAdapter`
- `/api/quote/:symbol` endpoint with KV cache
- Positions page: compute holdings from transactions, value with current prices
- Symbol autocomplete in Add Transaction modal

### Phase 4 — Dashboard (1 day)
- Net-worth tile + composition pie charts (Recharts)
- Cron trigger Worker writes nightly `nav_snapshots`
- Net-worth history line chart from snapshots
- Top movers panel

### Phase 5 — Polish & nice-to-haves (open-ended)
- CSV export
- CSV import for transactions
- Asset detail page with price history
- Realized vs unrealized P&L breakdown
- Tax-lot accounting (FIFO/specific identification)
- Mobile pass
- Tests (Vitest for adapters; Playwright smoke test)

---

## 8. Risks & Open Questions

1. **Options market data is the weakest free coverage.** Plan: let user enter the option contract details and current mark manually if no quote is available, and treat live option pricing as best-effort. Acceptable for v1?
2. **Cost-basis method.** Phase 1 will use weighted-average cost. FIFO / specific-lot tracking is more work — defer to Phase 5 unless you want it sooner.
3. **Currency handling.** Default assumption: everything reported in USD, non-USD positions converted at latest FX. Confirm?
4. **Backfill of historical data.** Pulling 5 years of EOD prices for every asset on first add will burn API calls — do it lazily (only when asset detail page is opened) or batch-overnight via cron.
5. **Secrets storage.** API keys go in `wrangler secret put` (encrypted Worker Secrets), not D1. ✅
6. **Backup.** D1 has automatic point-in-time recovery on paid plans only. On free tier, schedule a weekly export via cron (`wrangler d1 export`) into R2 — small to add later.
7. **Source-of-truth conflicts.** If a broker corrects a trade, we need an edit-history audit trail. Phase 5 nice-to-have: append-only audit log table.

---

## 9. Cost Estimate

Assuming personal-use traffic (you logging in a few times a day, cron once nightly):

| Service | Free tier | Expected usage | Cost |
|---|---|---|---|
| Cloudflare Workers | 100K req/day | ~1K/day | $0 |
| Cloudflare D1 | 5M reads, 100K writes/day, 5GB | <0.1% | $0 |
| Cloudflare KV (caching) | 100K reads/day, 1K writes/day | ~500/day | $0 |
| Cloudflare Access (Zero Trust) | 50 users | 1 user | $0 |
| Cloudflare R2 (optional, Phase 5+) | 10GB free | ~0 | $0 |
| Finnhub | 60 calls/min | well under | $0 |
| CoinGecko Demo | 30 calls/min, 10K/month | well under | $0 |
| Alpha Vantage (fallback) | 25 calls/day | rarely | $0 |
| **Total monthly** | | | **$0** |

Domain (optional, if you want a custom domain instead of workers.dev): ~$10/year via Cloudflare Registrar.

---

## 10. What I need from you to proceed

Before I start coding, please confirm:

1. **Approve the v1 scope** (Phases 0–4) or tell me what to cut/add.
2. **Cost-basis method for v1:** weighted-average (simpler) or FIFO (more accurate for taxes)?
3. **API keys:** are you OK signing up for free Finnhub + CoinGecko Demo + Alpha Vantage keys? I'll give you the URLs.
4. **Domain:** workers.dev subdomain (free) or your own domain?
5. **Repo:** create a new public/private GitHub repo, or work locally only for now?

Once confirmed I'll start with Phase 0 scaffolding.

---

## Sources

- [Cloudflare D1 limits — official docs](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 pricing — official docs](https://developers.cloudflare.com/d1/platform/pricing/)
- [Hono on Cloudflare Workers — official docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
- [React + Vite on Cloudflare Workers — official docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Cloudflare Zero Trust pricing (free tier, 50 users)](https://costbench.com/software/business-vpn/cloudflare-zero-trust/)
- [Best Free Stock Market APIs 2026 — comparison](https://dev.to/nexgendata/best-free-stock-market-apis-and-data-tools-in-2026-a-developers-honest-comparison-1926)
- [CoinGecko API pricing & free Demo tier](https://www.coingecko.com/en/api/pricing)
- [Free options chain API comparison 2026](https://datarade.ai/top-lists/best-option-chain-apis)
