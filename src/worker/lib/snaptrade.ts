const BASE = 'https://api.snaptrade.com/api/v1'

function sortedJSON(val: unknown): string {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return JSON.stringify(val)
  const obj = val as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return JSON.stringify(sorted)
}

async function buildSignature(consumerKey: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(consumerKey.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  const bytes = new Uint8Array(sig)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function snapFetch<T>(
  path: string,
  clientId: string,
  consumerKey: string,
  opts: {
    method?: string
    body?: unknown
    userAuth?: { userId: string; userSecret: string }
    extraQs?: Record<string, string>
  } = {},
): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000)

  const qs = new URLSearchParams({ clientId: clientId.trim(), timestamp: String(timestamp) })
  if (opts.userAuth) {
    qs.set('userId', opts.userAuth.userId)
    qs.set('userSecret', opts.userAuth.userSecret)
  }
  if (opts.extraQs) {
    for (const [k, v] of Object.entries(opts.extraQs)) qs.set(k, v)
  }

  // Signature message = sorted JSON of { content, path, query }
  // content is null (not {}) when there is no request body (GET requests)
  const sigObj = {
    content: opts.body ?? null,
    path: `/api/v1${path}`,
    query: qs.toString(),
  }
  // Keys must be sorted alphabetically: content < path < query ✓
  const sigMessage = sortedJSON(sigObj)
  const signature = await buildSignature(consumerKey.trim(), sigMessage)

  const res = await fetch(`${BASE}${path}?${qs}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Signature': signature,
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`SnapTrade ${res.status} ${path}: ${JSON.stringify(err)}`)
  }

  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// ── Types ──────────────────────────────────────────────────────

export interface SnapUser { userId: string; userSecret: string }

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

export interface SnapBrokerageAccount {
  id: string
  name: string
  institution_name: string
  brokerage_authorization?: { id: string; brokerage?: { name: string; slug: string } }
  meta?: { account_number?: string; type?: string; institution?: string }
}

// Nested BrokerageSymbol used by positions endpoints
export interface SnapSymbol {
  id: string
  symbol: { symbol: string; description: string; type?: { name?: string } }
}

// Flat UniversalSymbol used by activity endpoints
export interface SnapUniversalSymbol {
  id: string
  symbol: string
  description: string
  type?: { code?: string; description?: string }
}

export interface SnapOptionSymbol {
  id: string
  ticker: string
  option_type: string          // "CALL" | "PUT"
  strike_price: number
  expiration_date: string      // "YYYY-MM-DD"
  is_mini_option?: boolean
  underlying_symbol?: { id: string; symbol: string; description?: string }
}

export interface SnapPosition {
  symbol?: SnapSymbol | null
  option_symbol?: SnapOptionSymbol | null
  units: number
  fractional_units?: number
  average_purchase_price: number
  open_pnl?: number
}

// Unified positions response — GET /accounts/{id}/positions/all
// instrument.kind values: stock | etf | option | crypto | mutualfund | cef | adr | future | other
export interface SnapUnifiedPosition {
  instrument: {
    kind: string
    // For stock/etf/crypto/mutualfund/cef/adr:
    id?: string
    symbol?: string          // ticker, e.g. "AAPL"
    raw_symbol?: string
    description?: string
    currency?: string | { code: string }
    // For option:
    option_type?: string     // "CALL" | "PUT"
    strike_price?: number | string
    expiration_date?: string // "YYYY-MM-DD"
    underlying?: { kind?: string; id?: string; symbol?: string; description?: string }
    multiplier?: number
    is_mini_option?: boolean
  }
  units: number | string
  price?: number | string
  cost_basis?: number | string
  currency?: string
  cash_equivalent?: boolean
}

interface SnapAllPositionsResponse {
  results: SnapUnifiedPosition[]
}

export interface SnapBalance {
  currency: { id: string; code: string }
  cash: number
}

export interface SnapHolding {
  account: SnapBrokerageAccount
  balances: SnapBalance[]
  positions: SnapPosition[]
}

export interface SnapActivity {
  id: string
  account: { id: string }
  trade_date: string | null
  settlement_date: string | null
  symbol?: SnapUniversalSymbol | null
  option_symbol?: SnapOptionSymbol | null
  price: number
  units: number
  amount: number
  currency: string
  type: string
  description: string
  institution: string
  fee: number
}

interface SnapActivitiesResponse {
  data: SnapActivity[]
  pagination: { offset: number; limit: number; total: number }
}

// ── Client ─────────────────────────────────────────────────────

export function createSnapClient(clientId: string, consumerKey: string) {
  const call = <T>(
    path: string,
    opts: Parameters<typeof snapFetch>[3] = {}
  ) => snapFetch<T>(path, clientId, consumerKey, opts)

  return {
    registerUser: (userId: string) =>
      call<SnapUser>('/snapTrade/registerUser', { method: 'POST', body: { userId } }),

    deleteUser: (userAuth: SnapUser) =>
      call<{ status: string }>('/snapTrade/deleteUser', { method: 'DELETE', userAuth }),

    getLoginUrl: (userAuth: SnapUser, opts: { broker?: string; redirectUri?: string } = {}) =>
      call<{ redirectURI: string }>('/snapTrade/login', {
        method: 'POST',
        body: {
          ...(opts.broker && { broker: opts.broker }),
          ...(opts.redirectUri && { redirectURI: opts.redirectUri }),
        },
        userAuth,
      }),

    listBrokerages: () =>
      call<SnapBrokerage[]>('/brokerages'),

    listAccounts: (userAuth: SnapUser) =>
      call<SnapBrokerageAccount[]>('/accounts', { userAuth }),

    getHoldings: (userAuth: SnapUser) =>
      call<SnapHolding[]>('/holdings', { userAuth }),

    getAccountPositions: (userAuth: SnapUser, snapAccountId: string) =>
      call<SnapPosition[]>(`/accounts/${snapAccountId}/positions`, { userAuth }),

    getAccountAllPositions: async (userAuth: SnapUser, snapAccountId: string) => {
      const res = await call<SnapAllPositionsResponse | null>(`/accounts/${snapAccountId}/positions/all`, { userAuth })
      return res?.results ?? []
    },

    getAccountBalances: async (userAuth: SnapUser, snapAccountId: string) => {
      const res = await call<SnapBalance[] | null>(`/accounts/${snapAccountId}/balances`, { userAuth })
      return res ?? []
    },

    getActivities: (userAuth: SnapUser, startDate?: string, endDate?: string, accounts?: string) =>
      call<SnapActivity[]>('/activities', {
        userAuth,
        extraQs: {
          ...(startDate && { startDate }),
          ...(endDate && { endDate }),
          ...(accounts && { accounts }),
        },
      }),

    getAccountActivities: async (userAuth: SnapUser, snapAccountId: string, startDate?: string, endDate?: string) => {
      const res = await call<SnapActivitiesResponse | SnapActivity[]>(`/accounts/${snapAccountId}/activities`, {
        userAuth,
        extraQs: {
          ...(startDate && { startDate }),
          ...(endDate && { endDate }),
        },
      })
      // API returns paginated object { data, pagination } or bare array depending on version
      return Array.isArray(res) ? res : (res as SnapActivitiesResponse).data ?? []
    },
  }
}
