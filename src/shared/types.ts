// Domain types shared between the Cloudflare Worker (API) and the React client.

export type AccountType =
  | 'Brokerage' | 'Roth IRA' | 'Traditional IRA' | '401k' | 'HSA'
  | 'RRSP' | 'TFSA' | 'FHSA' | 'RESP'
  | 'Crypto'

export interface Account {
  id: string
  name: string
  type: AccountType
  institution: string
  color: string
  number: string
  snaptrade_account_id?: string | null
  last_synced_at?: string | null
  created_at: string
}

export type TxType =
  | 'buy' | 'sell'
  | 'buy_option' | 'sell_option'
  | 'buy_crypto' | 'sell_crypto'
  | 'deposit' | 'withdraw'
  | 'transfer'
  | 'transfer_in' | 'transfer_out'
  | 'dividend' | 'interest'
  | 'recurring'
  | 'split'

export type AssetKind = 'stock' | 'etf' | 'mutual_fund' | 'option' | 'crypto' | 'cash'

export interface Transaction {
  id: string
  tx_date: string
  account_id: string
  type: TxType
  symbol?: string
  kind?: AssetKind
  qty?: number
  price?: number
  total: number
  note?: string
  to_account?: string
  from_account?: string
  option_type?: 'call' | 'put'
  strike?: number
  expiry?: string
  underlying?: string
  created_at: string
}

export interface Holding {
  id: string          // `${accountId}:${symbol}`
  account_id: string
  symbol: string
  name: string
  kind: AssetKind
  qty: number
  cost: number        // weighted-average cost per unit
  px: number          // last market price (from cache or fallback = cost)
  change?: number     // today's absolute price change (live quote only)
  changePct?: number  // today's % change (live quote only)
  marked?: boolean    // true when px comes from a user-set mark (not a live quote)
  option_type?: 'call' | 'put'
  strike?: number
  expiry?: string
  underlying?: string
  multiplier?: number
}

export interface WatchlistItem {
  id: string
  symbol: string
  name: string
  kind: AssetKind
  added_at: string
}

export interface Goal {
  id: string
  name: string
  target: number
  current: number              // fallback when account_ids is empty
  deadline: string
  color: string
  icon: string
  account_ids?: string[]       // accounts whose combined value auto-fills `current`
  created_at: string
}

export type AllocationTargets = Partial<Record<AssetKind, number>>

export interface AllocationPlan {
  id: string
  name: string
  scope_account_ids?: string[]    // null/empty = all accounts
  targets: AllocationTargets      // % per kind, should sum to 100
  drift_threshold: number         // absolute drift % at which to flag rebalance
  active: number
  created_at: string
}

export type RecurringFrequency = 'biweekly' | 'monthly' | 'quarterly'

export interface RecurringRule {
  id: string
  account_id: string
  tx_type: TxType
  symbol?: string
  kind?: AssetKind
  qty?: number
  price?: number
  total: number
  frequency: RecurringFrequency
  start_date: string          // YYYY-MM-DD, when the first fire should land
  end_date?: string           // optional stop date
  last_fired?: string         // date most recently materialized
  active: number              // 0/1 (SQLite boolean)
  note?: string
  created_at: string
}

export interface CalendarEvent {
  id: string
  event_date: string
  symbol: string
  kind: 'dividend' | 'earnings' | 'expiry'
  amount?: number
  note?: string
}

export type NavSnapshotSource = 'cost' | 'market'

export interface NavSnapshot {
  snap_date: string     // YYYY-MM-DD for daily; YYYY-MM-DDTHH:MM for intraday today
  snap_hour?: number    // 0-23; only used when writing
  account_id?: string
  value: number
  source?: NavSnapshotSource
}

// Quote returned by /api/market/quotes
export interface Quote {
  symbol: string
  price: number
  change: number      // absolute change from prev close
  changePct: number   // % change from prev close
  high: number
  low: number
  open: number
  prevClose: number
  timestamp: number
}

export interface TickerSearchResult {
  symbol: string
  name: string
  kind: AssetKind
}

// API response shapes
export interface ApiError {
  error: string
}

// ── Credit card tracking ──────────────────────────────────────

export type CreditCardMarket   = 'US' | 'CA'
export type CreditCardStatus   = 'active' | 'cancelled'
export type CreditCardCurrency = 'MR' | 'UR' | 'C1' | 'TYP' | 'Aeroplan' | 'Avion' | 'ScenePlus' | 'Bonvoy' | 'Cash'
export type CreditCardNetwork  = 'Visa' | 'Mastercard' | 'Amex'
export type CreditCardBureau   = 'Experian' | 'Equifax' | 'TransUnion'

export interface CreditCard {
  id:                 string
  name:               string
  issuer:             string
  network:            CreditCardNetwork
  market:             CreditCardMarket
  status:             CreditCardStatus
  open_date:          string
  cancel_date:        string | null
  annual_fee:         number
  first_year_free:    number   // 0 | 1
  bureau:             CreditCardBureau
  hard_pull:          number   // 0 | 1
  bonus:              number   // points
  currency:           CreditCardCurrency
  bonus_met:          number   // 0 | 1
  bonus_met_date:     string | null
  min_spend_req:      number
  min_spend_deadline: string | null
  min_spend_current:  number
  points_balance:     number
  note:               string | null
  c1:                 string
  c2:                 string
  created_at:         string
}
