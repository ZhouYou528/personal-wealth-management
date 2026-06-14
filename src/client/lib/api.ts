import type {
  Account, Transaction, Holding, WatchlistItem, Goal,
  CalendarEvent, NavSnapshot, Quote, TickerSearchResult,
} from '@shared/types'
import { useStore } from './store'

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiSecret, setApiSecret } = useStore.getState()
  const authHeaders: Record<string, string> = apiSecret
    ? { Authorization: `Bearer ${apiSecret}` }
    : {}

  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...init?.headers },
    ...init,
  })

  if (res.status === 401) {
    setApiSecret(null)
    throw new Error('Access key expired or invalid. Please re-enter your access key.')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: unknown; message?: string }
    let msg: string
    if (typeof err.error === 'string') {
      msg = err.error
    } else if (err.error && typeof err.error === 'object' && 'issues' in err.error) {
      // Zod validation error from hono/zod-validator
      const issues = (err.error as { issues: { path: string[]; message: string }[] }).issues
      msg = issues.map(i => `${i.path.join('.') || 'field'}: ${i.message}`).join(', ')
    } else {
      msg = res.statusText || 'Request failed'
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

// ── Accounts ────────────────────────────────────────────────

export const accounts = {
  list: ()                                              => request<Account[]>('/accounts'),
  get:  (id: string)                                    => request<Account>(`/accounts/${id}`),
  create: (body: Omit<Account, 'id' | 'created_at'>)   => request<Account>('/accounts', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Account>)          => request<Account>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string)                                  => request<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),
  reorder: (ids: string[])                              => request<{ ok: boolean }>('/accounts/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
}

// ── Transactions ─────────────────────────────────────────────

export interface TxListParams { accountId?: string; symbol?: string; limit?: number; offset?: number; days?: number }

export const transactions = {
  list:   (params: TxListParams = {}) => {
    const qs = new URLSearchParams()
    if (params.accountId) qs.set('accountId', params.accountId)
    if (params.symbol)    qs.set('symbol', params.symbol)
    if (params.limit)     qs.set('limit', String(params.limit))
    if (params.offset)    qs.set('offset', String(params.offset))
    if (params.days)      qs.set('days', String(params.days))
    return request<Transaction[]>(`/transactions?${qs}`)
  },
  get:    (id: string)                                        => request<Transaction>(`/transactions/${id}`),
  create: (body: Omit<Transaction, 'id' | 'created_at'>)     => request<Transaction>('/transactions', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Transaction>)            => request<Transaction>(`/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string)                                        => request<{ ok: boolean }>(`/transactions/${id}`, { method: 'DELETE' }),
  updateBySymbol: (symbol: string, body: { kind?: 'stock'|'etf'|'mutual_fund'|'option'|'crypto'|'cash'; accountId?: string }) =>
    request<{ ok: boolean; changed: number }>(`/transactions/by-symbol/${encodeURIComponent(symbol)}`,
      { method: 'PATCH', body: JSON.stringify(body) }),
}

// ── Holdings ────────────────────────────────────────────────

export const quotes = {
  get: (symbol: string) => request<{ price: number; change?: number; changePct?: number }>(`/holdings/quote/${encodeURIComponent(symbol)}`),
}

export const holdings = {
  list: (accountId?: string, prices = true) => {
    const qs = new URLSearchParams({ prices: String(prices) })
    if (accountId) qs.set('accountId', accountId)
    return request<Holding[]>(`/holdings?${qs}`)
  },
  setMark: (id: string, price: number) =>
    request<{ ok: boolean }>('/holdings/marks',
      { method: 'PUT', body: JSON.stringify({ id, price }) }),
  clearMark: (id: string) =>
    request<{ ok: boolean }>(`/holdings/marks/${encodeURIComponent(id)}`,
      { method: 'DELETE' }),
}

// ── Watchlist ────────────────────────────────────────────────

export const watchlist = {
  list:   ()                                                  => request<WatchlistItem[]>('/watchlist'),
  add:    (body: Omit<WatchlistItem, 'id' | 'added_at'>)     => request<WatchlistItem>('/watchlist', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string)                                        => request<{ ok: boolean }>(`/watchlist/${id}`, { method: 'DELETE' }),
}

// ── Goals ────────────────────────────────────────────────────

export const goals = {
  list:   ()                                              => request<Goal[]>('/goals'),
  create: (body: Omit<Goal, 'id' | 'created_at'>)        => request<Goal>('/goals', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Goal>)               => request<Goal>(`/goals/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string)                                    => request<{ ok: boolean }>(`/goals/${id}`, { method: 'DELETE' }),
}

