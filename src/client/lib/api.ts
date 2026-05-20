// Thin typed fetch wrapper for our Hono backend.
//
// In dev, Vite proxies /api/* to the Worker. In prod, the same Worker serves both.

import type {
  Account,
  AccountCreate,
  Asset,
  AssetCreate,
  Transaction,
  TransactionCreate,
  Position,
} from "@shared/schemas";

async function http<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => http<{ ok: true; ts: string }>("GET", "/health"),

  // accounts
  listAccounts: () => http<Account[]>("GET", "/accounts"),
  createAccount: (data: AccountCreate) =>
    http<Account>("POST", "/accounts", data),
  updateAccount: (id: number, data: Partial<AccountCreate>) =>
    http<Account>("PATCH", `/accounts/${id}`, data),
  deleteAccount: (id: number) => http<void>("DELETE", `/accounts/${id}`),

  // assets
  listAssets: () => http<Asset[]>("GET", "/assets"),
  searchAssets: (q: string) =>
    http<Asset[]>("GET", `/assets/search?q=${encodeURIComponent(q)}`),
  createAsset: (data: AssetCreate) => http<Asset>("POST", "/assets", data),

  // transactions
  listTransactions: (params?: {
    account_id?: number;
    asset_id?: number;
    type?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "")
          q.set(k, String(v));
      }
    }
    const qs = q.toString();
    return http<Transaction[]>("GET", `/transactions${qs ? `?${qs}` : ""}`);
  },
  createTransaction: (data: TransactionCreate) =>
    http<Transaction>("POST", "/transactions", data),
  updateTransaction: (id: number, data: Partial<TransactionCreate>) =>
    http<Transaction>("PATCH", `/transactions/${id}`, data),
  deleteTransaction: (id: number) =>
    http<void>("DELETE", `/transactions/${id}`),

  // market data + positions
  getQuote: (symbol: string, assetClass: string) =>
    http<{ price: number; as_of: string; source: string }>(
      "GET",
      `/market/quote?symbol=${encodeURIComponent(symbol)}&class=${encodeURIComponent(assetClass)}`,
    ),
  getPositions: () => http<Position[]>("GET", "/portfolio/positions"),
  getNetWorth: () =>
    http<{
      total: number;
      by_class: Record<string, number>;
      as_of: string;
      stale_assets: { symbol: string; reason: string }[];
    }>("GET", "/portfolio/net-worth"),
  getNavHistory: (range: "1M" | "3M" | "1Y" | "ALL" = "3M") =>
    http<{ date: string; total: number }[]>(
      "GET",
      `/portfolio/nav-history?range=${range}`,
    ),
  refreshPrices: () =>
    http<{ refreshed: number; failed: number }>("POST", "/market/refresh"),
};
