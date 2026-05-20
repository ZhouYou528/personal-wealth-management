import type {
  Account, Transaction, Holding, WatchlistItem, Goal,
  CalendarEvent, NavSnapshot, Quote, TickerSearchResult,
} from '@shared/types'

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
    throw new Error(err.error ?? res.statusText)
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
}

// ── Transactions ─────────────────────────────────────────────

export interface TxListParams { accountId?: string; symbol?: string; limit?: number; offset?: number }

export const transactions = {
  list:   (params: TxListParams = {}) => {
    const qs = new URLSearchParams()
    if (params.accountId) qs.set('accountId', params.accountId)
    if (params.symbol)    qs.set('symbol', params.symbol)
    if (params.limit)     qs.set('limit', String(params.limit))
    if (params.offset)    qs.set('offset', String(params.offset))
    return request<Transaction[]>(`/transactions?${qs}`)
  },
  get:    (id: string)                                        => request<Transaction>(`/transactions/${id}`),
  create: (body: Omit<Transaction, 'id' | 'created_at'>)     => request<Transaction>('/transactions', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Transaction>)            => request<Transaction>(`/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string)                                        => request<{ ok: boolean }>(`/transactions/${id}`, { method: 'DELETE' }),
}

// ── Holdings ────────────────────────────────────────────────

export const holdings = {
  list: (accountId?: string, prices = true) => {
    const qs = new URLSearchParams({ prices: String(prices) })
    if (accountId) qs.set('accountId', accountId)
    return request<Holding[]>(`/holdings?${qs}`)
  },
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

// ── NAV ──────────────────────────────────────────────────────

export const nav = {
  history: (days = 365, accountId?: string) => {
    const qs = new URLSearchParams({ days: String(days) })
    if (accountId) qs.set('accountId', accountId)
    return request<NavSnapshot[]>(`/nav?${qs}`)
  },
}
