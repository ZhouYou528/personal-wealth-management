# Personal Wealth Management (PWM)

A single-user web app to track every financial asset and operation you do, query market prices for free, and see your net worth + composition on a dashboard.

Stack: **React + Vite + TypeScript** (SPA) and **Hono on Cloudflare Workers** (API) running as one Worker, with **D1** for storage, **KV** for the price cache, and **Cloudflare Access** for auth.

See [`PLAN.md`](./PLAN.md) for the design rationale.

---

## Quick start

### 1. Prerequisites

- Node.js 20+ and npm
- A Cloudflare account (free)
- `wrangler` will be installed via npm

### 2. Install

```bash
npm install
```

### 3. Create D1 database and KV namespace

```bash
# Create the D1 database — paste the returned database_id into wrangler.jsonc.
wrangler d1 create pwm_db

# Create the price cache KV namespace — paste the id into wrangler.jsonc.
wrangler kv namespace create PRICE_CACHE
```

Update both `database_id` and KV `id` in `wrangler.jsonc` (look for `REPLACE_ME_AFTER_...`).

### 4. Apply migrations

```bash
# Local dev (uses miniflare's local SQLite)
npm run db:migrate:local

# Optionally seed sample data:
npm run db:seed:local

# When ready for production:
npm run db:migrate:remote
```

### 5. Set free API keys

Get them here (all free, no card required):

- **Finnhub** (stocks / ETFs, real-time US): https://finnhub.io/
- **CoinGecko Demo** (crypto): https://www.coingecko.com/en/api/pricing
- **Alpha Vantage** (fallback): https://www.alphavantage.co/support/#api-key

For local dev, copy `.dev.vars.example` to `.dev.vars` and paste in the keys.

For production:

```bash
wrangler secret put FINNHUB_API_KEY
wrangler secret put COINGECKO_DEMO_API_KEY
wrangler secret put ALPHAVANTAGE_API_KEY
```

### 6. Run locally

```bash
npm run dev
```

Open http://localhost:5173 (Vite dev server). The Worker runs in-process via the Cloudflare Vite plugin, so API calls to `/api/*` Just Work.

### 7. Deploy to Cloudflare

```bash
npm run deploy
```

You'll get a `https://personal-wealth-management.<your-subdomain>.workers.dev` URL.

### 8. Gate it with Cloudflare Access

In the Cloudflare dashboard:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Application domain: your `*.workers.dev` URL
3. Add a policy: **Allow** → emails matching `yzhou0528@gmail.com`
4. Identity provider: Email OTP (default) or add Google SSO

Free tier covers up to 50 users — you'll never hit the cap.

---

## Project layout

```
src/
  client/                  # React SPA
    components/
    lib/
    pages/
    App.tsx
    main.tsx
    index.css
  worker/                  # Hono backend on Workers
    adapters/              # Market-data adapters (Finnhub, CoinGecko, AV)
    db/                    # D1 query helpers
    jobs/                  # Cron jobs (nightly NAV snapshot)
    lib/                   # Position computation
    routes/                # /api/* route modules
    index.ts               # Worker entry
    types.ts               # Env bindings
  shared/
    schemas.ts             # Zod schemas + types shared by both sides
migrations/                # D1 SQL migrations
wrangler.jsonc             # Cloudflare config (bindings, cron, assets)
vite.config.ts             # Vite + @cloudflare/vite-plugin
```

---

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET/POST/PATCH/DELETE | `/api/accounts[/:id]` | Account CRUD |
| GET/POST/GET | `/api/assets`, `/api/assets/search?q=`, `/api/assets/:id` | Asset CRUD + search |
| GET/POST/PATCH/DELETE | `/api/transactions[/:id]` | Transaction CRUD with filters |
| GET | `/api/market/quote?symbol=X&class=stock\|etf\|crypto` | Single-symbol quote (cached 60s) |
| POST | `/api/market/refresh` | Re-fetch quotes for everything held |
| GET | `/api/portfolio/positions` | Open positions with cost basis + valuation |
| GET | `/api/portfolio/net-worth` | Total NAV + breakdown by class |
| GET | `/api/portfolio/nav-history?range=1M\|3M\|1Y\|ALL` | Time series for the chart |

---

## Transaction types supported

All position-affecting and cash-only operations are first-class: `buy`, `sell`, `deposit`, `withdrawal`, `transfer_in`, `transfer_out`, `dividend`, `interest`, `fee`, `tax`, `split`, `option_exercise`, `option_assignment`, `option_expiry`, `staking_reward`, `airdrop`, `gift_in`, `gift_out`, `adjustment`. The Add Transaction modal adapts its fields based on the type you pick.

---

## What's deliberately not here yet (Phase 5 backlog)

- CSV import/export
- Asset detail page with historical chart
- FIFO / specific-lot cost basis (v1 uses weighted-average)
- Tests (Vitest + Playwright)
- Multi-currency consolidated reporting (v1 displays whatever currency each account uses, total summed in USD assuming non-USD positions stored with `fx_rate`)
- Live option pricing (free tier coverage is poor — see `PLAN.md` §8)

---

## Daily cost

$0 on Cloudflare's free tiers and the free market-data API plans. See `PLAN.md` §9 for the breakdown.