// ── Market data ──────────────────────────────────────────────

export const market = {
  quotes: (symbols: string[]) =>
    request<{ quotes: Record<string, Quote> }>(`/market/quotes?symbols=${symbols.join(',')}`),
  search: (q: string) =>
    request<{ results: TickerSearchResult[] }>(`/market/search?q=${encodeURIComponent(q)}`),
}

// ── Events ───────────────────────────────────────────────────

export const events = {
  upcoming: () => request<CalendarEvent[]>('/events'),
}

// ── Recurring rules ─────────────────────────────────────────

import type { RecurringRule } from '@shared/types'
type DecoratedRule = RecurringRule & { next_due: string | null }

export const recurring = {
  list:   ()                                                 => request<DecoratedRule[]>('/recurring'),
  create: (body: Omit<RecurringRule, 'id' | 'created_at' | 'active' | 'last_fired'> & { active?: number }) =>
    request<{ ok: boolean; id: string }>('/recurring', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<RecurringRule>) =>
    request<{ ok: boolean }>(`/recurring/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/recurring/${id}`, { method: 'DELETE' }),
  runOne: (id: string) =>
    request<{ ok: boolean; fired: string[] }>(`/recurring/${id}/run`, { method: 'POST' }),
  runAll: () =>
    request<{ ok: boolean; result: { rule_id: string; fired: string[] }[] }>(`/recurring/run-all`, { method: 'POST' }),
}

// ── Allocation plans ────────────────────────────────────────

import type { AllocationPlan } from '@shared/types'

export const allocation = {
  list:   ()                                                                  => request<AllocationPlan[]>('/allocation'),
  create: (body: Omit<AllocationPlan, 'id' | 'created_at' | 'active'> & { active?: number }) =>
    request<{ ok: boolean; id: string }>('/allocation', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<AllocationPlan>) =>
    request<{ ok: boolean }>(`/allocation/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/allocation/${id}`, { method: 'DELETE' }),
}

// ── FX ───────────────────────────────────────────────────────

export interface FxResponse { base: string; date: string; rates: Record<string, number>; stale?: boolean }

export const fx = {
  rates: (base = 'USD') => request<FxResponse>(`/fx?base=${encodeURIComponent(base)}`),
}

// ── Credit Cards ─────────────────────────────────────────────

import type { CreditCard } from '@shared/types'

export const creditCards = {
  list:   ()                                               => request<CreditCard[]>('/credit-cards'),
  create: (body: Omit<CreditCard, 'id' | 'created_at'>)   => request<{ ok: boolean; id: string }>('/credit-cards', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<CreditCard>)          => request<{ ok: boolean }>(`/credit-cards/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string)                                     => request<{ ok: boolean }>(`/credit-cards/${id}`, { method: 'DELETE' }),
}

// ── SnapTrade ────────────────────────────────────────────────

export interface SnapBrokerage {
  id: string
  name: string
  display_name: string
  slug: string
  url: string
  aws_s3_logo_url: string | null
  description: string | null
  enabled: boolean
  maintenance_mode: boolean
}

export interface SnapBrokerAccount {
  id: string
  name: string
  institution: string
  number: string
  type: string
  linkedTo: { id: string; name: string; snaptrade_account_id: string } | null
}

export interface ImportAccountItem {
  snapAccountId: string
  action: 'create' | 'skip'
  name?: string
  institution?: string
  accountType?: string
}

export const snaptrade = {
  status: () =>
    request<{ registered: boolean; linkedAccounts: number }>('/snaptrade/status'),

  register: () =>
    request<{ ok: boolean; already?: boolean }>('/snaptrade/register', { method: 'POST' }),

  brokerages: () =>
    request<SnapBrokerage[]>('/snaptrade/brokerages'),

  getConnectUrl: (body: { broker?: string; redirectUri?: string }) =>
    request<{ url: string }>('/snaptrade/connect', { method: 'POST', body: JSON.stringify(body) }),

  brokerAccounts: () =>
    request<SnapBrokerAccount[]>('/snaptrade/broker-accounts'),

  importAccounts: (accounts: ImportAccountItem[]) =>
    request<{ ok: boolean; results: { snapAccountId: string; d1AccountId: string; action: string }[] }>(
      '/snaptrade/import-accounts',
      { method: 'POST', body: JSON.stringify({ accounts }) },
    ),

  // Unified sync: refreshes positions + balances + recent activities for one
  // SnapTrade-linked account. Subject to a 60s per-account debounce.
  // Returns `rateLimited: true` + `retryAfter` instead of throwing on 429.
  syncAccount: async (accountId: string): Promise<
    | { rateLimited: true; retryAfter: number }
    | { rateLimited: false; activities_inserted: number; positions_upserted: number;
        positions_culled: number; balances_upserted: number; errors: string[] }
  > => {
    const { apiSecret } = useStore.getState()
    const res = await fetch(`${BASE}/snaptrade/sync/${accountId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiSecret && { Authorization: `Bearer ${apiSecret}` }),
      },
    })
    const body = await res.json() as { retry_after?: number; error?: string } & Record<string, unknown>
    if (res.status === 429) return { rateLimited: true, retryAfter: body.retry_after ?? 60 }
    if (!res.ok) throw new Error(body.error ?? 'Sync failed')
    return { rateLimited: false, ...(body as Omit<{ activities_inserted: number; positions_upserted: number;
        positions_culled: number; balances_upserted: number; errors: string[] }, never>) }
  },
}

// ── IBKR Flex Web Service ────────────────────────────────────
// Single endpoint that pulls BOTH IBKR accounts in one call.
export const ibkrFlex = {
  sync: async (): Promise<
    | { rateLimited: true; retryAfter: number }
    | { rateLimited: false; trades_inserted: number; cash_inserted: number;
        positions_upserted: number; positions_culled: number;
        balances_upserted: number;
        accounts_synced: string[]; errors: string[] }
  > => {
    const { apiSecret } = useStore.getState()
    const res = await fetch(`${BASE}/ibkr-flex/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiSecret && { Authorization: `Bearer ${apiSecret}` }),
      },
    })
    const body = await res.json() as { retry_after?: number; error?: string } & Record<string, unknown>
    if (res.status === 429) return { rateLimited: true, retryAfter: body.retry_after ?? 60 }
    if (!res.ok) throw new Error(body.error ?? 'IBKR Flex sync failed')
    return { rateLimited: false, ...(body as Omit<{ trades_inserted: number; cash_inserted: number;
        positions_upserted: number; positions_culled: number;
        balances_upserted: number;
        accounts_synced: string[]; errors: string[] }, never>) }
  },
}

// ── Market sentiment ─────────────────────────────────────────

export interface Sentiment {
  vix:       { value: number; change: number; label: string } | null
  fearGreed: { value: number; change: number; label: string } | null
  fetchedAt: string
}

export const sentiment = {
  get: () => request<Sentiment>('/sentiment'),
}

// ── Admin ────────────────────────────────────────────────────

export const admin = {
  runSnapshot: () => request<{ ok: boolean }>('/admin/run-snapshot', { method: 'POST' }),
}

// ── NAV ──────────────────────────────────────────────────────

export const nav = {
  history: (days = 365, accountId?: string) => {
    const qs = new URLSearchParams({ days: String(days) })
    if (accountId) qs.set('accountId', accountId)
    return request<NavSnapshot[]>(`/nav?${qs}`)
  },
  backfill: (accountId?: string) =>
    request<{ ok: boolean; dates: number }>('/nav/backfill', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
  backfillLive: (days = 365) =>
    request<{ ok: boolean; dates: number; message?: string }>('/nav/backfill-live', {
      method: 'POST',
      body: JSON.stringify({ days }),
    }),
}
